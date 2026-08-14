import { Env } from '../index'
import { createLL2Client } from '../ll2'
import {
  upsertEvent,
  claimEventForDispatch,
  pruneOldEventDispatchLog,
  getUsersForEventType,
  clearDeviceToken,
  logNotification,
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

  // Fetch upcoming events from LL2, with an 11-minute KV cache so consecutive
  // 5-minute cron runs share one LL2 call instead of each making their own.
  const EVENTS_CACHE_KEY = 'll2_events_cache'
  const EVENTS_CACHE_TTL_S = 11 * 60

  let ll2Events: Array<{
    id: number
    name: string
    type: { id: number; name: string } | null
    description: string | null
    location: string | null
    date: string | null
    feature_image: string | null
  }>
  try {
    const cached = await env.KV.get(EVENTS_CACHE_KEY, 'text')
    if (cached) {
      ll2Events = JSON.parse(cached)
    } else {
      const client = createLL2Client(env.LL2_API_KEY)
      ll2Events = await client.getUpcomingEvents(100)
      env.KV.put(EVENTS_CACHE_KEY, JSON.stringify(ll2Events), { expirationTtl: EVENTS_CACHE_TTL_S })
    }
  } catch (err) {
    console.error('dispatchEventNotifications: failed to fetch events from LL2', err)
    return
  }

  // Only upsert events within the next 30 hours — far-future events don't need DB
  // freshness every 5 minutes and their upserts dominate D1 write counts.
  // 30h comfortably covers the 24h reminder window plus a buffer for scheduling drift.
  const upsertCutoffS = now + 30 * 3600
  await Promise.allSettled(
    ll2Events
      .filter(e => {
        if (!e.date) return false
        const ts = Math.floor(new Date(e.date).getTime() / 1000)
        return ts > now && ts <= upsertCutoffS
      })
      .map(e => upsertEvent(env.DB, {
        id: e.id,
        name: e.name,
        event_type_id: e.type?.id ?? null,
        event_type: e.type?.name ?? null,
        description: e.description,
        location: e.location,
        date: e.date ? Math.floor(new Date(e.date).getTime() / 1000) : null,
        image_url: e.feature_image ?? null,
      }))
  )

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

      // Atomically claim this event/window — skip if another Worker instance beat us to it
      const claimed = await claimEventForDispatch(env.DB, e.id, window.label)
      if (!claimed) continue

      // getUsersForEventType filters by both feed subscription and per-user reminder preference
      const { results: users } = await getUsersForEventType(env.DB, e.type?.id ?? null, window.label)
      if (users.length === 0) continue

      const title = eventTypeTitle(e.type?.name)
      const body = e.location
        ? `${e.name} starting ${window.text} at ${e.location}`
        : `${e.name} starting ${window.text}`

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
          await logNotification(env.DB, 'event', u.user_id, result.ok)
          if (!result.ok && (result.status === 410 || result.status === 400)) {
            console.warn(`Clearing stale device token for ${u.user_id} after APNs ${result.status}`)
            await clearDeviceToken(env.DB, u.user_id, u.device_token)
          }
        })
      )

    }
  }
}

// Returns a display title based on the LL2 event type name:
//   "Flyover"      → "Flyover Event"
//   "Press Event"  → "Press Event"   (no double "Event")
//   "Static Fire"  → "Static Fire"   (no "Event" added — reads naturally without it)
//   null/undefined → "Upcoming Event" (fallback)
//
// Rule: append " Event" only when the type name doesn't already end in "event"
// (case-insensitive) and the name on its own sounds incomplete without it.
// In practice this mostly affects single-word activity types like Flyover, Webcast, etc.
function eventTypeTitle(typeName: string | null | undefined): string {
  if (!typeName) return 'Upcoming Event'
  if (typeName.toLowerCase().endsWith('event')) return typeName
  return `${typeName} Event`
}
