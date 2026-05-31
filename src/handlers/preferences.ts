import { Context } from 'hono'
import { Env } from '../index'
import { getUserPreferences, upsertUserPreferences } from '../db/queries'

// GET /preferences?userId=<id>
export async function handleGetPreferences(c: Context<{ Bindings: Env }>) {
  const userId = c.req.query('userId')
  if (!userId) return c.json({ error: 'missing userId' }, 400)

  const prefs = await getUserPreferences(c.env.DB, userId)
  return c.json({
    remind24h:             prefs ? prefs.remind_24h             === 1 : true,
    remind1h:              prefs ? prefs.remind_1h              === 1 : true,
    remind10m:             prefs ? prefs.remind_10m             === 1 : true,
    notifyNetChange:       prefs ? prefs.notify_net_change      === 1 : false,
    notifyStatusChange:    prefs ? prefs.notify_status_change   === 1 : false,
    notifyTerminalStatus:  prefs ? prefs.notify_terminal_status !== 0 : true,
    autoLiveActivity:      prefs ? prefs.auto_live_activity     !== 0 : true,
    liveActivityWindow:    prefs ? prefs.live_activity_window           : 3600,
    eventRemind24h:        prefs ? prefs.event_remind_24h       !== 0 : true,
    eventRemind1h:         prefs ? prefs.event_remind_1h        !== 0 : true,
    eventRemind10m:        prefs ? prefs.event_remind_10m       !== 0 : true,
  })
}

// POST /preferences
export async function handleSavePreferences(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{
    userId: string
    remind24h: boolean
    remind1h: boolean
    remind10m: boolean
    notifyNetChange: boolean
    notifyStatusChange: boolean
    notifyTerminalStatus: boolean
    autoLiveActivity: boolean
    liveActivityWindow: number
    eventRemind24h: boolean
    eventRemind1h: boolean
    eventRemind10m: boolean
  }>()

  const { userId, remind24h, remind1h, remind10m,
          notifyNetChange, notifyStatusChange, notifyTerminalStatus,
          autoLiveActivity, liveActivityWindow,
          eventRemind24h, eventRemind1h, eventRemind10m } = body
  if (!userId) return c.json({ error: 'missing userId' }, 400)

  await upsertUserPreferences(
    c.env.DB, userId,
    remind24h ?? true, remind1h ?? true, remind10m ?? true,
    notifyNetChange ?? false, notifyStatusChange ?? false, notifyTerminalStatus ?? true,
    autoLiveActivity ?? true, liveActivityWindow ?? 3600,
    eventRemind24h ?? true, eventRemind1h ?? true, eventRemind10m ?? true,
  )
  return c.json({ ok: true })
}
