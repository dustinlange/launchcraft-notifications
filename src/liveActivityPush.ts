import { pushLiveActivityUpdate, ApnsConfig, LiveActivityPayload } from './apns'
import { clearActivityToken } from './db/queries'

// APNs status codes that indicate the activity token is permanently invalid.
const STALE_TOKEN_STATUSES = [400, 410]

/**
 * Sends a Live Activity update and automatically clears the stored activity token
 * if APNs reports it as invalid (400 BadDeviceToken / 410 Unregistered).
 * This prevents stale tokens from blocking future push-to-start dispatches.
 */
export async function pushLiveActivityUpdateAndClearOnFailure(
  db: D1Database,
  kv: KVNamespace,
  config: ApnsConfig,
  subscriptionId: string,
  activityToken: string,
  update: LiveActivityPayload
): Promise<{ ok: boolean; status: number; body: string }> {
  const result = await pushLiveActivityUpdate(kv, config, activityToken, update)

  if (!result.ok && STALE_TOKEN_STATUSES.includes(result.status)) {
    console.warn(`Clearing stale activity token for subscription ${subscriptionId}: APNs ${result.status} ${result.body}`)
    await clearActivityToken(db, subscriptionId)
  }

  return result
}
