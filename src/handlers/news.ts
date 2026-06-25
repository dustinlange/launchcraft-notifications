import { Context } from 'hono'
import { Env } from '../index'
import { getRecentArticles, getNewsSites } from '../snapi'
import {
  getUsersForNewsSource,
  getNewsPreferences,
  upsertNewsPreferences,
  claimArticleForDispatch,
  pruneOldDispatchLog,
  clearDeviceToken,
} from '../db/queries'
import { pushAlertNotification, ApnsConfig } from '../apns'

function getApnsConfig(env: Env): ApnsConfig {
  return {
    privateKeyPem: env.APNS_PRIVATE_KEY,
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    bundleId: env.BUNDLE_ID,
    env: (env.APNS_ENV as 'production' | 'sandbox') ?? 'production',
  }
}

export async function dispatchNewsNotifications(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  // Prune old dispatch log once per hour
  if (now % 3600 < 300) {
    await pruneOldDispatchLog(env.DB)
  }

  const since = new Date(Date.now() - 30 * 60 * 1000)  // 30-min window — catches SNAPI indexing delays without processing too many articles
  let articles
  try {
    articles = await getRecentArticles(since)
  } catch (err) {
    console.error('dispatchNewsNotifications: failed to fetch articles', err)
    return
  }

  if (articles.length === 0) return

  // Pre-filter articles already in the dispatch log with a single bulk query.
  // Avoids 50 individual INSERT OR IGNORE attempts when most articles are already dispatched.
  const ids = articles.map(a => a.id)
  const placeholders = ids.map(() => '?').join(', ')
  const { results: alreadyDispatched } = await env.DB.prepare(
    `SELECT article_id FROM news_dispatch_log WHERE article_id IN (${placeholders})`
  ).bind(...ids).all<{ article_id: number }>()
  const dispatchedSet = new Set(alreadyDispatched.map(r => r.article_id))
  const newArticles = articles.filter(a => !dispatchedSet.has(a.id))

  if (newArticles.length === 0) return

  const apnsConfig = getApnsConfig(env)

  for (const article of newArticles) {
    // Atomically claim — guards against concurrent Worker instances
    const claimed = await claimArticleForDispatch(env.DB, article.id)
    if (!claimed) continue

    let usersResult
    try {
      usersResult = await getUsersForNewsSource(env.DB, article.news_site)
    } catch (err) {
      console.error(`dispatchNewsNotifications: failed to get users for source ${article.news_site}`, err)
      continue
    }

    const users = usersResult.results
    if (users.length === 0) continue

    await Promise.allSettled(
      users.map(async u => {
        const result = await pushAlertNotification(env.KV, apnsConfig, u.device_token, {
          title: article.news_site,
          body: article.authors?.length
            ? `${article.title} | ${article.authors[0].name}`
            : article.title,
          launchId: '',
          type: 'news',
          articleUrl: article.url,
          imageUrl: article.image_url ?? undefined,
        })
        if (!result.ok && (result.status === 410 || result.status === 400)) {
          console.warn(`Clearing stale device token for ${u.user_id} after APNs ${result.status}`)
          await clearDeviceToken(env.DB, u.user_id, u.device_token)
        }
      })
    )
  }
}

// GET /news-sources
export async function handleGetNewsSources(c: Context<{ Bindings: Env }>) {
  try {
    const sources = await getNewsSites()
    return c.json({ sources })
  } catch (err) {
    console.error('handleGetNewsSources error', err)
    return c.json({ error: 'failed to fetch news sources' }, 502)
  }
}

// GET /news-preferences?userId=<id>
export async function handleGetNewsPreferences(c: Context<{ Bindings: Env }>) {
  const userId = c.req.query('userId')
  if (!userId) return c.json({ error: 'missing userId' }, 400)

  const prefs = await getNewsPreferences(c.env.DB, userId)
  return c.json(prefs)
}

// POST /news-preferences
export async function handleSaveNewsPreferences(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ userId: string; enabled: boolean; sources: string[] }>()
  if (!body.userId) return c.json({ error: 'missing userId' }, 400)

  await upsertNewsPreferences(c.env.DB, body.userId, body.enabled, body.sources ?? [])
  return c.json({ ok: true })
}
