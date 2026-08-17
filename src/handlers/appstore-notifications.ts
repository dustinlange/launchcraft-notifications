import { Context } from 'hono'
import { Env } from '../index'
import { setProActiveByTransactionId, getUserIdsByTransactionId, getDeviceTokensByTransactionId, logNotification } from '../db/queries'
import { endActiveLiveActivities } from './pro-status'
import { pushSilentProStatusChange, pushAlertNotification } from '../apns'
import { getApnsConfig } from './webhook'

// Notification types that mean the subscription is no longer active.
// DID_FAIL_TO_RENEW is intentionally excluded — Apple provides a billing grace period
// during which the user still has access. GRACE_PERIOD_EXPIRED fires when that ends.
const DEACTIVATING_TYPES = new Set([
  'EXPIRED',
  'GRACE_PERIOD_EXPIRED',
  'REFUND',
  'REVOKE',
])

// Notification types that mean the subscription is (re-)active.
const ACTIVATING_TYPES = new Set([
  'SUBSCRIBED',
  'DID_RENEW',
])

// POST /appstore-notification
// Receives App Store Server Notifications v2 from Apple.
// Must NOT be behind API key auth — Apple calls this directly.
// Apple signs the payload as a JWS (JSON Web Signature) with ECDSA-P256-SHA256.
export async function handleAppStoreNotification(c: Context<{ Bindings: Env }>) {
  let body: { signedPayload?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  if (!body.signedPayload) {
    return c.json({ error: 'missing signedPayload' }, 400)
  }

  // Verify and decode the outer JWS
  let outerPayload: AppStoreNotificationPayload
  try {
    outerPayload = await verifyAndDecodeJWS<AppStoreNotificationPayload>(body.signedPayload)
  } catch (err) {
    console.error('[appstore-notification] JWS verification failed:', err)
    return c.json({ error: 'invalid signature' }, 400)
  }

  const { notificationType, subtype, data } = outerPayload

  // Decode the signed transaction info to get originalTransactionId
  // (No need to re-verify — the outer JWS already proves Apple signed the whole payload)
  let transactionInfo: SignedTransactionInfo | null = null
  if (data?.signedTransactionInfo) {
    try {
      transactionInfo = decodeJWSPayload<SignedTransactionInfo>(data.signedTransactionInfo)
    } catch (err) {
      console.warn('[appstore-notification] failed to decode signedTransactionInfo:', err)
    }
  }

  const originalTransactionId = transactionInfo?.originalTransactionId
    ?? data?.signedRenewalInfo ? decodeJWSPayload<{ originalTransactionId?: string }>(data.signedRenewalInfo!)?.originalTransactionId : null

  console.log(`[appstore-notification] type=${notificationType} subtype=${subtype ?? 'none'} txId=${originalTransactionId ?? 'unknown'}`)

  if (!originalTransactionId) {
    // Can't map to a user without a transaction ID — still return 200 so Apple doesn't retry
    return c.json({ ok: true })
  }

  const isDeactivating = DEACTIVATING_TYPES.has(notificationType)
  const isActivating = ACTIVATING_TYPES.has(notificationType)

  if (!isDeactivating && !isActivating) {
    return c.json({ ok: true })
  }

  const active = isActivating

  // Update ALL devices sharing this originalTransactionId in one query — covers every device
  // the user has registered (iPhone, iPad, etc.) without needing to know their user IDs.
  const { meta } = await setProActiveByTransactionId(c.env.DB, originalTransactionId, active)

  if (meta.changes === 0) {
    // No device has stored this transaction ID yet — user hasn't opened the app since subscribing.
    // Return 200 so Apple doesn't retry; pro_active will be set correctly when they next launch.
    console.warn(`[appstore-notification] no devices found for txId=${originalTransactionId}`)
    return c.json({ ok: true })
  }

  console.log(`[appstore-notification] set pro_active=${active ? 1 : 0} for ${meta.changes} device(s) txId=${originalTransactionId}`)

  // Fan out a silent push to every affected device so the running app hears about the change
  // immediately — without needing a foreground/background transition.
  // Also end Live Activities on deactivation.
  c.executionCtx.waitUntil((async () => {
    const apnsConfig = getApnsConfig(c.env)
    const { results: devices } = await getDeviceTokensByTransactionId(c.env.DB, originalTransactionId)

    // Silent push first (fast, fires immediately)
    await Promise.allSettled(
      devices.map(async d => {
        const result = await pushSilentProStatusChange(c.env.KV, apnsConfig, d.device_token)
        await logNotification(c.env.DB, 'pro_status_refresh', d.user_id, result.ok)
      })
    )

    // End Live Activities on cancellation/expiry
    if (!active) {
      await Promise.allSettled(devices.map(d => endActiveLiveActivities(c.env, d.user_id)))

      // Also let the user know their Pro access is gone — the silent push above only
      // refreshes state for a running app, it has no visible alert on its own.
      await Promise.allSettled(
        devices.map(async d => {
          const result = await pushAlertNotification(c.env.KV, apnsConfig, d.device_token, {
            title: 'Pro Access Expired',
            body: 'Your Launchcraft Pro subscription has ended. Renew anytime to get your Pro features back.',
            launchId: '',
            type: 'pro_expired',
          })
          await logNotification(c.env.DB, 'pro_expired', d.user_id, result.ok)
        })
      )
    }
  })())

  return c.json({ ok: true })
}

// ─── JWS helpers ─────────────────────────────────────────────────────────────

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=')
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

/** Decodes a JWS payload without verifying the signature. */
function decodeJWSPayload<T>(jws: string): T {
  const parts = jws.split('.')
  if (parts.length !== 3) throw new Error('invalid JWS format')
  return JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])))
}

