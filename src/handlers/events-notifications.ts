import { Env } from '../index'
import { createLL2Client } from '../ll2'
import {
  upsertEvent,
  isEventDispatched,
  markEventNotificationSent,
  pruneOldEventDispatchLog,
  getUsersForEventType,
  clearDeviceToken,
  EventWindowLabel,
} from '../db/queries'
import { pushAlertNotification, ApnsConfig } from '../apns'
import { getApnsConfig } from './webhook'

export async function dispatchEventNotifications(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  // Prune old dispatch log once per hour
  if (now % 3600 < 300) {
    await pruneOldEventDispatchLog(env.DB)
  }

  // Fetch upcoming events from LL2
  let ll2Events: Array<{
    id: number
    name: string
    type: { id: number; name: string } | null
    description: string | null
    location: string | null
    date: string | null
  }>
  try {
    const client = createLL2Client(env.LL2_API_KEY)
    ll2Events = await client.getUpcomingEvents(100)
  } catch (err) {
    console.error('dispatchEventNotifications: failed to fetch events from LL2', err)
    return
  }

  // Upsert all events so we have fresh dates and images
  await Promise.allSettled(ll2Events.map(e => upsertEvent(env.DB, {
    id: e.id,
    name: e.name,
    event_type_id: e.type?.id ?? null,
    event_type: e.type?.name ?? null,
    description: e.description,
    location: e.location,
    date: e.date ? Math.floor(new Date(e.date).getTime() / 1000) : null,
    image_url: e.feature_image ?? null,
  })))

  const apnsConfig = getApnsConfig(env)

  // Check each upcoming event for 24h, 1h, and 10m notification windows
  for (const e of ll2Events) {
    if (!e.date) continue
    const eventTs = Math.floor(new Date(e.date).getTime() / 1000)
    if (eventTs <= now) continue  // already passed

    const timeUntil = eventTs - now

    const windows: Array<{ label: EventWindowLabel; fromS: number; toS: number; text: string }> = [
      { label: '24h', fromS: 23 * 3600, toS: 25 * 3600, text: 'in about 24 hours' },
      { label: '1h',  fromS: 50 * 60,   toS: 70 * 60,   text: 'in about 1 hour' },
      { label: '10m', fromS: 5 * 60,    toS: 15 * 60,   text: 'in about 10 minutes' },
    ]

    for (const window of windows) {
      if (timeUntil < window.fromS || timeUntil > window.toS) continue

      const alreadySent = await isEventDispatched(env.DB, e.id, window.label)
      if (alreadySent) continue

      // getUsersForEventType filters by both feed subscription and per-user reminder preference
      const { results: users } = await getUsersForEventType(env.DB, e.type?.id ?? null, window.label)
      if (users.length === 0) {
        await markEventNotificationSent(env.DB, e.id, window.label)
        continue
      }

      const title = e.type?.name ? `${e.type.name}: ${e.name}` : e.name
      const body = e.location
        ? `${window.text} at ${e.location}`
        : window.text.charAt(0).toUpperCase() + window.text.slice(1)

      await Promise.allSettled(
        users.map(async u => {
          const result = await pushAlertNotification(env.KV, apnsConfig, u.device_token, {
            title,
            body,
            launchId: '',
            type: 'event_reminder',
            eventId: e.id,
            imageUrl: e.feature_image ?? undefined,
          })
          if (!result.ok && (result.status === 410 || result.status === 400)) {
            console.warn(`Clearing stale device token for ${u.user_id} after APNs ${result.status}`)
            await clearDeviceToken(env.DB, u.user_id, u.device_token)
          }
        })
      )

      await markEventNotificationSent(env.DB, e.id, window.label)
    }
  }
}
