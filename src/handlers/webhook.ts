import { Context } from 'hono'
import { Env } from '../index'
import { getLaunch, upsertLaunch, upsertTimelineEvents, getSubscriptionsForLaunch, markSuccessAt, TERMINAL_IDS, LL2_STATUS, clearDeviceToken } from '../db/queries'
import { pushAlertNotification } from '../apns'
import { pushLiveActivityUpdateAndClearOnFailure } from '../liveActivityPush'

// POST /webhook
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
    timeline?: Array<{ label: string; t_offset_s: number }>
  }>()

  const prev = await getLaunch(c.env.DB, body.id)
  const hasTimeline = !!(body.timeline && body.timeline.length > 0)

  await upsertLaunch(c.env.DB, {
    id: body.id, name: body.name, rocket: body.rocket, pad: body.pad,
    pad_location: null,
    pad_location_id: null,
    provider: null,
    provider_id: null,
    t0: body.t0 ?? null,
    window_start: body.windowStart ?? null,
    window_end: body.windowEnd ?? null,
    ll2_status_id: body.ll2StatusId,
    has_timeline: hasTimeline ? 1 : 0,
    webcast_live: null,
    success_at: null,
    end_dispatched: 0,
  })

  if (hasTimeline && body.t0 && body.timeline) {
    await upsertTimelineEvents(c.env.DB, body.id, body.timeline, body.t0)
  }

  if (TERMINAL_IDS.includes(body.ll2StatusId as any)) {
    await markSuccessAt(c.env.DB, body.id, Math.floor(Date.now() / 1000))
  }

  if (!prev) return c.json({ ok: true })

  const statusChanged = prev.ll2_status_id !== body.ll2StatusId
  const t0Changed = prev.t0 !== body.t0
  const isTerminal = TERMINAL_IDS.includes(body.ll2StatusId as any)

  if (!statusChanged && !t0Changed) return c.json({ ok: true })

  const apnsConfig = getApnsConfig(c.env)
  const { results: subs } = await getSubscriptionsForLaunch(c.env.DB, body.id)

  await Promise.allSettled(subs.map(async (sub) => {
    if (sub.activity_token) {
      await pushLiveActivityUpdateAndClearOnFailure(c.env.DB, c.env.KV, apnsConfig, sub.id, sub.activity_token, {
        event: isTerminal ? 'end' : 'update',
        contentState: {
          netDate: body.t0,
          windowStart: body.windowStart ?? null,
          windowEnd: body.windowEnd ?? null,
          currentEventName: null,
          currentEventDate: null,
          nextEventName: null,
          nextEventDate: null,
          statusId: body.ll2StatusId,
          isWebcastLive: false,
        },
        alertTitle: statusChanged ? `${body.name}: ${statusLabel(body.ll2StatusId)}` : undefined,
        alertBody: t0Changed && body.t0 ? `Launch window updated` : undefined,
        dismissalDate: isTerminal ? Math.floor(Date.now() / 1000) + 60 * 30 : undefined,
      })
    }

    const wantsTerminal    = sub.notify_terminal_status !== 0  // NULL → default on
    const wantsStatusChange = sub.notify_status_change === 1   // NULL → default off
    const wantsNetChange    = sub.notify_net_change    === 1   // NULL → default off

    const launchImageUrl = sub.image_url ?? sub.rocket_image_url ?? undefined

    const handleStaleToken = async (result: { ok: boolean; status: number }) => {
      if (!result.ok && (result.status === 410 || result.status === 400)) {
        console.warn(`Clearing stale device token for ${sub.user_id} after APNs ${result.status}`)
        await clearDeviceToken(c.env.DB, sub.user_id, sub.device_token)
      }
    }

    if (statusChanged && (isTerminal ? wantsTerminal : wantsStatusChange)) {
      const result = await pushAlertNotification(c.env.KV, apnsConfig, sub.device_token, {
        title: 'Status Changed',
        body: isTerminal
          ? statusBody(body.ll2StatusId, body.name, body.rocket)
          : `${body.name} status has changed from ${statusLabel(prev.ll2_status_id)} to ${statusLabel(body.ll2StatusId)}`,
        launchId: body.id,
        type: 'status_change',
        imageUrl: launchImageUrl,
      })
      await handleStaleToken(result)
    } else if (t0Changed && body.t0 && wantsNetChange) {
      const result = await pushAlertNotification(c.env.KV, apnsConfig, sub.device_token, {
        title: 'Schedule Changed',
        body: new Date(body.t0 * 1000).toUTCString(),
        launchId: body.id,
        type: 'schedule_change',
        t0: body.t0,
        launchName: body.name,
        imageUrl: launchImageUrl,
      })
      await handleStaleToken(result)
    }
  }))

  return c.json({ ok: true })
}

function statusLabel(id: number): string {
  const m: Record<number, string> = {
    [LL2_STATUS.GO]:              'Go for Launch',
    [LL2_STATUS.TBD]:             'Status: TBD',
    [LL2_STATUS.TBC]:             'Status: TBC',
    [LL2_STATUS.HOLD]:            'Launch Hold',
    [LL2_STATUS.IN_FLIGHT]:       'In Flight',
    [LL2_STATUS.SUCCESS]:         'Launch Successful',
    [LL2_STATUS.FAILURE]:         'Launch Failed',
    [LL2_STATUS.PARTIAL_FAILURE]: 'Partial Failure',
  }
  return m[id] ?? `Status ${id}`
}

function statusBody(id: number, name: string, rocket: string): string {
  const m: Record<number, string> = {
    [LL2_STATUS.TBD]:             `${rocket} launch date is to be determined.`,
    [LL2_STATUS.TBC]:             `${rocket} launch date is to be confirmed.`,
    [LL2_STATUS.HOLD]:            `${rocket} is currently on hold.`,
    [LL2_STATUS.SUCCESS]:         `${name} was successful!`,
    [LL2_STATUS.FAILURE]:         `${name} has failed!`,
    [LL2_STATUS.PARTIAL_FAILURE]: `${name} was a partial failure!`,
  }
  return m[id] ?? `Launch status changed.`
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
