import { Env } from '../index'
import { getLaunch, getLaunchesMap, upsertLaunch, recordNetChange, upsertTimelineEvents, recalculateTimelineFireAt, getSubscriptionsForLaunch, markSuccessAt, getSubscribedLaunchIds, getLaunchesNearT0Combined, fanOutProviderSubscriptions, fanOutLocationSubscriptions, fanOutAllUpcomingSubscriptions, backfillAttributesJson, resetReminderFlags, markWebcastNotified, logNotification, TERMINAL_IDS, CONFIRMED_GO_IDS, LL2_STATUS, Launch } from '../db/queries'
import { createLL2Client, mapT0, parseRelativeTime } from '../ll2'
import { pushAlertNotification } from '../apns'
import { pushLiveActivityUpdateAndClearOnFailure } from '../liveActivityPush'
import { getApnsConfig } from './webhook'

export async function pollLL2(env: Env) {
  const client = createLL2Client(env.LL2_API_KEY)
  const launches = await client.getUpcomingLaunches(50)

  // Bulk-fetch all existing DB records in one query instead of 50 individual getLaunch() calls
  const prevMap = await getLaunchesMap(env.DB, launches.map(l => l.id))

  // Process in batches of 10 to spread CPU across the event loop
  for (let i = 0; i < launches.length; i += 10) {
    await Promise.allSettled(
      launches.slice(i, i + 10).map(ll2 => syncLaunch(env, ll2, prevMap.get(ll2.id) ?? null))
    )
  }

  const coveredIds = new Set(launches.map(l => l.id))
  const { results: subscribed } = await getSubscribedLaunchIds(env.DB)
  const now = Math.floor(Date.now() / 1000)
  const thirtyDaysOut = now + 30 * 24 * 60 * 60
  const missed = subscribed.filter(r =>
    !coveredIds.has(r.launch_id) &&
    // Always sync explicitly subscribed launches (user tapped Subscribe in the app).
    // For fan-out-only subscriptions, skip far-future launches — they'll be picked up
    // naturally by the bulk poll as they enter the 30-day window.
    (r.has_direct_sub === 1 || r.t0 === null || r.t0 <= thirtyDaysOut)
  )
  await Promise.allSettled(missed.map(r => syncLaunchById(env, r.launch_id)))
}

