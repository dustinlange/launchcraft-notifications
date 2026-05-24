import { Context } from 'hono'
import { Env } from '../index'

const LL2_UPSTREAMS: Record<string, string> = {
  '2.2.0': 'https://ll.thespacedevs.com/2.2.0',
  '2.3.0': 'https://ll.thespacedevs.com/2.3.0',
}
const LL2_DEFAULT_UPSTREAM = 'https://ll.thespacedevs.com/2.3.0'

// Cache TTLs in seconds, keyed by path prefix (after version is stripped)
const TTL_BY_PATH: Array<{ prefix: string; ttl: number }> = [
  { prefix: '/launches/',  ttl: 120  },   // 2 min — launch data changes frequently
  { prefix: '/events/',    ttl: 120  },   // 2 min — events also change frequently
  { prefix: '/agencies/',  ttl: 86400 },  // 24h  — agencies almost never change
  { prefix: '/pads/',      ttl: 86400 },  // 24h  — pads almost never change
  { prefix: '/locations/', ttl: 86400 },  // 24h  — locations almost never change
]

function ttlForPath(path: string): number {
  for (const { prefix, ttl } of TTL_BY_PATH) {
    if (path.startsWith(prefix)) return ttl
  }
  return 120 // default 2 min
}

// GET /ll2/{version}/*  (e.g. /ll2/2.2.0/launch/upcoming/ or /ll2/2.3.0/launches/upcoming/)
// GET /ll2/*            (legacy — no version in path)
//
// Transparent proxy to LL2 with KV response caching.
// - Strips the version segment from the path so it never reaches upstream
// - Applies v2.2.0 compat rewrites (singular → plural resource names)
// - Always forwards to LL2 v2.3.0 upstream
// - Cache key includes the requested version so v2.2.0 and v2.3.0 responses are stored separately
export async function handleLL2Proxy(c: Context<{ Bindings: Env }>) {
  const url = new URL(c.req.url)
  // Strip the /ll2 prefix
  let remainingPath = url.pathname.replace(/^\/ll2/, '')
  const queryString = url.search  // includes leading '?'

  // Extract version if present (e.g. /2.2.0/... or /2.3.0/...)
  const versionMatch = remainingPath.match(/^\/(2\.\d+\.\d+)(\/.*)$/)
  const clientVersion = versionMatch ? versionMatch[1] : null
  let ll2Path = versionMatch ? versionMatch[2] : remainingPath

  // v2.2.0 uses singular resource names; v2.3.0 uses plural.
  // Only rewrite for legacy requests (no version in path) since those are
  // unversioned old clients — forward them to v2.3.0 with plural names.
  // Versioned requests are forwarded as-is to the correct upstream.
  if (!clientVersion) {
    ll2Path = ll2Path
      .replace(/^\/launch\//, '/launches/')
      .replace(/^\/event\//, '/events/')
      .replace(/^\/agency\//, '/agencies/')
      .replace(/^\/pad\//, '/pads/')
  }

  // Cache key includes the client version so v2.2.0/v2.3.0 responses are stored separately
  const cacheKey = `ll2_proxy:${clientVersion ?? 'legacy'}:${ll2Path}${queryString}`
  const ttl = ttlForPath(ll2Path)

  // Check cache
  const cached = await c.env.KV.get(cacheKey, 'text')
  if (cached !== null) {
    return new Response(cached, {
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'HIT',
        'Cache-Control': `public, max-age=${ttl}`,
      },
    })
  }

  // Cache miss — fetch from LL2 using the client's requested version
  const upstream = (clientVersion && LL2_UPSTREAMS[clientVersion]) ?? LL2_DEFAULT_UPSTREAM
  const ll2Url = `${upstream}${ll2Path}${queryString}`
  const response = await fetch(ll2Url, {
    headers: {
      'Authorization': `Token ${c.env.LL2_API_KEY}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    return c.json({ error: `LL2 responded with ${response.status}` }, response.status as any)
  }

  const body = await response.text()

  // Store in KV — fire and forget so we don't block the response
  c.executionCtx.waitUntil(
    c.env.KV.put(cacheKey, body, { expirationTtl: ttl })
  )

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'X-Cache': 'MISS',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  })
}
