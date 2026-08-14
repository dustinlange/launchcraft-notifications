import { Context } from 'hono'
import { Env } from '../index'
import { getLaunch, upsertLaunch, upsertSubscription, upsertUserDevice, updatePushToStartTokenForUser, updateActivityToken, upsertTimelineEvents, getActiveSubscriptionsForUser, deleteSubscription, getProviderSubscriptionsForUser, upsertProviderSubscription, deleteProviderSubscription, getLocationSubscriptionsForUser, upsertLocationSubscription, deleteLocationSubscription, upsertLaunchesFeedSubscription, upsertEventsFeedSubscription, upsertNewsFeedSubscription, upsertAstronautsFeedSubscription, deleteFeedSubscription, insertLaunchOptOut, deleteLaunchOptOut, clearPushToStartToken, clearOptOutsForFeedSubscription, getUserPreferences, fanOutExistingLaunchesToFeedSubscription, logNotification, CONFIRMED_GO_IDS } from '../db/queries'
import { syncLaunchById } from './ll2-poller'
import { pushLiveActivityStart } from '../apns'
import { pushLiveActivityUpdate } from '../apns'
import { getApnsConfig } from './webhook'

const DEFAULT_START_WINDOW_S = 60 * 60  // fallback: send push-to-start if T-0 is within 1 hour

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
    mission_name: null,
    rocket: launch.rocket,
    pad: launch.pad,
    pad_location: null,
    pad_location_id: null,
    provider: null,
    provider_id: null,
    provider_logo_url: null,
    image_url: null,
    rocket_image_url: null,
    t0: launch.t0 ?? null,
    window_start: null,
    window_end: null,
    ll2_status_id: launch.ll2StatusId,
    has_timeline: hasTimeline ? 1 : 0,
    webcast_live: null,
    success_at: null,
    end_dispatched: 0,
  })

  if (hasTimeline && launch.t0 && launch.timeline) {
    await upsertTimelineEvents(c.env.DB, launch.id, launch.timeline, launch.t0)
  }

  // If this device token is already registered under different user IDs (e.g. after one or
  // more reinstalls that cleared UserDefaults and generated a new UUID), migrate all
  // subscriptions from every stale user ID to the current one in a single batch.
  // Previously used .first() which only caught one stale ID per call — if the device had
  // been reinstalled multiple times, multiple stale IDs accumulated and each one triggered
  // a separate push-to-start, resulting in duplicate Live Activities.
  const { results: staleDevices } = await c.env.DB.prepare(
    'SELECT user_id FROM user_devices WHERE device_token = ? AND user_id != ?'
  ).bind(deviceToken, userId).all<{ user_id: string }>()

  if (staleDevices.length > 0) {
    console.log(`register: merging ${staleDevices.length} stale user(s) into ${userId} (same device token)`)
    const statements = staleDevices.flatMap(({ user_id: oldUserId }) => [
      c.env.DB.prepare(`
        INSERT OR IGNORE INTO launch_subscriptions (id, launch_id, user_id, activity_token, activity_id, attributes_json, start_dispatched, start_dispatched_at, reminded_24h, reminded_1h, reminded_10m, created_at)
        SELECT id, launch_id, ?, activity_token, activity_id, attributes_json, start_dispatched, start_dispatched_at, reminded_24h, reminded_1h, reminded_10m, created_at
        FROM launch_subscriptions WHERE user_id = ?
      `).bind(userId, oldUserId),
      c.env.DB.prepare('DELETE FROM launch_subscriptions WHERE user_id = ?').bind(oldUserId),
      c.env.DB.prepare('DELETE FROM user_devices WHERE user_id = ?').bind(oldUserId),
      c.env.DB.prepare('DELETE FROM user_preferences WHERE user_id = ?').bind(oldUserId),
    ])
    await c.env.DB.batch(statements)
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

  // Send push-to-start immediately if T-0 is within the user's live_activity_window.
  // Fetch the preference asynchronously so we don't block the response on a DB read.
  if (pushToStartToken && attributesJson && launch.t0) {
    const now = Math.floor(Date.now() / 1000)
    c.executionCtx.waitUntil((async () => {
      const prefs = await getUserPreferences(c.env.DB, userId)
      const startWindowS = prefs?.live_activity_window ?? DEFAULT_START_WINDOW_S
      if (launch.t0! - now <= startWindowS) {
        await sendPushToStart(c.env, launch.id, userId, pushToStartToken, attributesJson!, {
          netDate: launch.t0!,
          windowStart: null,
          windowEnd: null,
          currentEventName: null,
          currentEventDate: null,
          nextEventName: null,
          nextEventDate: null,
          statusId: launch.ll2StatusId,
          isWebcastLive: false,
        }, launch.name)
      }
    })())
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

  // Immediately push the current launch state to the newly registered activity token.
  // This catches missed NET-change updates: the poll may have detected a T-0 shift and
  // updated the DB before this token existed in the DB, so no push was sent at that time.
  // Future polls won't retry (t0Changed = false), so we must push on token registration.
  if ((CONFIRMED_GO_IDS as number[]).includes(launch.ll2_status_id) && launch.t0) {
    c.executionCtx.waitUntil((async () => {
      const now = Math.floor(Date.now() / 1000)
      const firstEvent = await c.env.DB.prepare(`
        SELECT label, fire_at FROM timeline_events
        WHERE launch_id = ? AND fire_at > ?
        ORDER BY fire_at ASC LIMIT 1
      `).bind(launchId, now).first<{ label: string; fire_at: number }>()

      const apnsConfig = getApnsConfig(c.env)
      const result = await pushLiveActivityUpdate(c.env.KV, apnsConfig, activityToken, {
        event: 'update',
        contentState: {
          netDate: launch.t0,
          windowStart: launch.window_start,
          windowEnd: launch.window_end,
          currentEventName: null,
          currentEventDate: null,
          nextEventName: firstEvent?.label ?? null,
          nextEventDate: firstEvent?.fire_at ?? null,
          statusId: launch.ll2_status_id,
          isWebcastLive: (launch.webcast_live ?? 0) === 1,
        },
      })
      c.executionCtx.waitUntil(logNotification(c.env.DB, 'live_activity_update', userId, result.ok))
    })())
  }

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
    UPDATE launch_subscriptions SET activity_token = NULL, activity_id = NULL
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
  await c.env.DB.prepare('UPDATE launch_subscriptions SET start_dispatched = 0 WHERE user_id = ?').bind(userId).run()
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

// GET /feed-subscription?userId=<id>&feedId=<id>
// Returns whether the given feed has an active subscription.
export async function handleGetFeedSubscription(c: Context<{ Bindings: Env }>) {
  const userId = c.req.query('userId')
  const feedId = c.req.query('feedId')
  if (!userId || !feedId) return c.json({ error: 'missing userId or feedId' }, 400)

  const row = await c.env.DB.prepare(
    'SELECT 1 FROM feed_subscriptions WHERE user_id = ? AND feed_id = ?'
  ).bind(userId, feedId).first()

  return c.json({ subscribed: row !== null })
}

// POST /feed-subscription
// Creates or replaces a feed subscription keyed on the stable UUID of the ForYouSection.
// sectionType determines which sub-table data is written.
export async function handleSubscribeToFeed(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{
    userId: string
    feedId: string
    sectionType: 'launches' | 'events' | 'news' | 'astronauts'
    // launches
    providerIds?: number[]
    locationIds?: number[]
    crewedOnly?: boolean | null   // null = all, true = crewed only, false = uncrewed only
    // events
    eventTypeIds?: number[]
    // news
    sources?: string[]
    // astronauts
    agencyIds?: number[]
    inSpaceOnly?: boolean
  }>()
  const { userId, feedId, sectionType } = body
  if (!userId || !feedId || !sectionType) return c.json({ error: 'missing userId, feedId, or sectionType' }, 400)

  if (sectionType === 'launches') {
    const providerIds = Array.isArray(body.providerIds) ? body.providerIds : []
    const locationIds = Array.isArray(body.locationIds) ? body.locationIds : []
    const allUpcoming = providerIds.length === 0 && locationIds.length === 0
    const crewedOnly = body.crewedOnly ?? null
    await upsertLaunchesFeedSubscription(c.env.DB, userId, feedId, allUpcoming, providerIds, locationIds, crewedOnly)
    await clearOptOutsForFeedSubscription(c.env.DB, userId, allUpcoming, providerIds, locationIds)
    // Immediately fan out to existing upcoming launches so the poll cycle doesn't have to
    // re-run fan-out for all 50 launches just to pick up this new subscription.
    c.executionCtx.waitUntil(
      fanOutExistingLaunchesToFeedSubscription(c.env.DB, userId, allUpcoming, providerIds, locationIds, crewedOnly)
    )
  } else if (sectionType === 'events') {
    const eventTypeIds = Array.isArray(body.eventTypeIds) ? body.eventTypeIds : []
    await upsertEventsFeedSubscription(c.env.DB, userId, feedId, eventTypeIds)
  } else if (sectionType === 'news') {
    const sources = Array.isArray(body.sources) ? body.sources : []
    await upsertNewsFeedSubscription(c.env.DB, userId, feedId, sources)
  } else if (sectionType === 'astronauts') {
    const agencyIds = Array.isArray(body.agencyIds) ? body.agencyIds : []
    await upsertAstronautsFeedSubscription(c.env.DB, userId, feedId, agencyIds, body.inSpaceOnly ?? false)
  } else {
    return c.json({ error: 'invalid sectionType' }, 400)
  }

  return c.json({ ok: true })
}

// DELETE /feed-subscription
// Removes a feed subscription entirely.
export async function handleUnsubscribeFromFeed(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; feedId: string }>()
  const { userId, feedId } = body
  if (!userId || !feedId) return c.json({ error: 'missing userId or feedId' }, 400)

  await deleteFeedSubscription(c.env.DB, userId, feedId)
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
    isWebcastLive: boolean
  },
  launchName: string
) {
  try {
    // Atomically claim the subscription before sending — prevents duplicate pushes
    // from concurrent cron invocations or simultaneous /register calls.
    const claim = await env.DB.prepare(
      'UPDATE launch_subscriptions SET start_dispatched = 1, start_dispatched_at = unixepoch() WHERE user_id = ? AND launch_id = ? AND start_dispatched = 0'
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
    })

    await logNotification(env.DB, 'live_activity_start', userId, result.ok)

    if (!result.ok) {
      console.error(`push-to-start failed for ${launchId}/${userId}: ${result.status} ${result.body}`)
      if (result.status === 410 || result.status === 400) {
        // Stale push-to-start token — clear it so we stop retrying with a dead token.
        // The user will get a fresh token registered when they next open the app.
        console.warn(`Clearing stale push-to-start token for ${userId} after APNs ${result.status}`)
        await clearPushToStartToken(env.DB, userId, pushToStartToken)
      } else {
        // Transient failure — roll back the claim so the next cron cycle can retry
        await env.DB.prepare(
          'UPDATE launch_subscriptions SET start_dispatched = 0 WHERE user_id = ? AND launch_id = ?'
        ).bind(userId, launchId).run()
      }
    }
  } catch (err) {
    console.error(`sendPushToStart error for ${launchId}/${userId}:`, err)
  }
}
