import { Hono } from 'hono'
import { handleRegister, handleActivityToken, handlePushToStartToken } from './handlers/register'
import { handleWebhook } from './handlers/webhook'
import { dispatchTimelineEvents } from './handlers/timeline'
import { pollNoTimelineLaunches } from './handlers/poller'
import { pollLL2 } from './handlers/ll2-poller'
import { dispatchActivityStarts, dispatchActivityEnds } from './handlers/activity-lifecycle'

export interface Env {
  DB: D1Database
  KV: KVNamespace
  // Secrets — set via: wrangler secret put <NAME>
  APNS_PRIVATE_KEY: string
  APNS_KEY_ID: string
  APNS_TEAM_ID: string
  BUNDLE_ID: string
  APNS_ENV: string       // "production" | "sandbox"
  WEBHOOK_SECRET: string
  LL2_API_KEY: string
}

const app = new Hono<{ Bindings: Env }>()

app.post('/register', handleRegister)
app.post('/activity-token', handleActivityToken)
app.post('/push-to-start-token', handlePushToStartToken)
app.post('/webhook', handleWebhook)

app.get('/health', (c) => c.json({ ok: true }))

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const now = Math.floor(Date.now() / 1000)

    // Every minute
    ctx.waitUntil(dispatchTimelineEvents(env))
    ctx.waitUntil(dispatchActivityStarts(env))
    ctx.waitUntil(dispatchActivityEnds(env))

    // Every 5 minutes
    if (now % 300 < 60) {
      ctx.waitUntil(pollLL2(env))
      ctx.waitUntil(pollNoTimelineLaunches(env))
    }
  },
}
