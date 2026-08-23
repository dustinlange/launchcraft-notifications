import { Context } from 'hono'
import { Env } from '../index'

const ASC_BASE = 'https://api.appstoreconnect.apple.com'
const ASC_JWT_TTL_S = 18 * 60   // tokens expire at 20 min; refresh before that
const CACHE_KEY = 'app_store_metrics'
const CACHE_TTL_S = 25 * 3600   // 25h — reports lag by ~1 day anyway

export interface AppStoreMetrics {
  rating: { average: number; count: number }
  reviews: { total: number; recent30d: number }
  downloads: { yesterday: number; last7d: number }
  proceeds: { yesterday: number; last7d: number }
  lastUpdated: number
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}

async function makeAscJwt(env: Env): Promise<string> {
  const enc = new TextEncoder()
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' })))
  const payload = b64url(enc.encode(JSON.stringify({ iss: env.ASC_ISSUER_ID, iat: now, exp: now + ASC_JWT_TTL_S, aud: 'appstoreconnect-v1' })))
  const msg = `${header}.${payload}`
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(env.ASC_PRIVATE_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(msg))
  return `${msg}.${b64url(sig)}`
}

async function getAscJwt(env: Env): Promise<string> {
  const cached = await env.KV.get('asc_jwt')
  if (cached) return cached
  const jwt = await makeAscJwt(env)
  await env.KV.put('asc_jwt', jwt, { expirationTtl: ASC_JWT_TTL_S })
  return jwt
}

async function ascGet(env: Env, path: string): Promise<Response> {
  const jwt = await getAscJwt(env)
  return fetch(`${ASC_BASE}${path}`, { headers: { Authorization: `Bearer ${jwt}` } })
}

// ─── Rating ──────────────────────────────────────────────────────────────────

async function fetchRating(env: Env): Promise<{ average: number; count: number }> {
  const res = await ascGet(env, `/v1/apps/${env.ASC_APP_ID}?fields[apps]=averageUserRating,userRatingCount`)
  if (!res.ok) {
    console.log('[app-store] rating API status:', res.status, await res.text().catch(() => ''))
    throw new Error(`Rating API ${res.status}`)
  }
  const json = await res.json<{ data: { attributes: { averageUserRating?: number | null; userRatingCount?: number | null } } }>()
  const attrs = json.data.attributes
  console.log('[app-store] rating attrs:', JSON.stringify(attrs))
  return {
    average: attrs.averageUserRating != null ? Math.round(attrs.averageUserRating * 10) / 10 : null as unknown as number,
    count: attrs.userRatingCount ?? 0,
  }
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

async function fetchReviews(env: Env): Promise<{ total: number; recent30d: number }> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600_000).toISOString()
  const res = await ascGet(env, `/v1/apps/${env.ASC_APP_ID}/customerReviews?sort=-createdDate&limit=100&fields[customerReviews]=createdDate`)
  if (!res.ok) return { total: 0, recent30d: 0 }
  const json = await res.json<{ data: Array<{ attributes: { createdDate: string } }>; meta?: { paging?: { total?: number } } }>()
  return {
    total: json.meta?.paging?.total ?? 0,
    recent30d: json.data.filter(r => r.attributes.createdDate >= cutoff).length,
  }
}

// ─── Sales report ────────────────────────────────────────────────────────────

