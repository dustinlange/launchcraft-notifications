import { Env } from '../index'
import { getDueTimelineEvents, getSubscriptionsForLaunch, markEventSent } from '../db/queries'
import { pushLiveActivityUpdate } from '../apns'
import { getApnsConfig } from './webhook'

// Runs every minute via cron trigger
// Dispatches Live Activity updates for due timeline events
export async function dispatchTimelineEvents(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  const { results: events } = await getDueTimelineEvents(env.DB, now)

  if (events.length === 0) return

  const apnsConfig = getApnsConfig(env)

  // Group by launch to batch subscription lookups
  const byLaunch = new Map<string, typeof events>()
  for (const e of events) {
    const list = byLaunch.get(e.launch_id) ?? []
    list.push(e)
    byLaunch.set(e.launch_id, list)
  }

  await Promise.allSettled([...byLaunch.entries()].map(async ([launchId, launchEvents]) => {
    const { results: subs } = await getSubscriptionsForLaunch(env.DB, launchId)
    const activeSubs = subs.filter(s => s.activity_token)

    for (const event of launchEvents) {
      // currentEventDate is the absolute timestamp when this event fired
      const currentEventDate = event.fire_at ?? null

      await Promise.allSettled(activeSubs.map(sub =>
        pushLiveActivityUpdate(env.KV, apnsConfig, sub.activity_token!, {
          event: 'update',
          contentState: {
            netDate: event.t0,
            windowStart: event.window_start,
            windowEnd: event.window_end,
            currentEventName: event.label,
            currentEventDate,
            statusId: event.ll2_status_id,
          },
          alertTitle: event.launch_name,
          alertBody: event.label,
        })
      ))

      await markEventSent(env.DB, event.id)
    }
  }))
}
