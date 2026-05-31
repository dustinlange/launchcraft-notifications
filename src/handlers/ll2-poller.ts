import { Env } from '../index'
import { getLaunch, upsertLaunch, upsertTimelineEvents, recalculateTimelineFireAt, getSubscriptionsForLaunch, markSuccessAt, getSubscribedLaunchIds, getLaunchesNearT0, fanOutProviderSubscriptions, fanOutLocationSubscriptions, fanOutAllUpcomingSubscriptions, backfillAttributesJson, resetReminderFlags, TERMINAL_IDS, LL2_STATUS } from '../db/queries'
import { createLL2Client, mapT0, parseRelativeTime } from '../ll2'
import { pushAlertNotification } from '../apns'
import { pushLiveActivityUpdateAndClearOnFailure } from '../liveActivityPush'
import { getApnsConfig } from './webhook'

export async function pollLL2(env: Env) {
  const client = createLL2Client(env.LL2_API_KEY)
  const launches = await client.getUpcomingLaunches(50)
  await Promise.allSettled(launches.map(ll2 => syncLaunch(env, ll2)))

  const coveredIds = new Set(launches.map(l => l.id))
  const { results: subscribed } = await getSubscribedLaunchIds(env.DB)
  const missed = subscribed.filter(r => !coveredIds.has(r.launch_id))
  await Promise.allSettled(missed.map(r => syncLaunchById(env, r.launch_id)))
}

// Runs every minute. Re-syncs subscribed launches in two windows:
//
//  1. Pre-reminder window (T-0 within 15 minutes): catches late NET changes before the
//     10-minute reminder fires, ensuring reminder flags are reset if T-0 shifts.
//
//  2. Near-T-0 window (T-0 within 90s or up to 30s in the past): catches last-second
//     scrubs or holds before the timeline dispatcher fires the liftoff event.
//
// Both windows are unioned so a single set of LL2 fetches covers both cases.
export async function prefetchNearT0Launches(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  // Window 1: within next 15 minutes (covers 10m reminder + tolerance)
  const reminderWindow = await getLaunchesNearT0(env.DB, now, now + 15 * 60)
  // Window 2: ±90s of T-0 (covers liftoff accuracy)
  const liftoffWindow = await getLaunchesNearT0(env.DB, now - 30, now + 90)

  const ids = new Set([
    ...reminderWindow.results.map(r => r.id),
    ...liftoffWindow.results.map(r => r.id),
  ])
  if (ids.size === 0) return
  console.log(`prefetchNearT0: syncing ${ids.size} launch(es) (reminder or liftoff window)`)
  await Promise.allSettled([...ids].map(id => syncLaunchById(env, id)))
}

export async function syncLaunchById(env: Env, id: string) {
  try {
    const client = createLL2Client(env.LL2_API_KEY)
    const ll2 = await client.getLaunch(id)
    if (!ll2) { console.warn(`syncLaunchById: LL2 returned null for ${id}`); return }
    console.log(`syncLaunchById: ${id} timeline events=${ll2.timeline?.length ?? 0}`)
    await syncLaunch(env, ll2)
  } catch (err) {
    console.error(`syncLaunchById failed for ${id}:`, err)
  }
}

