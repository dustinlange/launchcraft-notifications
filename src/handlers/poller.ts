import { Env } from '../index'
import { getActiveNoTimelineLaunches, getSubscriptionsForLaunch } from '../db/queries'
import { pushLiveActivityUpdateAndClearOnFailure } from '../liveActivityPush'
import { getApnsConfig } from './webhook'

// Runs every 5 minutes via cron trigger (controlled by modulo check inside the 1-min cron)
// Pushes a "heartbeat" Live Activity update for launches without timelines
// so the widget's countdown stays accurate even without event milestones
export async function pollNoTimelineLaunches(env: Env) {
  const { results: launches } = await getActiveNoTimelineLaunches(env.DB)
  if (launches.length === 0) return

  const apnsConfig = getApnsConfig(env)
  const now = Math.floor(Date.now() / 1000)

  await Promise.allSettled(launches.map(async (launch) => {
    const { results: subs } = await getSubscriptionsForLaunch(env.DB, launch.id)
    const activeSubs = subs.filter(s => s.activity_token)
    if (activeSubs.length === 0) return

    // Only send a heartbeat if T-0 is within the next 24 hours
    if (!launch.t0 || launch.t0 - now > 24 * 60 * 60) return

    await Promise.allSettled(activeSubs.map(sub =>
      pushLiveActivityUpdateAndClearOnFailure(env.DB, env.KV, apnsConfig, sub.id, sub.activity_token!, {
        event: 'update',
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
      })
    ))
  }))
}
