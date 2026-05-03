import { Context } from 'hono'
import { Env } from '../index'
import { getLaunch, upsertLaunch, upsertSubscription, updateActivityToken, upsertTimelineEvents } from '../db/queries'
import { syncLaunchById } from './ll2-poller'

// POST /register
// Called when user subscribes to a launch in the app
export async function handleRegister(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{
    userId: string
    deviceToken: string
    launch: {
      id: string
      name: string
      rocket: string
      pad: string
      t0: number | null
      status: 'go' | 'hold' | 'scrub' | 'success' | 'failure'
      timeline?: Array<{ label: string; t_offset_s: number }>
    }
  }>()

  const { userId, deviceToken, launch } = body
  if (!userId || !deviceToken || !launch?.id) {
    return c.json({ error: 'missing required fields' }, 400)
  }

  const hasTimeline = !!(launch.timeline && launch.timeline.length > 0)

  await upsertLaunch(c.env.DB, {
    id: launch.id,
    name: launch.name,
    rocket: launch.rocket,
    pad: launch.pad,
    t0: launch.t0 ?? null,
    window_start: null,
    window_end: null,
    status: launch.status,
    ll2_status_id: 1,
    has_timeline: hasTimeline ? 1 : 0,
  })

  if (hasTimeline && launch.t0 && launch.timeline) {
    await upsertTimelineEvents(c.env.DB, launch.id, launch.timeline, launch.t0)
  }

  await upsertSubscription(c.env.DB, {
    launch_id: launch.id,
    device_token: deviceToken,
    user_id: userId,
  })

  // Immediately sync from LL2 so the DB has fresh data without waiting for the next poll
  c.executionCtx.waitUntil(syncLaunchById(c.env, launch.id))

  return c.json({ ok: true })
}

// POST /activity-token
// Called after the app starts a Live Activity and receives its push token
export async function handleActivityToken(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{
    userId: string
    launchId: string
    activityToken: string
    activityId: string
  }>()

  const { userId, launchId, activityToken, activityId } = body
  if (!userId || !launchId || !activityToken || !activityId) {
    return c.json({ error: 'missing required fields' }, 400)
  }

  const launch = await getLaunch(c.env.DB, launchId)
  if (!launch) return c.json({ error: 'launch not found' }, 404)

  await updateActivityToken(c.env.DB, userId, launchId, activityToken, activityId)

  return c.json({ ok: true })
}
