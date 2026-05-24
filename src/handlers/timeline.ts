import { Env } from '../index'
import { getDueTimelineEvents, getDueTransitionEvents, getSubscriptionsForLaunch, markEventSent, markTransitionSent } from '../db/queries'
import { pushLiveActivityUpdateAndClearOnFailure } from '../liveActivityPush'
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
        pushLiveActivityUpdateAndClearOnFailure(env.DB, env.KV, apnsConfig, sub.id, sub.activity_token!, {
          event: 'update',
          contentState: {
            netDate: event.t0,
            windowStart: event.window_start,
            windowEnd: event.window_end,
            currentEventName: event.label,  // this event just fired → show checkmark
            currentEventDate,
            nextEventName: null,            // transition push will set next event
            nextEventDate: null,
            statusId: event.ll2_status_id,
          },
          alertTitle: event.launch_name,
          alertBody: event.label,
        })
      ))

      await markEventSent(env.DB, event.id)
    }
  }))

  // Phase 2: transition pushes
  // 60s after an event fires, switch from "checkmark for event N" to
  // "countdown to event N+1" so the Live Activity always shows what's coming next.
  const { results: transitions } = await getDueTransitionEvents(env.DB, now)
  if (transitions.length === 0) return

  await Promise.allSettled(transitions.map(async (transition) => {
    const { results: subs } = await getSubscriptionsForLaunch(env.DB, transition.launch_id)
    const activeSubs = subs.filter(s => s.activity_token)

    await Promise.allSettled(activeSubs.map(sub =>
      pushLiveActivityUpdateAndClearOnFailure(env.DB, env.KV, apnsConfig, sub.id, sub.activity_token!, {
        event: 'update',
        contentState: {
          netDate: transition.t0,
          windowStart: transition.window_start,
          windowEnd: transition.window_end,
          currentEventName: transition.current_event_name,  // keep checkmark on fired event
          currentEventDate: transition.current_event_fire_at,
          nextEventName: transition.next_event_name,        // upcoming → countdown
          nextEventDate: transition.next_event_fire_at,
          statusId: transition.ll2_status_id,
        },
      })
    ))

    await markTransitionSent(env.DB, transition.id)
  }))
}
