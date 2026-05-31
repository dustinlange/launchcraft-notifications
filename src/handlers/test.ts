import { Context } from 'hono'
import { Env } from '../index'
import { backfillAttributesJson } from '../db/queries'

// POST /test/trigger
// Reschedules a launch to T-0 a few minutes from now, inserts tight timeline events,
// and resets all dispatch/reminder flags so the full push sequence plays out in real time.
//
// Only available when APNS_ENV === 'sandbox'. Returns 403 in production.
//
// Body: { launchId: string, userId: string, minutesUntilT0?: number }
//   minutesUntilT0 defaults to 5. Timeline events are spaced every 30 seconds
//   starting at T-2min, giving you time to watch them fire one by one.
export async function handleTestTrigger(c: Context<{ Bindings: Env }>) {
  if (c.env.APNS_ENV !== 'sandbox') {
    return c.json({ error: 'only available in sandbox environment' }, 403)
  }

  const body = await c.req.json<{
    launchId: string
    userId: string
    minutesUntilT0?: number
  }>()

  const { launchId, userId } = body
  const minutesUntilT0 = body.minutesUntilT0 ?? 5

  if (!launchId || !userId) {
    return c.json({ error: 'missing launchId or userId' }, 400)
  }

  const launch = await c.env.DB.prepare('SELECT * FROM launches WHERE id = ?').bind(launchId).first<{ id: string; name: string; mission_name: string | null; rocket: string; provider: string | null; provider_logo_url: string | null; ll2_status_id: number }>()
  if (!launch) return c.json({ error: 'launch not found' }, 404)

  const sub = await c.env.DB.prepare(
    'SELECT * FROM launch_subscriptions WHERE launch_id = ? AND user_id = ?'
  ).bind(launchId, userId).first()
  if (!sub) return c.json({ error: 'subscription not found for this user and launch' }, 404)

  const now = Math.floor(Date.now() / 1000)
  const t0 = now + minutesUntilT0 * 60

  // Timeline events: one every 30 seconds starting at T-2min, spanning T-2min to T+2min
  const offsets = [-120, -90, -60, -30, 0, 30, 60, 90, 120]
  const eventLabels: Record<number, string> = {
    '-120': 'Startup',
    '-90':  'Ignition',
    '-60':  'Max-Q',
    '-30':  'MECO',
    '0':    'Stage Sep',
    '30':   'Fairing Sep',
    '60':   'SES-1',
    '90':   'SECO-1',
    '120':  'Deployment',
  }

  await c.env.DB.batch([
    // Move T-0 to the near future, set status to Go, mark has_timeline
    c.env.DB.prepare(`
      UPDATE launches SET t0 = ?, window_start = ?, window_end = ?,
        ll2_status_id = 1, has_timeline = 1, success_at = NULL, end_dispatched = 0
      WHERE id = ?
    `).bind(t0, t0 - 300, t0 + 300, launchId),

    // Reset dispatch and reminder flags on the subscription
    c.env.DB.prepare(`
      UPDATE launch_subscriptions
      SET start_dispatched = 0, reminded_24h = 1, reminded_1h = 1, reminded_10m = 1
      WHERE launch_id = ? AND user_id = ?
    `).bind(launchId, userId),

    // Clear existing timeline events for this launch
    c.env.DB.prepare('DELETE FROM timeline_events WHERE launch_id = ?').bind(launchId),

    // Insert fresh timeline events with near-future fire_at timestamps
    ...offsets.map(offset =>
      c.env.DB.prepare(`
        INSERT INTO timeline_events (launch_id, label, t_offset_s, fire_at)
        VALUES (?, ?, ?, ?)
      `).bind(launchId, eventLabels[String(offset)], offset, t0 + offset)
    ),
  ])

  // Backfill attributes_json for this subscription if missing (common for fan-out subscriptions)
  await backfillAttributesJson(c.env.DB, launchId, launch.name, launch.mission_name, launch.rocket, launch.provider, launch.provider_logo_url, 1)

  return c.json({
    ok: true,
    launch: launch.name,
    t0: new Date(t0 * 1000).toISOString(),
    timelineEvents: offsets.map(offset => ({
      label: eventLabels[String(offset)],
      fireAt: new Date((t0 + offset) * 1000).toISOString(),
    })),
    note: `push-to-start will fire within 1 min if T-0 <= now+3600 and start_dispatched was reset`,
  })
}