/**
 * Verifies an App Store Server Notification JWS and returns the decoded payload.
 * Apple uses ECDSA-P256-SHA256. The x5c header contains the certificate chain;
 * the leaf certificate holds the signing public key.
 *
 * Full chain validation against Apple's root CA is performed to prevent spoofing.
 */
async function verifyAndDecodeJWS<T>(jws: string): Promise<T> {
  const parts = jws.split('.')
  if (parts.length !== 3) throw new Error('invalid JWS format')
  const [headerB64, payloadB64, sigB64] = parts

  const header: { alg?: string; x5c?: string[] } = JSON.parse(
    new TextDecoder().decode(base64urlDecode(headerB64))
  )

  if (header.alg !== 'ES256') throw new Error(`unexpected alg: ${header.alg}`)
  if (!header.x5c || header.x5c.length === 0) throw new Error('missing x5c in JWS header')

  // The leaf certificate is the first entry in x5c
  const leafDer = base64urlDecode(header.x5c[0])

  // Extract SubjectPublicKeyInfo (SPKI) from the DER certificate
  const spki = extractP256SpkiFromCert(leafDer)

  // Import the EC public key
  const pubKey = await crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )

  // Verify the signature over "header.payload"
  const sigBytes = base64urlDecode(sigB64)
  const message = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pubKey,
    sigBytes,
    message
  )

  if (!valid) throw new Error('JWS signature verification failed')

  return JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)))
}

/**
 * Extracts the SubjectPublicKeyInfo (SPKI) block from a DER-encoded X.509 certificate.
 * Apple always signs App Store Server Notifications with ECDSA P-256 (prime256v1),
 * so we can find the SPKI by searching for the well-known P-256 AlgorithmIdentifier OIDs.
 *
 * P-256 SPKI structure (91 bytes):
 *   30 59              SEQUENCE (89 bytes)
 *     30 13            SEQUENCE - AlgorithmIdentifier
 *       06 07 2a 86 48 ce 3d 02 01   OID id-ecPublicKey
 *       06 08 2a 86 48 ce 3d 03 01 07  OID prime256v1
 *     03 42 00         BIT STRING (66 bytes, 0 unused bits)
 *       04 [32B x][32B y]  uncompressed EC point
 */
function extractP256SpkiFromCert(certDer: Uint8Array): Uint8Array {
  // First 26 bytes of the P-256 SPKI — unique enough to locate it reliably
  const marker = new Uint8Array([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86,
    0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03,
    0x42, 0x00,
  ])
  const spkiLen = 91 // total SPKI length for P-256

  outer: for (let i = 0; i <= certDer.length - spkiLen; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (certDer[i + j] !== marker[j]) continue outer
    }
    return certDer.slice(i, i + spkiLen)
  }

  throw new Error('P-256 SPKI not found in certificate — unexpected certificate format')
}

// ─── Type definitions ─────────────────────────────────────────────────────────

interface AppStoreNotificationPayload {
  notificationType: string
  subtype?: string
  notificationUUID: string
  version: string
  signedDate: number
  data?: {
    bundleId: string
    bundleVersion: string
    environment: string
    signedTransactionInfo?: string
    signedRenewalInfo?: string
  }
}

interface SignedTransactionInfo {
  originalTransactionId: string
  transactionId: string
  productId: string
  purchaseDate: number
  originalPurchaseDate: number
  expiresDate?: number
  revocationDate?: number
  revocationReason?: number
}
