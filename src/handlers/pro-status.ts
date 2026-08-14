import { Context } from 'hono'
import { Env } from '../index'
import {
  setProActiveForDevice,
  setProActiveByTransactionId,
  setProActiveForUserOnly,
  getUserIdsByTransactionId,
  getActiveActivityTokensForUser,
  logNotification,
} from '../db/queries'
import { pushLiveActivityUpdateAndClearOnFailure } from '../liveActivityPush'
import { getApnsConfig } from './webhook'

// POST /pro-status
// Called by the app whenever ProManager.refreshSubscriptionStatus() runs.
// Syncs pro_active to the DB so the worker stops/starts sending notifications accordingly.
// If the user just cancelled/expired, also ends any running Live Activities.
export async function handleProStatus(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{
    userId: string
    isActive: boolean
    originalTransactionId?: string | null
  }>()

  const { userId, isActive, originalTransactionId } = body
  if (!userId || typeof isActive !== 'boolean') {
    return c.json({ error: 'missing required fields' }, 400)
  }

  if (originalTransactionId) {
    // Step 1: stamp originalTransactionId onto this device and set its pro_active
    await setProActiveForDevice(c.env.DB, userId, isActive, originalTransactionId)
    // Step 2: update every other device on the same Apple Account in one query
    await setProActiveByTransactionId(c.env.DB, originalTransactionId, isActive)
  } else {
    // No transaction ID (user has never subscribed on this device) — update this device only
    await setProActiveForUserOnly(c.env.DB, userId, isActive)
  }

  if (!isActive) {
    // End Live Activities for ALL devices on this Apple Account, not just the one that called in
    c.executionCtx.waitUntil(endActiveLiveActivitiesForAccount(c.env, userId, originalTransactionId ?? null))
  }

  return c.json({ ok: true })
}

/** Ends running Live Activities for a single device's user_id. */
export async function endActiveLiveActivities(env: Env, userId: string) {
  const { results: subs } = await getActiveActivityTokensForUser(env.DB, userId)
  if (subs.length === 0) return

  const apnsConfig = getApnsConfig(env)
  const now = Math.floor(Date.now() / 1000)

  await Promise.allSettled(subs.map(async sub => {
    const result = await pushLiveActivityUpdateAndClearOnFailure(env.DB, env.KV, apnsConfig, sub.id, sub.activity_token, {
      event: 'end',
      contentState: {
        netDate: sub.t0,
        windowStart: sub.window_start,
        windowEnd: sub.window_end,
        currentEventName: null,
        currentEventDate: null,
        nextEventName: null,
        nextEventDate: null,
        statusId: sub.ll2_status_id,
        isWebcastLive: false,
      },
      dismissalDate: now + 60 * 5,  // dismiss in 5 minutes
    })
    await logNotification(env.DB, 'live_activity_end', userId, result.ok)
  }))
}

/** Ends Live Activities for all devices on the same Apple Account.
 *  Falls back to the single-device path if no originalTransactionId is available. */
async function endActiveLiveActivitiesForAccount(
  env: Env,
  userId: string,
  originalTransactionId: string | null,
) {
  if (originalTransactionId) {
    const { results: rows } = await getUserIdsByTransactionId(env.DB, originalTransactionId)
    await Promise.allSettled(rows.map(r => endActiveLiveActivities(env, r.user_id)))
  } else {
    await endActiveLiveActivities(env, userId)
  }
}
