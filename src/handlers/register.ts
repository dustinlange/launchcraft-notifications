import { Context } from 'hono'
import { Env } from '../index'
import { getLaunch, upsertLaunch, upsertSubscription, upsertUserDevice, updatePushToStartTokenForUser, updateActivityToken, upsertTimelineEvents, getActiveSubscriptionsForUser, deleteSubscription, getProviderSubscriptionsForUser, upsertProviderSubscription, deleteProviderSubscription } from '../db/queries'
import { syncLaunchById } from './ll2-poller'
import { pushLiveActivityStart } from '../apns'
import { getApnsConfig } from './webhook'

const START_WINDOW_S = 60 * 60  // send push-to-start if T-0 is within 1 hour

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
      ll2StatusId: number
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
    provider_id: null,
    t0: launch.t0 ?? null,
    window_start: null,
    window_end: null,
    ll2_status_id: launch.ll2StatusId,
    has_timeline: hasTimeline ? 1 : 0,
    success_at: null,
    end_dispatched: 0,
  })

  if (hasTimeline && launch.t0 && launch.timeline) {
    await upsertTimelineEvents(c.env.DB, launch.id, launch.timeline, launch.t0)
  }

  await upsertUserDevice(c.env.DB, userId, deviceToken, pushToStartToken ?? null)

  await upsertSubscription(c.env.DB, {
    launch_id: launch.id,
    user_id: userId,
    attributes_json: attributesJson ?? null,
  })

  // Immediately sync from LL2 so the DB has fresh data without waiting for the next poll
  c.executionCtx.waitUntil(syncLaunchById(c.env, launch.id))

  // Send push-to-start immediately if T-0 is within 1 hour
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
          statusId: launch.ll2StatusId,
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

// DELETE /subscription
// Called when the user unsubscribes from a launch
export async function handleUnsubscribe(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; launchId: string }>()
  const { userId, launchId } = body
  if (!userId || !launchId) return c.json({ error: 'missing required fields' }, 400)

  await deleteSubscription(c.env.DB, userId, launchId)
  return c.json({ ok: true })
}

// POST /push-to-start-token
// Called when the device's push-to-start token rotates
export async function handlePushToStartToken(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; pushToStartToken: string }>()
  const { userId, pushToStartToken } = body
  if (!userId || !pushToStartToken) {
    return c.json({ error: 'missing required fields' }, 400)
  }

  await updatePushToStartTokenForUser(c.env.DB, userId, pushToStartToken)
  // Reset start_dispatched so we can retry push-to-start with the new token
  await c.env.DB.prepare('UPDATE subscriptions SET start_dispatched = 0 WHERE user_id = ?').bind(userId).run()
  return c.json({ ok: true })
}

// GET /provider-subscriptions?userId=<id>
export async function handleGetProviderSubscriptions(c: Context<{ Bindings: Env }>) {
  const userId = c.req.query('userId')
  if (!userId) return c.json({ error: 'missing userId' }, 400)

  const { results } = await getProviderSubscriptionsForUser(c.env.DB, userId)
  return c.json({ providerIds: results.map(r => r.provider_id) })
}

// POST /provider-subscription
export async function handleSubscribeToProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; providerId: number }>()
  const { userId, providerId } = body
  if (!userId || !providerId) return c.json({ error: 'missing required fields' }, 400)

  await upsertProviderSubscription(c.env.DB, userId, providerId)
  return c.json({ ok: true })
}

// DELETE /provider-subscription
export async function handleUnsubscribeFromProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; providerId: number }>()
  const { userId, providerId } = body
  if (!userId || !providerId) return c.json({ error: 'missing required fields' }, 400)

  await deleteProviderSubscription(c.env.DB, userId, providerId)
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
    // Atomically claim the subscription before sending — prevents duplicate pushes
    // from concurrent cron invocations or simultaneous /register calls.
    const claim = await env.DB.prepare(
      'UPDATE subscriptions SET start_dispatched = 1 WHERE user_id = ? AND launch_id = ? AND start_dispatched = 0'
    ).bind(userId, launchId).run()
    if (claim.meta.changes === 0) return

    const attributes = JSON.parse(attributesJson)
    const apnsConfig = getApnsConfig(env)
    const now = Math.floor(Date.now() / 1000)
    const result = await pushLiveActivityStart(env.KV, apnsConfig, pushToStartToken, {
      attributes,
      contentState,
      alertTitle: launchName,
      alertBody: 'Live Activity started',
      dismissalDate: now + 8 * 60 * 60,
      staleDate: contentState.netDate ? contentState.netDate + 30 * 60 : undefined,
    })

    if (!result.ok) {
      // Roll back the claim so the next cron cycle can retry
      await env.DB.prepare(
        'UPDATE subscriptions SET start_dispatched = 0 WHERE user_id = ? AND launch_id = ?'
      ).bind(userId, launchId).run()
      console.error(`push-to-start failed for ${launchId}/${userId}: ${result.status} ${result.body}`)
    }
  } catch (err) {
    console.error(`sendPushToStart error for ${launchId}/${userId}:`, err)
  }
}
