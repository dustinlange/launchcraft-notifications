import { Context } from 'hono'
import { Env } from '../index'
import { getLaunch } from '../db/queries'

// Matches LL2's own timestamp format (no fractional seconds) — the iOS
// client parses these dates with a plain ISO8601DateFormatter (no
// .withFractionalSeconds option) shared with LL2 date parsing, which fails
// silently on Date.toISOString()'s default ".SSS" milliseconds suffix.
function toLL2ISOString(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// GET /launch-extras?launchId=<id>
// Supplemental per-launch data the app needs alongside the LL2 launch
// object but that only this backend knows (currently just the most recent
// NET change; more fields can be added here over time as flat top-level
// keys without needing a new endpoint).
export async function handleGetLaunchExtras(c: Context<{ Bindings: Env }>) {
  const launchId = c.req.query('launchId')
  if (!launchId) return c.json({ error: 'missing launchId' }, 400)

  const launch = await getLaunch(c.env.DB, launchId)
  const netChange = (launch?.previous_t0 != null && launch?.net_changed_at != null)
    ? {
        previousNet: toLL2ISOString(launch.previous_t0),
        changedAt: toLL2ISOString(launch.net_changed_at),
      }
    : null

  return c.json({ netChange })
}
