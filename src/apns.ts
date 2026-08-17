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
// Callers pass Unix timestamps (seconds since 1970). Before sending, we convert them to
// Apple reference date (seconds since Jan 1 2001) because Swift's JSONDecoder default
// date strategy is .deferredToDate, which interprets numbers as seconds since 2001.
export interface LaunchContentState {
  netDate: number | null          // T-0 Unix timestamp
  windowStart: number | null      // launch window open
  windowEnd: number | null        // launch window close
  currentEventName: string | null // most-recently-passed timeline event (shown with checkmark)
  currentEventDate: number | null // absolute Unix timestamp when that event fired
  nextEventName: string | null    // next upcoming timeline event (shown with countdown)
  nextEventDate: number | null    // absolute Unix timestamp when next event will fire
  statusId: number                // LL2 status ID: 1=Go,2=TBD,3=Success,4=Failure,5=Hold,6=InFlight,7=PartialFailure,8=TBC
  isWebcastLive: boolean          // true when the webcast stream is currently live
  landingSuccess: boolean | null  // true = landed, false = failed, null = pending/no attempt
}

// Seconds between Unix epoch (Jan 1 1970) and Apple reference date (Jan 1 2001).
const APPLE_EPOCH_OFFSET = 978307200

// Converts a LaunchContentState with Unix timestamps to Apple reference date timestamps
// for the 'content-state' field in an APNs Live Activity payload.
function toAppleContentState(cs: LaunchContentState): Record<string, unknown> {
  const toApple = (unix: number | null) => unix !== null ? unix - APPLE_EPOCH_OFFSET : null
  return {
    netDate:          toApple(cs.netDate),
    windowStart:      toApple(cs.windowStart),
    windowEnd:        toApple(cs.windowEnd),
    currentEventName: cs.currentEventName,
    currentEventDate: toApple(cs.currentEventDate),
    nextEventName:    cs.nextEventName,
    nextEventDate:    toApple(cs.nextEventDate),
    statusId:         cs.statusId,
    isWebcastLive:    cs.isWebcastLive,
    landingSuccess:   cs.landingSuccess,
  }
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
  type: 'reminder' | 'status_change' | 'schedule_change' | 'news' | 'event_reminder' | 'astronaut_status' | 'pro_expired'
  t0?: number        // unix timestamp; included for schedule_change so iOS can format locally
  launchName?: string
  articleUrl?: string  // included for news notifications so iOS can open the article on tap
  imageUrl?: string    // image URL for the Notification Service Extension to attach
  eventId?: number     // LL2 event ID; included for event_reminder so iOS can deep-link to the event
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
  pushType: 'alert' | 'background' | 'liveactivity',
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
      // Background pushes must use priority 5 (power-friendly); alert/liveactivity use 10 (default).
      'apns-priority': pushType === 'background' ? '5' : '10',
    },
    body: JSON.stringify(payload),
  })

  const body = await res.text()
  return { ok: res.ok, status: res.status, body }
}

/**
 * Sends a silent "pro status changed" background push to a device.
 * The app handles this in application(_:didReceiveRemoteNotification:fetchCompletionHandler:)
 * by calling ProManager.shared.refreshSubscriptionStatus().
 *
 * Uses push type "background" with content-available:1 and priority 5 (required by Apple).
 * No alert, sound, or badge — the push is invisible to the user.
 */
export async function pushSilentProStatusChange(
  kv: KVNamespace,
  config: ApnsConfig,
  deviceToken: string
): Promise<{ ok: boolean; status: number; body: string }> {
  return sendApns(kv, config, deviceToken, 'background', config.bundleId, {
    aps: { 'content-available': 1 },
    type: 'pro_status_refresh',
  })
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
    'content-state': toAppleContentState(update.contentState),
  }

  if (update.alertTitle) {
    aps.alert = { title: update.alertTitle, body: update.alertBody }
  }
  if (update.event === 'end' && update.dismissalDate) {
    aps['dismissal-date'] = update.dismissalDate - APPLE_EPOCH_OFFSET
  }

  return sendApns(kv, config, activityToken, 'liveactivity', topic, { aps })
}

export async function pushLiveActivityStart(
  kv: KVNamespace,
  config: ApnsConfig,
  pushToStartToken: string,
  params: {
    attributes: Record<string, unknown>
    contentState: LaunchContentState
    alertTitle: string
    alertBody: string
    dismissalDate: number
  }
): Promise<{ ok: boolean; status: number; body: string }> {
  const topic = `${config.bundleId}.push-type.liveactivity`
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    event: 'start',
    'content-state': toAppleContentState(params.contentState),
    'attributes-type': 'LaunchActivityAttributes',
    attributes: params.attributes,
    alert: { title: params.alertTitle, body: params.alertBody },
    'dismissal-date': params.dismissalDate - APPLE_EPOCH_OFFSET,
  }

  return sendApns(kv, config, pushToStartToken, 'liveactivity', topic, { aps })
}

export async function pushAlertNotification(
  kv: KVNamespace,
  config: ApnsConfig,
  deviceToken: string,
  alert: AlertPayload
): Promise<{ ok: boolean; status: number; body: string }> {
  const payload: Record<string, unknown> = {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: 'default',
      // Required for Notification Service Extension to run (format body or attach image)
      ...(alert.type === 'schedule_change' || alert.type === 'event_reminder' || alert.imageUrl !== undefined ? { 'mutable-content': 1 } : {}),
    },
    launchId: alert.launchId,
    notificationType: alert.type,
    ...(alert.t0 !== undefined ? { t0: alert.t0 } : {}),
    ...(alert.launchName !== undefined ? { launchName: alert.launchName } : {}),
    ...(alert.articleUrl !== undefined ? { articleUrl: alert.articleUrl } : {}),
    ...(alert.imageUrl !== undefined ? { imageUrl: alert.imageUrl } : {}),
    ...(alert.eventId !== undefined ? { eventId: alert.eventId } : {}),
  }

  return sendApns(kv, config, deviceToken, 'alert', config.bundleId, payload)
}