async function syncLaunch(env: Env, ll2: {
  id: string; name: string
  mission: { name: string } | null
  net: string | null; window_start: string | null; window_end: string | null
  status: { id: number; abbrev: string }
  image: { image_url: string } | null
  rocket: { configuration: { name: string; image: { image_url: string } | null } }
  pad: { name: string; location: { id: number; name: string } }
  launch_service_provider: { id: number; name: string; logo_url: string | null } | null
  timeline: Array<{ type: { abbrev: string }; relative_time: string }> | null
}) {
  const t0 = mapT0(ll2.net)
  const windowStart = mapT0(ll2.window_start)
  const windowEnd = mapT0(ll2.window_end)
  const ll2StatusId = ll2.status.id
  const timeline = ll2.timeline?.map(e => ({
    label: e.type.abbrev,
    t_offset_s: parseRelativeTime(e.relative_time),
  })) ?? []

  const prev = await getLaunch(env.DB, ll2.id)
  const hasTimeline = timeline.length > 0

  await upsertLaunch(env.DB, {
    id: ll2.id,
    name: ll2.name,
    mission_name: ll2.mission?.name ?? null,
    rocket: ll2.rocket.configuration.name,
    pad: `${ll2.pad.name}, ${ll2.pad.location.name}`,
    pad_location: ll2.pad.location.name,
    pad_location_id: ll2.pad.location.id,
    provider: ll2.launch_service_provider?.name ?? null,
    provider_id: ll2.launch_service_provider?.id ?? null,
    provider_logo_url: ll2.launch_service_provider?.logo_url ?? null,
    image_url: ll2.image?.image_url ?? null,
    rocket_image_url: ll2.rocket.configuration.image?.image_url ?? null,
    t0,
    window_start: windowStart,
    window_end: windowEnd,
    ll2_status_id: ll2StatusId,
    has_timeline: hasTimeline ? 1 : 0,
    success_at: null,
    end_dispatched: 0,
  })

  if (hasTimeline && t0) {
    await upsertTimelineEvents(env.DB, ll2.id, timeline, t0)
  } else if (!hasTimeline && t0 && prev && prev.t0 !== t0) {
    // T-0 shifted but LL2 returned no timeline — recompute fire_at from stored offsets
    await recalculateTimelineFireAt(env.DB, ll2.id, t0)
  }

  // Fan-out errors must not prevent markSuccessAt or alert pushes from running
  try {
    if (ll2.launch_service_provider?.id) {
      await fanOutProviderSubscriptions(env.DB, ll2.id, ll2.launch_service_provider.id)
    }
    await fanOutLocationSubscriptions(env.DB, ll2.id, ll2.pad.location.id)
    await fanOutAllUpcomingSubscriptions(env.DB, ll2.id)
  } catch (err) {
    console.error(`syncLaunch: fan-out error for ${ll2.id}:`, err)
  }

  // Backfill attributes_json for any fan-out subscriptions that don't have it yet
  await backfillAttributesJson(
    env.DB, ll2.id, ll2.name,
    ll2.mission?.name ?? null,
    ll2.rocket.configuration.name,
    ll2.launch_service_provider?.name ?? null,
    ll2.launch_service_provider?.logo_url ?? null,
    ll2StatusId,
  )

  // Always backfill success_at when terminal — guards against prior fan-out errors
  // that aborted before this line, or poller runs where the transition was missed.
  if (TERMINAL_IDS.includes(ll2StatusId as any)) {
    await markSuccessAt(env.DB, ll2.id, t0 ?? Math.floor(Date.now() / 1000))
  }

  if (!prev) return

  const statusChanged = prev.ll2_status_id !== ll2StatusId
  const t0Changed = prev.t0 !== t0
  const isTerminal = TERMINAL_IDS.includes(ll2StatusId as any)

  if (!statusChanged && !t0Changed) return

  if (t0Changed) {
    await resetReminderFlags(env.DB, ll2.id)
  }

  const apnsConfig = getApnsConfig(env)
  const { results: subs } = await getSubscriptionsForLaunch(env.DB, ll2.id)

  await Promise.allSettled(subs.map(async (sub) => {
    if (sub.activity_token) {
      await pushLiveActivityUpdateAndClearOnFailure(env.DB, env.KV, apnsConfig, sub.id, sub.activity_token, {
        event: isTerminal ? 'end' : 'update',
        contentState: {
          netDate: t0,
          windowStart,
          windowEnd,
          currentEventName: null,
          currentEventDate: null,
          nextEventName: null,
          nextEventDate: null,
          statusId: ll2StatusId,
        },
        alertTitle: statusChanged
          ? `${ll2.name}: ${statusLabel(ll2StatusId)}`
          : `${ll2.name}: Schedule Updated`,
        alertBody: t0Changed && t0 ? `New window: ${new Date(t0 * 1000).toUTCString()}` : undefined,
        dismissalDate: isTerminal ? Math.floor(Date.now() / 1000) + 60 * 30 : undefined,
      })
    }

    const wantsTerminal    = sub.notify_terminal_status !== 0  // NULL → default on
    const wantsStatusChange = sub.notify_status_change === 1   // NULL → default off
    const wantsNetChange    = sub.notify_net_change    === 1   // NULL → default off

    const launchImageUrl = sub.image_url ?? sub.rocket_image_url ?? undefined

    if (statusChanged && (isTerminal ? wantsTerminal : wantsStatusChange)) {
      await pushAlertNotification(env.KV, apnsConfig, sub.device_token, {
        title: 'Status Changed',
        body: isTerminal
          ? statusBody(ll2StatusId, ll2.name, ll2.rocket.configuration.name)
          : `${ll2.name} status has changed from ${statusLabel(prev.ll2_status_id)} to ${statusLabel(ll2StatusId)}`,
        launchId: ll2.id,
        type: 'status_change',
        imageUrl: launchImageUrl,
      })
    } else if (t0Changed && t0 && wantsNetChange) {
      await pushAlertNotification(env.KV, apnsConfig, sub.device_token, {
        title: 'Launch Rescheduled',
        body: new Date(t0 * 1000).toUTCString(),
        launchId: ll2.id,
        type: 'schedule_change',
        t0,
        launchName: ll2.name,
        imageUrl: launchImageUrl,
      })
    }
  }))
}

function statusLabel(id: number): string {
  const m: Record<number, string> = {
    [LL2_STATUS.GO]:              'Go for Launch',
    [LL2_STATUS.TBD]:             'TBD',
    [LL2_STATUS.TBC]:             'TBC',
    [LL2_STATUS.HOLD]:            'Launch Hold',
    [LL2_STATUS.IN_FLIGHT]:       'In Flight',
    [LL2_STATUS.SUCCESS]:         'Launch Successful',
    [LL2_STATUS.FAILURE]:         'Launch Failed',
    [LL2_STATUS.PARTIAL_FAILURE]: 'Partial Failure',
  }
  return m[id] ?? `Status ${id}`
}

function statusBody(id: number, name: string, rocket: string): string {
  const m: Record<number, string> = {
    [LL2_STATUS.TBD]:             `${rocket} launch date is to be determined.`,
    [LL2_STATUS.TBC]:             `${rocket} launch date is to be confirmed.`,
    [LL2_STATUS.HOLD]:            `${rocket} is currently on hold.`,
    [LL2_STATUS.SUCCESS]:         `${name} was successful!`,
    [LL2_STATUS.FAILURE]:         `${name} has failed!`,
    [LL2_STATUS.PARTIAL_FAILURE]: `${name} was a partial failure!`,
  }
  return m[id] ?? `Launch status changed.`
}
