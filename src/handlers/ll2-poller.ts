import { Env } from '../index'
import { getLaunch, upsertLaunch, upsertTimelineEvents, getSubscriptionsForLaunch, markSuccessAt } from '../db/queries'
import { createLL2Client, mapStatus, mapT0, parseRelativeTime } from '../ll2'
import { pushLiveActivityUpdate, pushAlertNotification } from '../apns'
import { getApnsConfig } from './webhook'

// Runs every 5 minutes via cron modulo check in index.ts
// Fetches upcoming launches from LL2, diffs against DB, dispatches updates
export async function pollLL2(env: Env) {
  const client = createLL2Client(env.LL2_API_KEY)
  const launches = await client.getUpcomingLaunches(50)
  await Promise.allSettled(launches.map(ll2 => syncLaunch(env, ll2)))
}

// Fetch a single launch by ID — called when the app registers a subscription
// so the DB is immediately up-to-date without waiting for the next poll cycle
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
  net: string | null; window_start: string | null; window_end: string | null
  status: { id: number; abbrev: string }
  rocket: { configuration: { name: string } }
  pad: { name: string; location: { name: string } }
  timeline: Array<{ type: { abbrev: string }; relative_time: string }> | null
}) {
  const t0 = mapT0(ll2.net)
  const windowStart = mapT0(ll2.window_start)
  const windowEnd = mapT0(ll2.window_end)
  const status = mapStatus(ll2.status.abbrev)
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
    rocket: ll2.rocket.configuration.name,
    pad: `${ll2.pad.name}, ${ll2.pad.location.name}`,
    t0,
    window_start: windowStart,
    window_end: windowEnd,
    status,
    ll2_status_id: ll2StatusId,
    has_timeline: hasTimeline ? 1 : 0,
    success_at: null,
    end_dispatched: 0,
  })

  if (hasTimeline && t0) {
    await upsertTimelineEvents(env.DB, ll2.id, timeline, t0)
  }

  if (status === 'success') {
    await markSuccessAt(env.DB, ll2.id, Math.floor(Date.now() / 1000))
  }

  // No previous record means no subscribers yet — nothing to notify
  if (!prev) return

  const statusChanged = prev.status !== status
  const t0Changed = prev.t0 !== t0
  const isTerminal = status === 'success' || status === 'failure' || status === 'scrub'

  if (!statusChanged && !t0Changed) return

  const apnsConfig = getApnsConfig(env)
  const { results: subs } = await getSubscriptionsForLaunch(env.DB, ll2.id)

  await Promise.allSettled(subs.map(async (sub) => {
    if (sub.activity_token) {
      await pushLiveActivityUpdate(env.KV, apnsConfig, sub.activity_token, {
        event: isTerminal ? 'end' : 'update',
        contentState: {
          netDate: t0,
          windowStart,
          windowEnd,
          currentEventName: null,
          currentEventDate: null,
          statusId: ll2StatusId,
        },
        alertTitle: statusChanged
          ? `${ll2.name}: ${statusLabel(status)}`
          : `${ll2.name}: Schedule Updated`,
        alertBody: t0Changed && t0 ? `New window: ${new Date(t0 * 1000).toUTCString()}` : undefined,
        dismissalDate: isTerminal ? Math.floor(Date.now() / 1000) + 60 * 30 : undefined,
      })
    }

    if (statusChanged) {
      await pushAlertNotification(env.KV, apnsConfig, sub.device_token, {
        title: `${ll2.name}: ${statusLabel(status)}`,
        body: statusBody(status, ll2.rocket.configuration.name),
        launchId: ll2.id,
        type: 'status_change',
      })
    } else if (t0Changed && t0) {
      await pushAlertNotification(env.KV, apnsConfig, sub.device_token, {
        title: `${ll2.name}: Schedule Updated`,
        body: `New launch window: ${new Date(t0 * 1000).toUTCString()}`,
        launchId: ll2.id,
        type: 'schedule_change',
      })
    }
  }))
}

function statusLabel(s: string) {
  const m: Record<string, string> = {
    go: 'Go for Launch', hold: 'Launch Hold', scrub: 'Scrubbed',
    success: 'Launch Successful', failure: 'Launch Failed',
  }
  return m[s] ?? s
}

function statusBody(status: string, rocket: string) {
  const m: Record<string, string> = {
    hold: `${rocket} is currently on hold.`,
    scrub: `${rocket} has been scrubbed. Check back for rescheduling.`,
    success: `${rocket} has successfully launched!`,
    failure: `${rocket} launch ended in failure.`,
  }
  return m[status] ?? `Launch status changed to ${status}.`
}
