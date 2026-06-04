import { Hono } from 'hono'
import { handleRegister, handleActivityToken, handleClearActivityToken, handleDeviceToken, handlePushToStartToken, handleGetSubscriptions, handleUnsubscribe, handleGetProviderSubscriptions, handleSubscribeToProvider, handleUnsubscribeFromProvider, handleGetLocationSubscriptions, handleSubscribeToLocation, handleUnsubscribeFromLocation, handleGetFeedSubscription, handleSubscribeToFeed, handleUnsubscribeFromFeed } from './handlers/register'
import { handleWebhook } from './handlers/webhook'
import { dispatchTimelineEvents } from './handlers/timeline'
import { pollNoTimelineLaunches } from './handlers/poller'
import { pollLL2, prefetchNearT0Launches } from './handlers/ll2-poller'
import { dispatchActivityStarts, dispatchActivityEnds, detectSilentPushToStartFailures } from './handlers/activity-lifecycle'
import { dispatchReminders } from './handlers/reminders'
import { handleGetPreferences, handleSavePreferences } from './handlers/preferences'
import { handleStartup } from './handlers/startup'
import { handleTestTrigger } from './handlers/test'
import { dispatchNewsNotifications, handleGetNewsSources } from './handlers/news'
import { dispatchEventNotifications } from './handlers/events-notifications'
import { pollAstronauts } from './handlers/astronauts-poller'
import { handleLL2Proxy } from './handlers/ll2-proxy'
import { handleSNAPIProxy } from './handlers/snapi-proxy'

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
  HEALTHCHECK_URL?: string   // dead man's switch — ping URL from healthchecks.io
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
app.delete('/activity-token', handleClearActivityToken)
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

app.get('/feed-subscription', handleGetFeedSubscription)
app.post('/feed-subscription', handleSubscribeToFeed)
app.delete('/feed-subscription', handleUnsubscribeFromFeed)

app.get('/news-sources', handleGetNewsSources)

app.get('/startup', handleStartup)

// LL2 proxy — transparent pass-through with KV caching
// Maps /ll2/* → https://ll.thespacedevs.com/2.2.0/*
app.get('/ll2/*', handleLL2Proxy)

// SNAPI proxy — transparent pass-through with KV caching
// Maps /snapi/* → https://api.spaceflightnewsapi.net/v4/*
app.get('/snapi/*', handleSNAPIProxy)
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
    ctx.waitUntil(detectSilentPushToStartFailures(env))
    // Prefetch runs first so that any T-0 changes (and their resetReminderFlags calls) are
    // committed to the DB before reminders are dispatched. A prefetch failure is caught and
    // logged rather than propagated — reminders must still run even if prefetch throws.
    ctx.waitUntil(
      prefetchNearT0Launches(env)
        .catch(err => console.error('[prefetch] failed, reminders will still run:', err))
        .then(() => dispatchReminders(env))
    )

    // Every 5 minutes — heavy tasks spread across consecutive minutes to avoid CPU spikes.
    // Minute 0 of each 5-min block: LL2 poll (50 launches, fan-out, DB writes)
    if (now % 300 < 60) {
      ctx.waitUntil(pollLL2(env))
      ctx.waitUntil(pollNoTimelineLaunches(env))
    }
    // Minute 1 of each 5-min block: news + events dispatch (up to 50 articles, APNs pushes)
    if (now % 300 >= 60 && now % 300 < 120) {
      ctx.waitUntil(dispatchNewsNotifications(env))
      ctx.waitUntil(dispatchEventNotifications(env))
    }

    // Every 15 minutes — offset to minute 2 so it doesn't overlap with LL2 poll
    if (now % 900 >= 120 && now % 900 < 180) {
      ctx.waitUntil(pollAstronauts(env))
    }

    // Dead man's switch — ping healthchecks.io so we get alerted if the cron stops firing
    if (env.HEALTHCHECK_URL) {
      ctx.waitUntil(fetch(env.HEALTHCHECK_URL).catch(() => {}))
    }
  },
}
