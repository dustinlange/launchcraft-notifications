import { Env } from '../index'
import { getAllDueReminders, markReminderSent, clearDeviceToken, logNotification } from '../db/queries'
import { pushAlertNotification } from '../apns'
import { getApnsConfig } from './webhook'

const WINDOW_COPY: Record<'24h' | '1h' | '10m', { title: string; body: (name: string) => string }> = {
  '24h': { title: 'Launch in 24 hours!', body: name => `${name} is launching in 24 hours!` },
  '1h':  { title: 'Launch in 1 hour!',   body: name => `${name} is launching in 1 hour!` },
  '10m': { title: 'Launch in 10 minutes!', body: name => `${name} is launching in 10 minutes!` },
}

// Runs every minute via cron — sends pre-launch reminder push notifications.
// Uses a single UNION ALL query to fetch all three reminder windows in one D1 round-trip
// instead of three separate queries.
export async function dispatchReminders(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  const { results: subs } = await getAllDueReminders(env.DB, now)
  if (subs.length === 0) return

  const apnsConfig = getApnsConfig(env)

  await Promise.allSettled(subs.map(async (sub) => {
    const copy = WINDOW_COPY[sub.window_label]
    const result = await pushAlertNotification(env.KV, apnsConfig, sub.device_token, {
      title: copy.title,
      body: copy.body(sub.launch_name),
      launchId: sub.launch_id,
      type: 'reminder',
      imageUrl: sub.image_url ?? sub.rocket_image_url ?? undefined,
    })

    await logNotification(env.DB, 'reminder', sub.user_id, result.ok)

    if (result.ok) {
      await markReminderSent(env.DB, sub.id, sub.window_label)
    } else {
      console.error(`reminder ${sub.window_label} failed for ${sub.launch_id}/${sub.user_id}: ${result.status} ${result.body}`)
      if (result.status === 410 || result.status === 400) {
        console.warn(`Clearing stale device token for ${sub.user_id} after APNs ${result.status}`)
        await clearDeviceToken(env.DB, sub.user_id, sub.device_token)
      }
    }
  }))
}
