import { Context } from 'hono'
import { Env } from '../index'
import { getLaunch } from '../db/queries'

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
        previousNet: new Date(launch.previous_t0 * 1000).toISOString(),
        changedAt: new Date(launch.net_changed_at * 1000).toISOString(),
      }
    : null

  return c.json({ netChange })
}
