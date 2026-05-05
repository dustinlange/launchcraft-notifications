import { Env } from '../index'
import { getSubscriptionsNeedingReminder, markReminderSent } from '../db/queries'
import { pushAlertNotification } from '../apns'
import { getApnsConfig } from './webhook'

interface ReminderWindow {
  label: '24h' | '1h' | '10m'
  offsetS: number     // seconds before T-0
  toleranceS: number  // how wide a window to catch (slightly wider than cron interval)
  title: (name: string) => string
  body: (name: string) => string
}

const WINDOWS: ReminderWindow[] = [
  {
    label: '24h',
    offsetS: 24 * 60 * 60,
    toleranceS: 90,
    title: (name) => `${name}`,
    body: () => 'Launching in 24 hours',
  },
  {
    label: '1h',
    offsetS: 60 * 60,
    toleranceS: 90,
    title: (name) => `${name}`,
    body: () => 'Launching in 1 hour',
  },
  {
    label: '10m',
    offsetS: 10 * 60,
    toleranceS: 90,
    title: (name) => `${name}`,
    body: () => 'Launching in 10 minutes',
  },
]

// Runs every minute via cron — sends pre-launch reminder push notifications
export async function dispatchReminders(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  const apnsConfig = getApnsConfig(env)

  await Promise.allSettled(WINDOWS.map(async (window) => {
    // We want launches whose T-0 falls in [now + offset, now + offset + tolerance]
    const fromT0 = now + window.offsetS
    const toT0 = now + window.offsetS + window.toleranceS

    const { results: subs } = await getSubscriptionsNeedingReminder(env.DB, window.label, fromT0, toT0)
    if (subs.length === 0) return

    await Promise.allSettled(subs.map(async (sub) => {
      const result = await pushAlertNotification(env.KV, apnsConfig, sub.device_token, {
        title: window.title(sub.launch_name),
        body: window.body(sub.launch_name),
        launchId: sub.launch_id,
        type: 'reminder',
      })

      if (result.ok) {
        await markReminderSent(env.DB, sub.id, window.label)
      } else {
        console.error(`reminder ${window.label} failed for ${sub.launch_id}/${sub.user_id}: ${result.status} ${result.body}`)
      }
    }))
  }))
}
