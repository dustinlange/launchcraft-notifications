import { Context } from 'hono'
import { Env } from '../index'
import {
  getActiveSubscriptionsForUser,
  getUserPreferences,
  getProviderSubscriptionsForUser,
  getLocationSubscriptionsForUser,
  getNewsPreferences,
} from '../db/queries'

// GET /startup?userId=<id>
// Returns everything the app needs on launch in a single round trip.
export async function handleStartup(c: Context<{ Bindings: Env }>) {
  const userId = c.req.query('userId')
  if (!userId) return c.json({ error: 'missing userId' }, 400)

  const [subsResult, prefs, providerResult, locationResult, newsPrefs] = await Promise.all([
    getActiveSubscriptionsForUser(c.env.DB, userId),
    getUserPreferences(c.env.DB, userId),
    getProviderSubscriptionsForUser(c.env.DB, userId),
    getLocationSubscriptionsForUser(c.env.DB, userId),
    getNewsPreferences(c.env.DB, userId),
  ])

  return c.json({
    subscriptions: subsResult.results.map(r => ({
      launchId: r.launch_id,
      name: r.name,
      provider: r.provider ?? null,
    })),
    notificationPreferences: {
      remind24h:            prefs ? prefs.remind_24h             === 1 : true,
      remind1h:             prefs ? prefs.remind_1h              === 1 : true,
      remind10m:            prefs ? prefs.remind_10m             === 1 : true,
      notifyNetChange:      prefs ? prefs.notify_net_change      === 1 : false,
      notifyStatusChange:   prefs ? prefs.notify_status_change   === 1 : false,
      notifyTerminalStatus: prefs ? prefs.notify_terminal_status !== 0 : true,
    },
    providerIds: providerResult.results.map(r => r.provider_id),
    locations: locationResult.results.map(r => ({
      locationId: r.location_id,
      location: r.location,
    })),
    newsPreferences: {
      enabled: newsPrefs.enabled,
      sources: newsPrefs.sources,
    },
  })
}
