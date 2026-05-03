const APNS_HOST = 'https://api.push.apple.com'
const APNS_SANDBOX_HOST = 'https://api.sandbox.push.apple.com'
const JWT_TTL_S = 40 * 60  // refresh before Apple's 60-min expiry

export type ApnsEnv = 'production' | 'sandbox'

export interface ApnsConfig {
  privateKeyPem: string
  keyId: string
  teamId: string
  bundleId: string
  env: ApnsEnv
}

// Live Activity content-state.
// Field names and types must exactly match LaunchActivityContentState in the iOS app.
// Dates are Unix timestamps (seconds); ActivityKit decodes them via JSONDecoder default (.secondsSince1970).
export interface LaunchContentState {
  netDate: number | null          // T-0 Unix timestamp
  windowStart: number | null      // launch window open
  windowEnd: number | null        // launch window close
  currentEventName: string | null // most-recently-passed timeline event
  currentEventDate: number | null // absolute Unix timestamp when that event fired
  statusId: number                // LL2 status ID: 1=Go,2=TBD,3=Success,4=Failure,5=Hold,6=InFlight,7=PartialFailure,8=TBC
}

export interface LiveActivityPayload {
  event: 'update' | 'end'
  contentState: LaunchContentState
  alertTitle?: string
  alertBody?: string
  dismissalDate?: number  // unix timestamp; only for event=end
}

export interface AlertPayload {
  title: string
  body: string
  launchId: string
  type: 'reminder' | 'status_change' | 'schedule_change'
}

function base64url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const binary = atob(b64)
  const buf = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i)
  return buf.buffer
}

async function makeJwt(teamId: string, keyId: string, privateKeyPem: string): Promise<string> {
  const enc = new TextEncoder()
  const header = base64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: keyId })))
  const payload = base64url(enc.encode(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) })))
  const message = `${header}.${payload}`

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem) as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(message)
  )

  return `${message}.${base64url(sig)}`
}

async function getCachedJwt(kv: KVNamespace, config: ApnsConfig): Promise<string> {
  const cacheKey = `apns_jwt:${config.keyId}`
  const cached = await kv.get(cacheKey)
  if (cached) return cached

  const jwt = await makeJwt(config.teamId, config.keyId, config.privateKeyPem)
  await kv.put(cacheKey, jwt, { expirationTtl: JWT_TTL_S })
  return jwt
}

async function sendApns(
  kv: KVNamespace,
  config: ApnsConfig,
  deviceToken: string,
  pushType: 'alert' | 'liveactivity',
  topic: string,
  payload: unknown
): Promise<{ ok: boolean; status: number; body: string }> {
  const host = config.env === 'production' ? APNS_HOST : APNS_SANDBOX_HOST
  const jwt = await getCachedJwt(kv, config)

  const res = await fetch(`${host}/3/device/${deviceToken}`, {
    method: 'POST',
    headers: {
      'authorization': `bearer ${jwt}`,
      'apns-push-type': pushType,
      'apns-topic': topic,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const body = await res.text()
  return { ok: res.ok, status: res.status, body }
}

export async function pushLiveActivityUpdate(
  kv: KVNamespace,
  config: ApnsConfig,
  activityToken: string,
  update: LiveActivityPayload
): Promise<{ ok: boolean; status: number; body: string }> {
  const topic = `${config.bundleId}.push-type.liveactivity`

  const aps: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    event: update.event,
    'content-state': update.contentState,
  }

  if (update.alertTitle) {
    aps.alert = { title: update.alertTitle, body: update.alertBody }
  }
  if (update.event === 'end' && update.dismissalDate) {
    aps['dismissal-date'] = update.dismissalDate
  }

  return sendApns(kv, config, activityToken, 'liveactivity', topic, { aps })
}

export async function pushAlertNotification(
  kv: KVNamespace,
  config: ApnsConfig,
  deviceToken: string,
  alert: AlertPayload
): Promise<{ ok: boolean; status: number; body: string }> {
  const payload = {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: 'default',
    },
    launchId: alert.launchId,
    notificationType: alert.type,
  }

  return sendApns(kv, config, deviceToken, 'alert', config.bundleId, payload)
}
