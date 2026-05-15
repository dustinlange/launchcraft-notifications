import { Context } from 'hono'
import { Env } from '../index'
import { getLaunch, upsertLaunch, upsertSubscription, upsertUserDevice, updatePushToStartTokenForUser, updateActivityToken, upsertTimelineEvents, getActiveSubscriptionsForUser, deleteSubscription, getProviderSubscriptionsForUser, upsertProviderSubscription, deleteProviderSubscription, getLocationSubscriptionsForUser, upsertLocationSubscription, deleteLocationSubscription, upsertSectionSubscription, deleteSectionSubscription, insertLaunchOptOut, deleteLaunchOptOut } from '../db/queries'
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
    pad_location: null,
    pad_location_id: null,
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

  // Clear any explicit opt-out so fan-out can include this launch again in future syncs
  await deleteLaunchOptOut(c.env.DB, userId, launch.id)

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
          nextEventName: null,
          nextEventDate: null,
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

// DELETE /activity-token
// Called when the user's Live Activity is dismissed/ended.
// Clears the activity token so push-to-start can fire again (if it hasn't already).
export async function handleClearActivityToken(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; launchId: string }>()
  const { userId, launchId } = body
  if (!userId || !launchId) return c.json({ error: 'missing required fields' }, 400)

  await c.env.DB.prepare(`
    UPDATE subscriptions SET activity_token = NULL, activity_id = NULL
    WHERE user_id = ? AND launch_id = ?
  `).bind(userId, launchId).run()

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
  // Record the opt-out so fan-out from provider/location/all-upcoming doesn't re-add this subscription
  await insertLaunchOptOut(c.env.DB, userId, launchId)
  return c.json({ ok: true })
}

// POST /device-token
// Called when the APNs device token becomes available or rotates.
// Updates the token in place without touching any subscription state.
export async function handleDeviceToken(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; deviceToken: string }>()
  const { userId, deviceToken } = body
  if (!userId || !deviceToken) return c.json({ error: 'missing required fields' }, 400)

  await c.env.DB.prepare(`
    INSERT INTO user_devices (user_id, device_token, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      device_token = excluded.device_token,
      updated_at = unixepoch()
  `).bind(userId, deviceToken).run()

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

// GET /location-subscriptions?userId=<id>
export async function handleGetLocationSubscriptions(c: Context<{ Bindings: Env }>) {
  const userId = c.req.query('userId')
  if (!userId) return c.json({ error: 'missing userId' }, 400)

  const { results } = await getLocationSubscriptionsForUser(c.env.DB, userId)
  return c.json({ locations: results.map(r => ({ locationId: r.location_id, location: r.location })) })
}

// POST /location-subscription
export async function handleSubscribeToLocation(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; locationId: number }>()
  const { userId, locationId } = body
  if (!userId || !locationId) return c.json({ error: 'missing required fields' }, 400)

  await upsertLocationSubscription(c.env.DB, userId, locationId)
  return c.json({ ok: true })
}

// DELETE /location-subscription
export async function handleUnsubscribeFromLocation(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; locationId: number }>()
  const { userId, locationId } = body
  if (!userId || !locationId) return c.json({ error: 'missing required fields' }, 400)

  await deleteLocationSubscription(c.env.DB, userId, locationId)
  return c.json({ ok: true })
}

// GET /section-subscription?userId=<id>&sectionId=<id>
// Returns whether the given section has an active subscription.
export async function handleGetSectionSubscription(c: Context<{ Bindings: Env }>) {
  const userId = c.req.query('userId')
  const sectionId = c.req.query('sectionId')
  if (!userId || !sectionId) return c.json({ error: 'missing userId or sectionId' }, 400)

  const row = await c.env.DB.prepare(
    'SELECT 1 FROM section_subscriptions WHERE user_id = ? AND section_id = ?'
  ).bind(userId, sectionId).first()

  return c.json({ subscribed: row !== null })
}

// POST /section-subscription
// Creates or replaces a section subscription. sectionId is the stable UUID of the ForYouSection.
// Pass allUpcoming=true (or empty provider/location arrays) for "all upcoming" sections.
export async function handleSubscribeToSection(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{
    userId: string
    sectionId: string
    providerIds: number[]
    locationIds: number[]
  }>()
  const { userId, sectionId, providerIds, locationIds } = body
  if (!userId || !sectionId) return c.json({ error: 'missing userId or sectionId' }, 400)
  if (!Array.isArray(providerIds) || !Array.isArray(locationIds)) {
    return c.json({ error: 'providerIds and locationIds must be arrays' }, 400)
  }

  const allUpcoming = providerIds.length === 0 && locationIds.length === 0
  await upsertSectionSubscription(c.env.DB, userId, sectionId, allUpcoming, providerIds, locationIds)
  return c.json({ ok: true })
}

// DELETE /section-subscription
// Removes a section subscription entirely. Only needs the sectionId.
export async function handleUnsubscribeFromSection(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; sectionId: string }>()
  const { userId, sectionId } = body
  if (!userId || !sectionId) return c.json({ error: 'missing userId or sectionId' }, 400)

  await deleteSectionSubscription(c.env.DB, userId, sectionId)
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
    nextEventName: string | null
    nextEventDate: number | null
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
