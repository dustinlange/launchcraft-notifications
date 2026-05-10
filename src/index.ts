import { Hono } from 'hono'
import { handleRegister, handleActivityToken, handleDeviceToken, handlePushToStartToken, handleGetSubscriptions, handleUnsubscribe, handleGetProviderSubscriptions, handleSubscribeToProvider, handleUnsubscribeFromProvider, handleGetLocationSubscriptions, handleSubscribeToLocation, handleUnsubscribeFromLocation, handleGetSectionSubscription, handleSubscribeToSection, handleUnsubscribeFromSection } from './handlers/register'
import { handleWebhook } from './handlers/webhook'
import { dispatchTimelineEvents } from './handlers/timeline'
import { pollNoTimelineLaunches } from './handlers/poller'
import { pollLL2 } from './handlers/ll2-poller'
import { dispatchActivityStarts, dispatchActivityEnds } from './handlers/activity-lifecycle'
import { dispatchReminders } from './handlers/reminders'
import { handleGetPreferences, handleSavePreferences } from './handlers/preferences'
import { handleStartup } from './handlers/startup'
import { handleTestTrigger } from './handlers/test'

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
  API_KEY: string
  API_KEY_PREVIOUS?: string  // kept during key rotation so old app versions keep working
}

const app = new Hono<{ Bindings: Env }>()

// Require X-API-Key on all routes except /webhook (has its own secret) and /health.
// API_KEY_PREVIOUS is accepted during key rotation so old app versions keep working
// while a new app build with the updated key rolls out.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (path === '/webhook' || path === '/health') return next()

  const key = c.req.header('X-API-Key')
  const validKeys = [c.env.API_KEY, c.env.API_KEY_PREVIOUS].filter(Boolean)
  if (!key || !validKeys.includes(key)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return next()
})

app.get('/subscriptions', handleGetSubscriptions)
app.post('/register', handleRegister)
app.delete('/subscription', handleUnsubscribe)
app.post('/activity-token', handleActivityToken)
app.post('/device-token', handleDeviceToken)
app.post('/push-to-start-token', handlePushToStartToken)
app.post('/webhook', handleWebhook)

app.get('/preferences', handleGetPreferences)
app.post('/preferences', handleSavePreferences)

app.get('/provider-subscriptions', handleGetProviderSubscriptions)
app.post('/provider-subscription', handleSubscribeToProvider)
app.delete('/provider-subscription', handleUnsubscribeFromProvider)

app.get('/location-subscriptions', handleGetLocationSubscriptions)
app.post('/location-subscription', handleSubscribeToLocation)
app.delete('/location-subscription', handleUnsubscribeFromLocation)

app.get('/section-subscription', handleGetSectionSubscription)
app.post('/section-subscription', handleSubscribeToSection)
app.delete('/section-subscription', handleUnsubscribeFromSection)

app.get('/startup', handleStartup)
app.post('/test/trigger', handleTestTrigger)
app.get('/health', (c) => c.json({ ok: true }))

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const now = Math.floor(Date.now() / 1000)

    // Every minute
    ctx.waitUntil(dispatchTimelineEvents(env))
    ctx.waitUntil(dispatchActivityStarts(env))
    ctx.waitUntil(dispatchActivityEnds(env))
    ctx.waitUntil(dispatchReminders(env))

    // Every 5 minutes
    if (now % 300 < 60) {
      ctx.waitUntil(pollLL2(env))
      ctx.waitUntil(pollNoTimelineLaunches(env))
    }
  },
}
