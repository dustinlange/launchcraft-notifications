import { Context } from 'hono'
import { Env } from '../index'
import { getUserPreferences, upsertUserPreferences } from '../db/queries'

// GET /preferences?userId=<id>
export async function handleGetPreferences(c: Context<{ Bindings: Env }>) {
  const userId = c.req.query('userId')
  if (!userId) return c.json({ error: 'missing userId' }, 400)

  const prefs = await getUserPreferences(c.env.DB, userId)
  return c.json({
    remind24h: prefs ? prefs.remind_24h === 1 : true,
    remind1h:  prefs ? prefs.remind_1h  === 1 : true,
    remind10m: prefs ? prefs.remind_10m === 1 : true,
  })
}

// POST /preferences
export async function handleSavePreferences(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{
    userId: string
    remind24h: boolean
    remind1h: boolean
    remind10m: boolean
  }>()

  const { userId, remind24h, remind1h, remind10m } = body
  if (!userId) return c.json({ error: 'missing userId' }, 400)

  await upsertUserPreferences(c.env.DB, userId, remind24h ?? true, remind1h ?? true, remind10m ?? true)
  return c.json({ ok: true })
}
