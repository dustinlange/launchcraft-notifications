import { Context } from 'hono'
import { Env } from '../index'
import { getLaunch, upsertLaunch, upsertTimelineEvents, getSubscriptionsForLaunch } from '../db/queries'
import { pushLiveActivityUpdate, pushAlertNotification } from '../apns'

// POST /webhook
// Receives launch data updates from an external source
// Secured with a shared WEBHOOK_SECRET header
export async function handleWebhook(c: Context<{ Bindings: Env }>) {
  const secret = c.req.header('x-webhook-secret')
  if (secret !== c.env.WEBHOOK_SECRET) return c.json({ error: 'unauthorized' }, 401)

  const body = await c.req.json<{
    id: string
    name: string
    rocket: string
    pad: string
    t0: number | null
    windowStart: number | null
    windowEnd: number | null
    ll2StatusId: number
    status: 'go' | 'hold' | 'scrub' | 'success' | 'failure'
    timeline?: Array<{ label: string; t_offset_s: number }>
  }>()

  const prev = await getLaunch(c.env.DB, body.id)
  const hasTimeline = !!(body.timeline && body.timeline.length > 0)

  await upsertLaunch(c.env.DB, {
    id: body.id, name: body.name, rocket: body.rocket, pad: body.pad,
    t0: body.t0 ?? null,
    window_start: body.windowStart ?? null,
    window_end: body.windowEnd ?? null,
    status: body.status,
    ll2_status_id: body.ll2StatusId,
    has_timeline: hasTimeline ? 1 : 0,
  })

  if (hasTimeline && body.t0 && body.timeline) {
    await upsertTimelineEvents(c.env.DB, body.id, body.timeline, body.t0)
  }

  if (!prev) return c.json({ ok: true })

  const statusChanged = prev.status !== body.status
  const t0Changed = prev.t0 !== body.t0
  const isTerminal = body.status === 'success' || body.status === 'failure' || body.status === 'scrub'

  if (!statusChanged && !t0Changed) return c.json({ ok: true })

  const apnsConfig = getApnsConfig(c.env)
  const { results: subs } = await getSubscriptionsForLaunch(c.env.DB, body.id)

  await Promise.allSettled(subs.map(async (sub) => {
    if (sub.activity_token) {
      await pushLiveActivityUpdate(c.env.KV, apnsConfig, sub.activity_token, {
        event: isTerminal ? 'end' : 'update',
        contentState: {
          netDate: body.t0,
          windowStart: body.windowStart ?? null,
          windowEnd: body.windowEnd ?? null,
          currentEventName: null,
          currentEventDate: null,
          statusId: body.ll2StatusId,
        },
        alertTitle: statusChanged ? `${body.name}: ${statusLabel(body.status)}` : undefined,
        alertBody: t0Changed && body.t0 ? `Launch window updated` : undefined,
        dismissalDate: isTerminal ? Math.floor(Date.now() / 1000) + 60 * 30 : undefined,
      })
    }

    if (statusChanged) {
      await pushAlertNotification(c.env.KV, apnsConfig, sub.device_token, {
        title: `${body.name}: ${statusLabel(body.status)}`,
        body: launchStatusBody(body.status, body.rocket),
        launchId: body.id,
        type: 'status_change',
      })
    } else if (t0Changed && body.t0) {
      await pushAlertNotification(c.env.KV, apnsConfig, sub.device_token, {
        title: `${body.name}: Schedule Updated`,
        body: `New launch window: ${new Date(body.t0 * 1000).toUTCString()}`,
        launchId: body.id,
        type: 'schedule_change',
      })
    }
  }))

  return c.json({ ok: true })
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    go: 'Go for Launch', hold: 'Launch Hold', scrub: 'Launch Scrubbed',
    success: 'Launch Successful', failure: 'Launch Failed',
  }
  return labels[status] ?? status
}

function launchStatusBody(status: string, rocket: string): string {
  const bodies: Record<string, string> = {
    hold: `${rocket} is currently on hold.`,
    scrub: `${rocket} has been scrubbed. Check back for rescheduling.`,
    success: `${rocket} has successfully launched!`,
    failure: `${rocket} launch ended in failure.`,
  }
  return bodies[status] ?? `Launch status changed to ${status}.`
}

export function getApnsConfig(env: Env) {
  return {
    privateKeyPem: env.APNS_PRIVATE_KEY,
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    bundleId: env.BUNDLE_ID,
    env: env.APNS_ENV as 'production' | 'sandbox',
  }
}
