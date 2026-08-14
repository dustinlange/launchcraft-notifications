import { Context } from 'hono'
import { Env } from '../index'

const ACTIVE_USER_WINDOW_S = 30 * 24 * 3600  // fixed per product decision — not caller-configurable
const DEFAULT_NOTIFICATION_WINDOW_DAYS = 30

// GET /admin/metrics?days=N
// Admin-only aggregate stats for the MissionControl companion app. Auth'd by X-Admin-API-Key
// (separate secret from the client-facing X-API-Key), see middleware in index.ts.
export async function handleAdminMetrics(c: Context<{ Bindings: Env }>) {
  const db = c.env.DB
  const now = Math.floor(Date.now() / 1000)

  const daysParam = Number(c.req.query('days'))
  const notificationWindowDays = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : DEFAULT_NOTIFICATION_WINDOW_DAYS
  const notificationWindowStart = now - notificationWindowDays * 24 * 3600
  const activeUserWindowStart = now - ACTIVE_USER_WINDOW_S

  const [
    feedCountRow,
    feedUserCountRow,
    activeUsersRow,
    pushToStartUsersRow,
    liveActivityRunningRow,
    notificationTotalRow,
    notificationByTypeResult,
    proSubscribersRow,
  ] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM feed_subscriptions').first<{ n: number }>(),
    db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM feed_subscriptions').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM user_devices WHERE updated_at > ?').bind(activeUserWindowStart).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM user_devices WHERE push_to_start_token IS NOT NULL').first<{ n: number }>(),
    db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM launch_subscriptions WHERE activity_token IS NOT NULL').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM notification_log WHERE sent_at > ?').bind(notificationWindowStart).first<{ n: number }>(),
    db.prepare(`
      SELECT type, COUNT(*) AS n
      FROM notification_log
      WHERE sent_at > ?
      GROUP BY type
      ORDER BY n DESC
    `).bind(notificationWindowStart).all<{ type: string; n: number }>(),
    db.prepare('SELECT COUNT(DISTINCT original_transaction_id) AS n FROM user_devices WHERE pro_active = 1 AND original_transaction_id IS NOT NULL').first<{ n: number }>(),
  ])

  const totalFeeds = feedCountRow?.n ?? 0
  const feedUserCount = feedUserCountRow?.n ?? 0
  // "Avg feeds per user" is computed against users who have at least one feed subscription
  // (not all registered devices) — dividing by every registered device would understate the
  // number for anyone who never configured a feed, which isn't what "per user" implies here.
  const avgFeedsPerUser = feedUserCount > 0 ? totalFeeds / feedUserCount : 0

  return c.json({
    totalFeeds,
    avgFeedsPerUser: Math.round(avgFeedsPerUser * 100) / 100,
    activeUsers: {
      count: activeUsersRow?.n ?? 0,
      windowDays: ACTIVE_USER_WINDOW_S / 86400,
    },
    liveActivityUsers: {
      everEnabled: pushToStartUsersRow?.n ?? 0,   // push_to_start_token IS NOT NULL
      currentlyRunning: liveActivityRunningRow?.n ?? 0,  // has an active_token right now
    },
    pushNotificationsSent: {
      total: notificationTotalRow?.n ?? 0,
      byType: Object.fromEntries(notificationByTypeResult.results.map(r => [r.type, r.n])),
      windowDays: notificationWindowDays,
    },
    proSubscribers: proSubscribersRow?.n ?? 0,
  })
}