// Runs every minute. Re-syncs subscribed launches in two windows:
//
//  1. Pre-reminder window (T-0 within 5 minutes): catches late NET changes before the
//     10-minute reminder fires. The 5–15 minute range is covered by the 5-minute pollLL2.
//
//  2. Near-T-0 window (T-0 within 90s or up to 30s in the past): catches last-second
//     scrubs or holds before the timeline dispatcher fires the liftoff event.
//
// Narrowing the reminder window from 15 min to 5 min saves ~10 LL2 calls per launch.
export async function prefetchNearT0Launches(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  // Single combined query covers both the 5-min reminder window and the ±90s liftoff window,
  // replacing the previous two separate getLaunchesNearT0 calls.
  const { results } = await getLaunchesNearT0Combined(env.DB, now)
  const ids = new Set(results.map(r => r.id))
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

// prevHint: pre-fetched DB record from bulk fetch in pollLL2. Passing it avoids a
// redundant getLaunch() round-trip. syncLaunchById still calls without prevHint.
async function syncLaunch(env: Env, ll2: {
  id: string; name: string
  mission: { name: string; is_crewed: boolean } | null
  mission_patches: Array<{ priority: number; image_url: string }> | null
  net: string | null; window_start: string | null; window_end: string | null
  status: { id: number; abbrev: string }
  image: { image_url: string } | null
  rocket: {
    configuration: { name: string; image: { image_url: string } | null }
    launcher_stage: Array<{
      landing: {
        success: boolean | null
        landing_location: { abbrev: string } | null
        type: { id: number } | null
      } | null
    }> | null
  }
  pad: { name: string; location: { id: number; name: string } }
  launch_service_provider: { id: number; name: string; logo_url: string | null; logo: { id: number; name: string; image_url: string } | null; social_logo: { id: number; name: string; image_url: string } | null } | null
  timeline: Array<{ type: { abbrev: string }; relative_time: string }> | null
  webcast_live: boolean | null
}, prevHint?: Launch | null) {
  const t0 = mapT0(ll2.net)
  const windowStart = mapT0(ll2.window_start)
  const windowEnd = mapT0(ll2.window_end)
  const ll2StatusId = ll2.status.id
  const timeline = ll2.timeline?.map(e => ({
    label: e.type.abbrev,
    t_offset_s: parseRelativeTime(e.relative_time),
  })) ?? []

  // Fields for attributes_json — must match LaunchActivityAttributes on iOS
  const lsp = ll2.launch_service_provider
  // LL2 v2.3.0: social_logo and logo are objects {id, name, image_url}, not plain strings.
  // logo_url is deprecated and usually null. Prefer social_logo, fall back to logo, then logo_url.
  const nationUrl = lsp?.social_logo?.image_url ?? lsp?.logo?.image_url ?? lsp?.logo_url ?? null
  const missionPatchUrl = ll2.mission_patches
    ?.slice().sort((a, b) => a.priority - b.priority)[0]?.image_url ?? null
  const firstLanding = ll2.rocket.launcher_stage?.[0]?.landing ?? null
  const landingLocation = firstLanding?.landing_location?.abbrev ?? null
  const landingTypeId = firstLanding?.type?.id ?? null
  const landingSuccess = firstLanding?.success ?? null

  // Use the pre-fetched record when available (bulk poll), otherwise fetch individually
  const prev = prevHint !== undefined ? prevHint : await getLaunch(env.DB, ll2.id)
  const hasTimeline = timeline.length > 0
  const statusChanged = prev ? prev.ll2_status_id !== ll2StatusId : false
  const t0Changed = prev ? prev.t0 !== t0 : false

  // Skip the upsert when core fields haven't changed — saves a D1 write and the JS overhead
  // of building the 19-parameter prepared statement for every unchanged launch every 5 min.
  const isCrewedNew = ll2.mission != null ? (ll2.mission.is_crewed ? 1 : 0) : null
  const webcastLiveNew = ll2.webcast_live ? 1 : 0
  const webcastJustWentLive = prev !== null && (prev.webcast_live ?? 0) === 0 && webcastLiveNew === 1
  const coreChanged = !prev
    || t0Changed
    || statusChanged
    || prev.has_timeline !== (hasTimeline ? 1 : 0)
    || prev.is_crewed !== isCrewedNew
    || prev.image_url !== (ll2.image?.image_url ?? null)
    || prev.mission_name !== (ll2.mission?.name ?? null)
    || prev.mission_patch_url !== missionPatchUrl
    || prev.landing_location !== landingLocation
    || prev.provider_social_logo_url !== (lsp?.social_logo?.image_url ?? lsp?.logo?.image_url ?? null)
    || (prev.webcast_live ?? 0) !== webcastLiveNew

  if (!coreChanged) {
    // Nothing meaningful changed — skip DB write and downstream work
    return
  }

  await upsertLaunch(env.DB, {
    id: ll2.id,
    name: ll2.name,
    mission_name: ll2.mission?.name ?? null,
    rocket: ll2.rocket.configuration.name,
    pad: `${ll2.pad.name}, ${ll2.pad.location.name}`,
    pad_location: ll2.pad.location.name,
    pad_location_id: ll2.pad.location.id,
    provider: lsp?.name ?? null,
    provider_id: lsp?.id ?? null,
    provider_logo_url: lsp?.logo_url ?? null,
    provider_social_logo_url: lsp?.social_logo?.image_url ?? lsp?.logo?.image_url ?? null,
    image_url: ll2.image?.image_url ?? null,
    rocket_image_url: ll2.rocket.configuration.image?.image_url ?? null,
    mission_patch_url: missionPatchUrl,
    landing_location: landingLocation,
    landing_type_id: landingTypeId,
    landing_success: landingSuccess,
    t0,
    window_start: windowStart,
    window_end: windowEnd,
    ll2_status_id: ll2StatusId,
    has_timeline: hasTimeline ? 1 : 0,
    is_crewed: isCrewedNew,
    webcast_live: webcastLiveNew,
    success_at: null,
    end_dispatched: 0,
  })

  if (t0Changed && prev?.t0 != null && t0 != null) {
    await recordNetChange(env.DB, ll2.id, prev.t0)
  }

  // Only upsert timeline events when something meaningful changed:
  //  - new launch (prev is null) — rows don't exist yet
  //  - T-0 shifted — fire_at values need recomputing
  //  - launch just gained a timeline — rows need to be created
  const timelineJustAppeared = hasTimeline && prev && !prev.has_timeline
  if (hasTimeline && t0 && (!prev || t0Changed || timelineJustAppeared)) {
    await upsertTimelineEvents(env.DB, ll2.id, timeline, t0)
  } else if (!hasTimeline && t0 && prev && t0Changed) {
    // T-0 shifted but LL2 returned no timeline — recompute fire_at from stored offsets
    await recalculateTimelineFireAt(env.DB, ll2.id, t0)
  }

  // Fan-out: run for new launches or when a launch just moved to a confirmed-go status.
  // Existing unchanged launches are skipped — new feed/provider/location subscriptions
  // get their own immediate fan-out at subscription-creation time (handleSubscribeToFeed,
  // handleSubscribeToProvider, handleSubscribeToLocation).
  const isNewLaunch = !prev
  const justBecameGo = statusChanged && (CONFIRMED_GO_IDS as number[]).includes(ll2StatusId)
  if (isNewLaunch || justBecameGo) {
    try {
      if (ll2.launch_service_provider?.id) {
        await fanOutProviderSubscriptions(env.DB, ll2.id, ll2.launch_service_provider.id)
      }
      await fanOutLocationSubscriptions(env.DB, ll2.id, ll2.pad.location.id)
      await fanOutAllUpcomingSubscriptions(env.DB, ll2.id)
    } catch (err) {
      console.error(`syncLaunch: fan-out error for ${ll2.id}:`, err)
    }
  }

  // Refresh attributes_json for all subscriptions to this launch so push-to-start
  // payloads stay consistent with what the iOS app would build directly.
  await backfillAttributesJson(
    env.DB, ll2.id, ll2.name,
    ll2.mission?.name ?? null,
    ll2.rocket.configuration.name,
    lsp?.name ?? null,
    nationUrl,
    ll2StatusId,
    missionPatchUrl,
    landingLocation,
    landingTypeId,
    landingSuccess,
    lsp?.id ?? null,
  )

  // Always backfill success_at when terminal — guards against prior fan-out errors
  // that aborted before this line, or poller runs where the transition was missed.
  if (TERMINAL_IDS.includes(ll2StatusId as any)) {
    await markSuccessAt(env.DB, ll2.id, t0 ?? Math.floor(Date.now() / 1000))
  }

  if (!prev) return

  const isTerminal = TERMINAL_IDS.includes(ll2StatusId as any)

  if (!statusChanged && !t0Changed && !webcastJustWentLive) return

  if (t0Changed) {
    await resetReminderFlags(env.DB, ll2.id)
  }

  const apnsConfig = getApnsConfig(env)
  const { results: subs } = await getSubscriptionsForLaunch(env.DB, ll2.id)

  await Promise.allSettled(subs.map(async (sub) => {
    if (sub.activity_token) {
      const activityResult = await pushLiveActivityUpdateAndClearOnFailure(env.DB, env.KV, apnsConfig, sub.id, sub.activity_token, {
        event: isTerminal ? 'end' : 'update',
        contentState: {
          netDate: t0,
          windowStart,
          windowEnd,
          currentEventName: null,
          currentEventDate: null,
          // Include the first upcoming timeline event so the live activity countdown
          // reflects the rescheduled time rather than going blank after a NET change.
          nextEventName: isTerminal ? null : (sub.first_event_name ?? null),
          nextEventDate: isTerminal ? null : (sub.first_event_fire_at ?? null),
          statusId: ll2StatusId,
          isWebcastLive: webcastLiveNew === 1,
          landingSuccess: landingSuccess,
        },
        alertTitle: statusChanged
          ? `${ll2.name}: ${statusLabel(ll2StatusId)}`
          : webcastJustWentLive
            ? 'Webcast is Live!'
            : `${ll2.name}: Schedule Updated`,
        alertBody: t0Changed && t0 ? `New window: ${new Date(t0 * 1000).toUTCString()}` : undefined,
        dismissalDate: isTerminal ? Math.floor(Date.now() / 1000) + 60 * 30 : undefined,
      })
      await logNotification(env.DB, isTerminal ? 'live_activity_end' : 'live_activity_update', sub.user_id, activityResult.ok)
    }

    const wantsTerminal    = sub.notify_terminal_status !== 0  // NULL → default on
    const wantsStatusChange = sub.notify_status_change === 1   // NULL → default off
    const wantsNetChange    = sub.notify_net_change    === 1   // NULL → default off
    const wantsWebcast      = sub.notify_webcast_live  !== 0   // NULL → default on

    const launchImageUrl = sub.image_url ?? sub.rocket_image_url ?? undefined

    if (webcastJustWentLive && wantsWebcast && !sub.webcast_notified) {
      const result = await pushAlertNotification(env.KV, apnsConfig, sub.device_token, {
        title: 'Webcast is Live!',
        body: `The webcast for ${ll2.name} is live!`,
        launchId: ll2.id,
        type: 'status_change',
        imageUrl: launchImageUrl,
      })
      await logNotification(env.DB, 'status_change', sub.user_id, result.ok)
      await markWebcastNotified(env.DB, sub.id)
    } else if (statusChanged && (isTerminal ? wantsTerminal : wantsStatusChange)) {
      const result = await pushAlertNotification(env.KV, apnsConfig, sub.device_token, {
        title: isTerminal ? terminalTitle(ll2StatusId) : 'Status Changed',
        body: isTerminal
          ? statusBody(ll2StatusId, ll2.name, ll2.rocket.configuration.name)
          : `${ll2.name} status has changed from ${statusLabel(prev.ll2_status_id)} to ${statusLabel(ll2StatusId)}`,
        launchId: ll2.id,
        type: 'status_change',
        imageUrl: launchImageUrl,
      })
      await logNotification(env.DB, 'status_change', sub.user_id, result.ok)
    } else if (t0Changed && t0 && wantsNetChange) {
      const result = await pushAlertNotification(env.KV, apnsConfig, sub.device_token, {
        title: 'Launch Rescheduled',
        body: new Date(t0 * 1000).toUTCString(),
        launchId: ll2.id,
        type: 'schedule_change',
        t0,
        launchName: ll2.name,
        imageUrl: launchImageUrl,
      })
      await logNotification(env.DB, 'schedule_change', sub.user_id, result.ok)
    }
  }))
}

function terminalTitle(id: number): string {
  return (id === LL2_STATUS.SUCCESS || id === LL2_STATUS.PAYLOAD_DEPLOYED)
    ? 'Launch Successful!'
    : 'Launch Failure!'
}

function statusLabel(id: number): string {
  const m: Record<number, string> = {
    [LL2_STATUS.GO]:              'Go for Launch',
    [LL2_STATUS.TBD]:             'TBD',
    [LL2_STATUS.TBC]:             'TBC',
    [LL2_STATUS.HOLD]:            'Launch Hold',
    [LL2_STATUS.IN_FLIGHT]:       'In Flight',
    [LL2_STATUS.SUCCESS]:          'Launch Successful',
    [LL2_STATUS.FAILURE]:          'Launch Failed',
    [LL2_STATUS.PARTIAL_FAILURE]:  'Partial Failure',
    [LL2_STATUS.PAYLOAD_DEPLOYED]: 'Payload Deployed',
  }
  return m[id] ?? `Status ${id}`
}

function statusBody(id: number, name: string, rocket: string): string {
  const m: Record<number, string> = {
    [LL2_STATUS.TBD]:             `${rocket} launch date is to be determined.`,
    [LL2_STATUS.TBC]:             `${rocket} launch date is to be confirmed.`,
    [LL2_STATUS.HOLD]:            `${rocket} is currently on hold.`,
    [LL2_STATUS.SUCCESS]:          `${name} was successful!`,
    [LL2_STATUS.FAILURE]:          `${name} has failed!`,
    [LL2_STATUS.PARTIAL_FAILURE]:  `${name} was a partial failure!`,
    [LL2_STATUS.PAYLOAD_DEPLOYED]: `${name} successfully deployed its payload!`,
  }
  return m[id] ?? `Launch status changed.`
}
