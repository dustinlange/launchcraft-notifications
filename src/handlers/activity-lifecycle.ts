import { Env } from '../index'
import { getSubscriptionsNeedingStart, getLaunchesNeedingEnd, markEndDispatched, getSubscriptionsForLaunch } from '../db/queries'
import { pushLiveActivityUpdate } from '../apns'
import { getApnsConfig } from './webhook'
import { sendPushToStart } from './register'

// Runs every minute via cron — starts Live Activities for subscriptions within 1h of launch
export async function dispatchActivityStarts(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  const { results: subs } = await getSubscriptionsNeedingStart(env.DB, now)
  if (subs.length === 0) return

  await Promise.allSettled(subs.map(sub =>
    sendPushToStart(
      env,
      sub.launch_id,
      sub.user_id,
      sub.push_to_start_token!,
      sub.attributes_json!,
      {
        netDate: sub.t0,
        windowStart: sub.window_start,
        windowEnd: sub.window_end,
        // No events have fired yet — show the first event as the upcoming countdown
        currentEventName: null,
        currentEventDate: null,
        nextEventName: sub.first_event_name ?? null,
        nextEventDate: sub.first_event_fire_at ?? null,
        statusId: sub.ll2_status_id,
      },
      sub.launch_name
    )
  ))
}

// Runs every minute via cron — ends Live Activities 30 minutes after a successful launch
export async function dispatchActivityEnds(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  const { results: launches } = await getLaunchesNeedingEnd(env.DB, now)
  if (launches.length === 0) return

  const apnsConfig = getApnsConfig(env)

  await Promise.allSettled(launches.map(async (launch) => {
    const { results: subs } = await getSubscriptionsForLaunch(env.DB, launch.id)
    const activeSubs = subs.filter(s => s.activity_token)

    await Promise.allSettled(activeSubs.map(async sub => {
      const result = await pushLiveActivityUpdate(env.KV, apnsConfig, sub.activity_token!, {
        event: 'end',
        contentState: {
          netDate: launch.t0,
          windowStart: launch.window_start,
          windowEnd: launch.window_end,
          currentEventName: null,
          currentEventDate: null,
          nextEventName: null,
          nextEventDate: null,
          statusId: launch.ll2_status_id,
        },
        dismissalDate: now + 60 * 30,  // 30 min from now — must be in the future
      })
      if (!result.ok) {
        console.error(`end push failed for ${launch.id}/${sub.user_id}: ${result.status} ${result.body}`)
      } else {
        console.log(`end push sent for ${launch.id}/${sub.user_id}: ${result.status}`)
      }
    }))

    await markEndDispatched(env.DB, launch.id)
    // Clear stale activity tokens — once end is dispatched the tokens are no longer useful.
    // If the end push was never received (token rotated while app was backgrounded), the
    // activity will remain on device until the user dismisses it manually, but at least
    // the DB won't keep retrying with dead tokens.
    await env.DB.prepare(
      `UPDATE subscriptions SET activity_token = NULL, activity_id = NULL
       WHERE launch_id = ?`
    ).bind(launch.id).run()
  }))
}
