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
import { handleArticleExtract } from './handlers/article-extract'
import { dispatchEventNotifications } from './handlers/events-notifications'
import { pollAstronauts } from './handlers/astronauts-poller'
import { handleLL2Proxy } from './handlers/ll2-proxy'
import { handleSNAPIProxy } from './handlers/snapi-proxy'
import { handleProStatus } from './handlers/pro-status'
import { handleGetFeedTemplates } from './handlers/feed-templates'
import { handleAppStoreNotification } from './handlers/appstore-notifications'
import { handleAdminMetrics } from './handlers/admin-metrics'
import { handleAppStoreAnalytics, refreshAppStoreData } from './handlers/app-store-analytics'
import { handleGetWhatsNew, handleGetWhatsNewVersions, handleListVersions, handleCreateVersion, handleDeleteVersion, handleListItems, handleCreateItem, handleUpdateItem, handleDeleteItem } from './handlers/whats-new'

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
  ADMIN_API_KEY: string      // separate secret — gates /admin/* routes only, used by MissionControl
  HEALTHCHECK_URL?: string   // dead man's switch — ping URL from healthchecks.io
  ERROR_WEBHOOK_URL?: string // webhook to call when the cron handler throws (e.g. CPU limit)
  ASC_KEY_ID?: string        // App Store Connect API key ID (10-char)
  ASC_ISSUER_ID?: string     // App Store Connect issuer ID (UUID)
  ASC_PRIVATE_KEY?: string   // App Store Connect .p8 private key contents
  ASC_VENDOR_NUMBER?: string // App Store Connect vendor number (for sales reports)
  ASC_APP_ID?: string        // Numeric app ID from App Store Connect
}

const app = new Hono<{ Bindings: Env }>()

// Require X-API-Key on all routes except:
// - /webhook (has its own HMAC secret)
// - /health (public liveness check)
// - /appstore-notification (Apple calls this directly — verified by JWS signature instead)
// - /admin/* (gated separately below by X-Admin-API-Key instead)
// API_KEY_PREVIOUS is accepted during key rotation so old app versions keep working
// while a new app build with the updated key rolls out.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (path === '/webhook' || path === '/health' || path === '/appstore-notification' || path.startsWith('/admin/')) return next()

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

app.get('/feed-templates', handleGetFeedTemplates)
app.get('/news-sources', handleGetNewsSources)
app.get('/article-extract', handleArticleExtract)
app.get('/whats-new', handleGetWhatsNew)
app.get('/whats-new/versions', handleGetWhatsNewVersions)


app.post('/pro-status', handleProStatus)
app.post('/appstore-notification', handleAppStoreNotification)

app.get('/startup', handleStartup)

// LL2 proxy — transparent pass-through with KV caching
// Maps /ll2/* → https://ll.thespacedevs.com/2.2.0/*
app.get('/ll2/*', handleLL2Proxy)

// SNAPI proxy — transparent pass-through with KV caching
// Maps /snapi/* → https://api.spaceflightnewsapi.net/v4/*
app.get('/snapi/*', handleSNAPIProxy)
app.post('/test/trigger', handleTestTrigger)
app.get('/health', (c) => c.json({ ok: true }))

// Admin routes — gated by a dedicated X-Admin-API-Key secret, separate from the
// client-facing X-API-Key above, so MissionControl's key can be rotated/scoped independently.
app.use('/admin/*', async (c, next) => {
  const key = c.req.header('X-Admin-API-Key')
  if (!key || key !== c.env.ADMIN_API_KEY) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return next()
})
app.get('/admin/metrics', handleAdminMetrics)
app.get('/admin/app-store', handleAppStoreAnalytics)

app.get('/admin/whats-new/versions', handleListVersions)
app.post('/admin/whats-new/versions', handleCreateVersion)
app.delete('/admin/whats-new/versions/:id', handleDeleteVersion)
app.get('/admin/whats-new/versions/:id/items', handleListItems)
app.post('/admin/whats-new/versions/:id/items', handleCreateItem)
app.put('/admin/whats-new/items/:itemId', handleUpdateItem)
app.delete('/admin/whats-new/items/:itemId', handleDeleteItem)

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Top-level catch: if anything throws (CPU limit, unhandled rejection, etc.)
    // ping the error webhook so you get alerted immediately.
    try {
    const now = Math.floor(Date.now() / 1000)

    // ─── Every minute (only truly time-sensitive tasks) ──────────────────────
    // Timeline events and reminders need per-minute precision.
    // Everything else is staggered below to reduce per-invocation D1 query count.
    ctx.waitUntil(dispatchTimelineEvents(env))
    ctx.waitUntil(
      prefetchNearT0Launches(env)
        .catch(err => console.error('[prefetch] failed, reminders will still run:', err))
        .then(() => dispatchReminders(env))
    )

    // ─── Every 2 minutes ─────────────────────────────────────────────────────
    // Activity starts: push-to-start fires up to 1h before launch; 2-min granularity is fine.
    if (now % 120 < 60) {
      ctx.waitUntil(dispatchActivityStarts(env))
    }

    // ─── Every 5 minutes, spread across 4 separate minute offsets ────────────
    // Minute :00 — LL2 poll (bulk fetch, skip-if-unchanged, fan-out for new/changed only)
    if (now % 300 < 60) {
      ctx.waitUntil(pollLL2(env))
      ctx.waitUntil(pollNoTimelineLaunches(env))
    }
    // Minute :01 — news + events dispatch
    if (now % 300 >= 60 && now % 300 < 120) {
      ctx.waitUntil(dispatchNewsNotifications(env))
      ctx.waitUntil(dispatchEventNotifications(env))
    }
    // Minute :02 — activity ends + silent push-to-start failure detection
    // (neither is time-critical to the minute; 5-min granularity is fine)
    if (now % 300 >= 120 && now % 300 < 180) {
      ctx.waitUntil(dispatchActivityEnds(env))
      ctx.waitUntil(detectSilentPushToStartFailures(env))
    }

    // ─── Every 15 minutes, offset to minute :03 ──────────────────────────────
    if (now % 900 >= 180 && now % 900 < 240) {
      ctx.waitUntil(pollAstronauts(env))
    }

    // ─── Every hour, offset to minute :05 ────────────────────────────────────
    if (now % 3600 >= 300 && now % 3600 < 360) {
      ctx.waitUntil(refreshAppStoreData(env).catch(err => console.error('[app-store] refresh failed:', err)))
    }

    // Dead man's switch — ping healthchecks.io so we get alerted if the cron stops firing
    if (env.HEALTHCHECK_URL) {
      ctx.waitUntil(fetch(env.HEALTHCHECK_URL).catch(() => {}))
    }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[cron] unhandled error:', message)
      if (env.ERROR_WEBHOOK_URL) {
        ctx.waitUntil(
          fetch(env.ERROR_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: `🚨 Launchcraft cron error: ${message}`,
              timestamp: new Date().toISOString(),
            }),
          }).catch(() => {})
        )
      }
    }
  },
}
