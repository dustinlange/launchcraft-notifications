import { Context } from 'hono'
import { Env } from '../index'
import { getLaunch, upsertLaunch, upsertSubscription, updateActivityToken, upsertTimelineEvents, updatePushToStartToken, markStartDispatched, getActiveSubscriptionsForUser } from '../db/queries'
import { syncLaunchById } from './ll2-poller'
import { pushLiveActivityStart } from '../apns'
import { getApnsConfig } from './webhook'

const START_WINDOW_S = 24 * 60 * 60  // send push-to-start if T-0 is within 24 hours

// POST /register
// Called when user subscribes to a launch in the app
export async function handleRegister(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{
    userId: string
    deviceToken: string
    pushToStartToken?: string
    attributesJson?: string
    launch: {
      id: string
      name: string
      rocket: string
      pad: string
      t0: number | null
      status: 'go' | 'hold' | 'scrub' | 'success' | 'failure'
      timeline?: Array<{ label: string; t_offset_s: number }>
    }
  }>()

  const { userId, deviceToken, pushToStartToken, attributesJson, launch } = body
  if (!userId || !deviceToken || !launch?.id) {
    return c.json({ error: 'missing required fields' }, 400)
  }

  const hasTimeline = !!(launch.timeline && launch.timeline.length > 0)

  await upsertLaunch(c.env.DB, {
    id: launch.id,
    name: launch.name,
    rocket: launch.rocket,
    pad: launch.pad,
    provider: null,
    t0: launch.t0 ?? null,
    window_start: null,
    window_end: null,
    status: launch.status,
    ll2_status_id: 1,
    has_timeline: hasTimeline ? 1 : 0,
    success_at: null,
    end_dispatched: 0,
  })

  if (hasTimeline && launch.t0 && launch.timeline) {
    await upsertTimelineEvents(c.env.DB, launch.id, launch.timeline, launch.t0)
  }

  await upsertSubscription(c.env.DB, {
    launch_id: launch.id,
    device_token: deviceToken,
    user_id: userId,
    push_to_start_token: pushToStartToken ?? null,
    attributes_json: attributesJson ?? null,
  })

  // Immediately sync from LL2 so the DB has fresh data without waiting for the next poll
  c.executionCtx.waitUntil(syncLaunchById(c.env, launch.id))

  // Send push-to-start immediately if T-0 is within 24 hours
  if (pushToStartToken && attributesJson && launch.t0) {
    const now = Math.floor(Date.now() / 1000)
    if (launch.t0 - now <= START_WINDOW_S) {
      c.executionCtx.waitUntil(
        sendPushToStart(c.env, launch.id, userId, pushToStartToken, attributesJson, {
          netDate: launch.t0,
          windowStart: null,
          windowEnd: null,
          currentEventName: null,
          currentEventDate: null,
          statusId: 1,
        }, launch.name)
      )
    }
  }

  return c.json({ ok: true })
}

// POST /activity-token
// Called after the app starts a Live Activity and receives its push token
export async function handleActivityToken(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{
    userId: string
    launchId: string
    activityToken: string
    activityId: string
  }>()

  const { userId, launchId, activityToken, activityId } = body
  if (!userId || !launchId || !activityToken || !activityId) {
    return c.json({ error: 'missing required fields' }, 400)
  }

  const launch = await getLaunch(c.env.DB, launchId)
  if (!launch) return c.json({ error: 'launch not found' }, 404)

  await updateActivityToken(c.env.DB, userId, launchId, activityToken, activityId)

  return c.json({ ok: true })
}

// GET /subscriptions?userId=<id>
// Returns active (non-terminal) launch IDs the user is subscribed to
export async function handleGetSubscriptions(c: Context<{ Bindings: Env }>) {
  const userId = c.req.query('userId')
  if (!userId) return c.json({ error: 'missing userId' }, 400)

  const { results } = await getActiveSubscriptionsForUser(c.env.DB, userId)
  return c.json({
    launchIds: results.map(r => r.launch_id),
    subscriptions: results.map(r => ({
      launchId: r.launch_id,
      name: r.name,
      provider: r.provider ?? null,
    })),
  })
}

// POST /push-to-start-token
// Called when the device's push-to-start token rotates; updates all subscriptions for this user
export async function handlePushToStartToken(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; pushToStartToken: string }>()
  const { userId, pushToStartToken } = body
  if (!userId || !pushToStartToken) {
    return c.json({ error: 'missing required fields' }, 400)
  }

  await updatePushToStartToken(c.env.DB, userId, pushToStartToken)
  return c.json({ ok: true })
}

export async function sendPushToStart(
  env: Env,
  launchId: string,
  userId: string,
  pushToStartToken: string,
  attributesJson: string,
  contentState: {
    netDate: number | null
    windowStart: number | null
    windowEnd: number | null
    currentEventName: string | null
    currentEventDate: number | null
    statusId: number
  },
  launchName: string
) {
  try {
    const attributes = JSON.parse(attributesJson)
    const apnsConfig = getApnsConfig(env)
    const result = await pushLiveActivityStart(env.KV, apnsConfig, pushToStartToken, {
      attributes,
      contentState,
      alertTitle: launchName,
      alertBody: 'Live Activity started',
      staleDate: contentState.netDate ? contentState.netDate + 30 * 60 : undefined,
    })

    if (result.ok) {
      // Find and mark the subscription so we don't send again
      const { results } = await env.DB.prepare(
        'SELECT id FROM subscriptions WHERE user_id = ? AND launch_id = ?'
      ).bind(userId, launchId).all<{ id: string }>()
      if (results[0]) await markStartDispatched(env.DB, results[0].id)
    } else {
      console.error(`push-to-start failed for ${launchId}/${userId}: ${result.status} ${result.body}`)
    }
  } catch (err) {
    console.error(`sendPushToStart error for ${launchId}/${userId}:`, err)
  }
}