async function fetchSalesReport(env: Env, date: string): Promise<{ units: number; proceeds: number }> {
  const params = new URLSearchParams({
    'filter[frequency]': 'DAILY',
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]': env.ASC_VENDOR_NUMBER ?? '',
    'filter[reportDate]': date,
  })
  const jwt = await getAscJwt(env)
  const res = await fetch(`${ASC_BASE}/v1/salesReports?${params}`, {
    headers: { Authorization: `Bearer ${jwt}`, 'Accept-Encoding': 'gzip' },
  })

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '')
    console.log(`[app-store] sales report ${date} status=${res.status}`, errText.slice(0, 200))
    return { units: 0, proceeds: 0 }
  }

  // Response is gzip-compressed TSV; fall back to plain text if decompression fails
  let text: string
  const contentEncoding = res.headers.get('content-encoding') ?? ''
  if (contentEncoding.includes('gzip') || res.headers.get('content-type')?.includes('gzip')) {
    try {
      text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text()
    } catch {
      text = await res.clone().text()
    }
  } else {
    text = await res.text()
  }

  const lines = text.trim().split('\n')
  if (lines.length < 2) {
    console.log(`[app-store] sales report ${date} empty or unparseable, first 200 chars:`, text.slice(0, 200))
    return { units: 0, proceeds: 0 }
  }

  const headers = lines[0].split('\t')
  const unitsIdx = headers.indexOf('Units')
  const proceedsIdx = headers.indexOf('Developer Proceeds')
  console.log(`[app-store] sales report ${date} columns:`, headers.join(', '))

  let units = 0, proceeds = 0
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (unitsIdx >= 0) units += Number(cols[unitsIdx]) || 0
    if (proceedsIdx >= 0) proceeds += Number(cols[proceedsIdx]) || 0
  }
  return { units, proceeds: Math.round(proceeds * 100) / 100 }
}

// ─── Refresh (called by cron) ─────────────────────────────────────────────────

export async function refreshAppStoreData(env: Env): Promise<void> {
  if (!env.ASC_KEY_ID || !env.ASC_ISSUER_ID || !env.ASC_PRIVATE_KEY || !env.ASC_VENDOR_NUMBER || !env.ASC_APP_ID) {
    console.log('[app-store] credentials not configured, skipping')
    return
  }

  // Build the last 7 date strings (newest first)
  const dates: string[] = []
  for (let d = 1; d <= 7; d++) {
    const dt = new Date(Date.now() - d * 86400_000)
    dates.push(dt.toISOString().slice(0, 10))
  }

  const [rating, reviews, ...sales] = await Promise.all([
    fetchRating(env).catch(e => { console.error('[app-store] rating:', e); return { average: 0, count: 0 } }),
    fetchReviews(env).catch(e => { console.error('[app-store] reviews:', e); return { total: 0, recent30d: 0 } }),
    ...dates.map(d => fetchSalesReport(env, d).catch(() => ({ units: 0, proceeds: 0 }))),
  ])

  const yesterday = sales[0]
  const last7d = sales.reduce((acc, r) => ({ units: acc.units + r.units, proceeds: acc.proceeds + r.proceeds }), { units: 0, proceeds: 0 })

  const metrics: AppStoreMetrics = {
    rating,
    reviews,
    downloads: { yesterday: yesterday.units, last7d: last7d.units },
    proceeds: { yesterday: yesterday.proceeds, last7d: Math.round(last7d.proceeds * 100) / 100 },
    lastUpdated: Math.floor(Date.now() / 1000),
  }

  await env.KV.put(CACHE_KEY, JSON.stringify(metrics), { expirationTtl: CACHE_TTL_S })
  console.log('[app-store] refreshed, downloads 7d:', last7d.units, 'proceeds 7d:', last7d.proceeds)
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

export async function handleAppStoreAnalytics(c: Context<{ Bindings: Env }>) {
  const cached = await c.env.KV.get(CACHE_KEY)
  if (!cached) {
    await refreshAppStoreData(c.env)
    const fresh = await c.env.KV.get(CACHE_KEY)
    if (!fresh) return c.json({ error: 'Failed to fetch App Store data' }, 502)
    return c.json(JSON.parse(fresh) as AppStoreMetrics)
  }
  // Serve cached data and refresh in the background if it is older than 1 hour
  const metrics = JSON.parse(cached) as AppStoreMetrics
  if (Date.now() / 1000 - metrics.lastUpdated > 3600) {
    c.executionCtx.waitUntil(refreshAppStoreData(c.env))
  }
  return c.json(metrics)
}
