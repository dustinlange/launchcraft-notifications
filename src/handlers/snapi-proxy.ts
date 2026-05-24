import { Context } from 'hono'
import { Env } from '../index'

const SNAPI_UPSTREAM = 'https://api.spaceflightnewsapi.net/v4'

// Cache TTLs in seconds, keyed by path prefix
const TTL_BY_PATH: Array<{ prefix: string; ttl: number }> = [
  { prefix: '/info',     ttl: 86400 }, // 24h — news sites list rarely changes
  { prefix: '/articles', ttl: 120  }, // 2 min — article feed updates frequently
  { prefix: '/blogs',    ttl: 120  }, // 2 min
  { prefix: '/reports',  ttl: 120  }, // 2 min
]

function ttlForPath(path: string): number {
  for (const { prefix, ttl } of TTL_BY_PATH) {
    if (path.startsWith(prefix)) return ttl
  }
  return 120 // default 2 min
}

// GET /snapi/*
// Transparent proxy to Spaceflight News API v4 with KV response caching.
// SNAPI requires no authentication — we do not forward the client's X-API-Key.
export async function handleSNAPIProxy(c: Context<{ Bindings: Env }>) {
  const url = new URL(c.req.url)

  // Strip the /snapi prefix to get the path that SNAPI expects
  const snapiPath = url.pathname.replace(/^\/snapi/, '') || '/'
  const queryString = url.search // includes leading '?'

  const cacheKey = `snapi_proxy:${snapiPath}${queryString}`
  const ttl = ttlForPath(snapiPath)

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

  // Cache miss — fetch from SNAPI (no auth required)
  const snapiUrl = `${SNAPI_UPSTREAM}${snapiPath}${queryString}`
  const response = await fetch(snapiUrl, {
    headers: {
      'Accept': 'application/json',
    },
  })

  if (!response.ok) {
    return c.json({ error: `SNAPI responded with ${response.status}` }, response.status as any)
  }

  const body = await response.text()

  // Store in KV — fire and forget
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
