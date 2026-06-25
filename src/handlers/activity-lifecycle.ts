import { Env } from '../index'
import { getSubscriptionsNeedingStart, getLaunchesNeedingEnd, markEndDispatched, getSubscriptionsForLaunch, clearPushToStartToken } from '../db/queries'
import { pushLiveActivityUpdateAndClearOnFailure } from '../liveActivityPush'
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
        isWebcastLive: false,
      },
      sub.launch_name
    )
  ))
}

// Runs every minute via cron — handles two push-to-start failure modes:
//
// 1. Pre-launch silent failure (T-0 still in the future): APNs accepted the push (200 OK)
//    but iOS never started the activity. Reset start_dispatched so the cron retries before launch.
//
// 2. Post-launch stale token (T-0 > 5 min in the past): push was sent but activity never started.
//    The token is likely rotated/invalid. Clear it so the user gets a clean slate on next launch.
export async function detectSilentPushToStartFailures(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  const staleWindowS = 5 * 60 // 5 minutes past T0 — enough time for the activity token to arrive
  // Only consider subscriptions whose push-to-start was sent at least 10 minutes ago.
  // Without this cooldown, the retry loop resets start_dispatched every cron cycle (1 min)
  // before iOS has a chance to start the activity and the app registers the activity_token,
  // causing a new push-to-start each minute → multiple live activities on the same device.
  const retryAfterS = 10 * 60
  const { results } = await env.DB.prepare(`
    SELECT s.id, s.user_id, s.launch_id, l.name as launch_name, l.t0, ud.push_to_start_token
    FROM launch_subscriptions s
    JOIN launches l ON l.id = s.launch_id
    JOIN user_devices ud ON ud.user_id = s.user_id
    WHERE s.start_dispatched = 1
      AND s.activity_token IS NULL
      AND l.t0 IS NOT NULL
      AND l.end_dispatched = 0
      AND ud.push_to_start_token IS NOT NULL
      AND (s.start_dispatched_at IS NULL OR s.start_dispatched_at <= ? - ?)
  `).bind(now, retryAfterS).all<{ id: string; user_id: string; launch_id: string; launch_name: string; t0: number; push_to_start_token: string }>()

  for (const sub of results) {
    if (sub.t0 > now) {
      // Launch hasn't happened yet. Only retry if T-0 is within 30 minutes — if we're
      // further out the activity is almost certainly running; the iOS app just hasn't
      // registered the token yet (e.g. push-to-start fired while the app was already open
      // and the AppDelegate snapshot missed it). Retrying early creates duplicate activities.
      const thirtyMinS = 30 * 60
      if (sub.t0 - now > thirtyMinS) {
        console.log(`[push-to-start] activity token not yet registered for ${sub.launch_id}/${sub.user_id}, T-0 still ${Math.round((sub.t0 - now) / 60)}m away — skipping retry`)
        continue
      }
      console.warn(`[push-to-start] pre-launch silent failure for ${sub.launch_id}/${sub.user_id} — resetting start_dispatched to retry`)
      await env.DB.prepare(
        'UPDATE launch_subscriptions SET start_dispatched = 0 WHERE id = ?'
      ).bind(sub.id).run()
    } else if (sub.t0 < now - staleWindowS) {
      // Launch is done and activity never started — token is stale, clear it
      console.warn(`[push-to-start] post-launch silent failure for ${sub.launch_id}/${sub.user_id} — clearing stale push-to-start token`)
      await clearPushToStartToken(env.DB, sub.user_id, sub.push_to_start_token)
    }
    // If t0 is within the 5-minute stale window, wait a bit longer before acting
  }
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
      const result = await pushLiveActivityUpdateAndClearOnFailure(env.DB, env.KV, apnsConfig, sub.id, sub.activity_token!, {
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
          isWebcastLive: (launch.webcast_live ?? 0) === 1,
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
      `UPDATE launch_subscriptions SET activity_token = NULL, activity_id = NULL
       WHERE launch_id = ?`
    ).bind(launch.id).run()
  }))
}
