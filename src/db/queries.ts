// LL2 status IDs used throughout for filtering
// 1=Go, 2=TBD, 3=Success, 4=Failure, 5=Hold, 6=InFlight, 7=PartialFailure, 8=TBC
export const LL2_STATUS = {
  GO: 1,
  TBD: 2,
  SUCCESS: 3,
  FAILURE: 4,
  HOLD: 5,
  IN_FLIGHT: 6,
  PARTIAL_FAILURE: 7,
  TBC: 8,
} as const

// Statuses that mean "confirmed go" — eligible for push-to-start, reminders, timeline dispatch
export const CONFIRMED_GO_IDS = [LL2_STATUS.GO, LL2_STATUS.IN_FLIGHT]

// Terminal statuses — live activity should end, subscription is done
export const TERMINAL_IDS = [LL2_STATUS.SUCCESS, LL2_STATUS.FAILURE, LL2_STATUS.PARTIAL_FAILURE]

export interface Launch {
  id: string
  name: string
  rocket: string
  pad: string
  pad_location: string | null
  pad_location_id: number | null
  provider: string | null
  provider_id: number | null
  t0: number | null
  window_start: number | null
  window_end: number | null
  ll2_status_id: number
  has_timeline: number
  success_at: number | null
  end_dispatched: number
  last_updated: number
}

export interface Subscription {
  id: string
  launch_id: string
  activity_token: string | null
  activity_id: string | null
  attributes_json: string | null
  start_dispatched: number
  user_id: string
  created_at: number
}

export interface SubscriptionWithDevice extends Subscription {
  device_token: string
  push_to_start_token: string | null
}

export interface TimelineEvent {
  id: string
  launch_id: string
  label: string
  t_offset_s: number
  fire_at: number | null
  sent_at: number | null
}

export function getLaunch(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM launches WHERE id = ?').bind(id).first<Launch>()
}

export function upsertLaunch(db: D1Database, launch: Omit<Launch, 'last_updated'>) {
  return db.prepare(`
    INSERT INTO launches (id, name, rocket, pad, pad_location, pad_location_id, provider, provider_id, t0, window_start, window_end, ll2_status_id, has_timeline, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, rocket = excluded.rocket, pad = excluded.pad,
      pad_location = COALESCE(excluded.pad_location, pad_location),
      pad_location_id = COALESCE(excluded.pad_location_id, pad_location_id),
      provider = COALESCE(excluded.provider, provider),
      provider_id = COALESCE(excluded.provider_id, provider_id),
      t0 = excluded.t0, window_start = excluded.window_start, window_end = excluded.window_end,
      ll2_status_id = excluded.ll2_status_id,
      has_timeline = excluded.has_timeline, last_updated = unixepoch()
  `).bind(
    launch.id, launch.name, launch.rocket, launch.pad,
    launch.pad_location, launch.pad_location_id,
    launch.provider, launch.provider_id,
    launch.t0, launch.window_start, launch.window_end,
    launch.ll2_status_id, launch.has_timeline
  ).run()
}

export function getActiveSubscriptionsForUser(db: D1Database, userId: string) {
  return db.prepare(`
    SELECT s.launch_id, l.name, l.provider
    FROM subscriptions s
    JOIN launches l ON l.id = s.launch_id
    WHERE s.user_id = ?
      AND l.ll2_status_id NOT IN (${TERMINAL_IDS.join(',')})
  `).bind(userId).all<{ launch_id: string; name: string; provider: string | null }>()
}

export function getSubscriptionsForLaunch(db: D1Database, launchId: string) {
  return db.prepare(`
    SELECT s.*, ud.device_token, ud.push_to_start_token
    FROM subscriptions s
    JOIN user_devices ud ON ud.user_id = s.user_id
    WHERE s.launch_id = ?
  `).bind(launchId).all<SubscriptionWithDevice>()
}

export function upsertSubscription(db: D1Database, sub: Pick<Subscription, 'launch_id' | 'user_id' | 'attributes_json'>) {
  return db.prepare(`
    INSERT INTO subscriptions (launch_id, user_id, attributes_json)
    VALUES (?, ?, ?)
    ON CONFLICT(launch_id, user_id) DO UPDATE SET
      attributes_json = COALESCE(excluded.attributes_json, attributes_json)
  `).bind(sub.launch_id, sub.user_id, sub.attributes_json).run()
}

export function deleteSubscription(db: D1Database, userId: string, launchId: string) {
  return db.prepare('DELETE FROM subscriptions WHERE user_id = ? AND launch_id = ?')
    .bind(userId, launchId).run()
}

export function upsertUserDevice(db: D1Database, userId: string, deviceToken: string, pushToStartToken?: string | null) {
  return db.prepare(`
    INSERT INTO user_devices (user_id, device_token, push_to_start_token, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      device_token = excluded.device_token,
      push_to_start_token = COALESCE(excluded.push_to_start_token, push_to_start_token),
      updated_at = unixepoch()
  `).bind(userId, deviceToken, pushToStartToken ?? null).run()
}

export function updatePushToStartTokenForUser(db: D1Database, userId: string, token: string) {
  return db.prepare(`
    INSERT INTO user_devices (user_id, device_token, push_to_start_token, updated_at)
    VALUES (?, '', ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      push_to_start_token = excluded.push_to_start_token,
      updated_at = unixepoch()
  `).bind(userId, token).run()
}

export function fanOutProviderSubscriptions(db: D1Database, launchId: string, providerId: number) {
  return db.prepare(`
    INSERT OR IGNORE INTO subscriptions (launch_id, user_id)
    SELECT ?, ps.user_id
    FROM provider_subscriptions ps
    JOIN user_devices ud ON ud.user_id = ps.user_id
    LEFT JOIN launch_opt_outs lo ON lo.user_id = ps.user_id AND lo.launch_id = ?
    WHERE ps.provider_id = ? AND lo.launch_id IS NULL
    UNION
    SELECT ?, ssp.user_id
    FROM section_subscription_providers ssp
    JOIN user_devices ud ON ud.user_id = ssp.user_id
    LEFT JOIN launch_opt_outs lo ON lo.user_id = ssp.user_id AND lo.launch_id = ?
    WHERE ssp.provider_id = ? AND lo.launch_id IS NULL
  `).bind(launchId, launchId, providerId, launchId, launchId, providerId).run()
}

export function getProviderSubscriptionsForUser(db: D1Database, userId: string) {
  return db.prepare('SELECT provider_id FROM provider_subscriptions WHERE user_id = ?')
    .bind(userId).all<{ provider_id: number }>()
}

export function upsertProviderSubscription(db: D1Database, userId: string, providerId: number) {
  return db.prepare(`
    INSERT OR IGNORE INTO provider_subscriptions (user_id, provider_id) VALUES (?, ?)
  `).bind(userId, providerId).run()
}

/// Inserts or replaces a full section subscription record.
/// Pass allUpcoming=true and empty arrays for "all upcoming" sections.
export function upsertSectionSubscription(
  db: D1Database,
  userId: string,
  sectionId: string,
  allUpcoming: boolean,
  providerIds: number[],
  locationIds: number[]
) {
  const stmts = [
    db.prepare(`
      INSERT INTO section_subscriptions (user_id, section_id, all_upcoming)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, section_id) DO UPDATE SET all_upcoming = excluded.all_upcoming
    `).bind(userId, sectionId, allUpcoming ? 1 : 0),
    // Clear old entries so re-subscribing with a different filter is always clean
    db.prepare('DELETE FROM section_subscription_providers WHERE user_id = ? AND section_id = ?').bind(userId, sectionId),
    db.prepare('DELETE FROM section_subscription_locations WHERE user_id = ? AND section_id = ?').bind(userId, sectionId),
    ...providerIds.map(id =>
      db.prepare('INSERT OR IGNORE INTO section_subscription_providers (user_id, section_id, provider_id) VALUES (?, ?, ?)')
        .bind(userId, sectionId, id)
    ),
    ...locationIds.map(id =>
      db.prepare('INSERT OR IGNORE INTO section_subscription_locations (user_id, section_id, location_id) VALUES (?, ?, ?)')
        .bind(userId, sectionId, id)
    ),
  ]
  return db.batch(stmts)
}

/// Removes all subscription data for a section.
export function deleteSectionSubscription(db: D1Database, userId: string, sectionId: string) {
  return db.batch([
    db.prepare('DELETE FROM section_subscriptions WHERE user_id = ? AND section_id = ?').bind(userId, sectionId),
    db.prepare('DELETE FROM section_subscription_providers WHERE user_id = ? AND section_id = ?').bind(userId, sectionId),
    db.prepare('DELETE FROM section_subscription_locations WHERE user_id = ? AND section_id = ?').bind(userId, sectionId),
  ])
}

export function deleteProviderSubscription(db: D1Database, userId: string, providerId: number) {
  return db.prepare('DELETE FROM provider_subscriptions WHERE user_id = ? AND provider_id = ?')
    .bind(userId, providerId).run()
}

export function getLocationSubscriptionsForUser(db: D1Database, userId: string) {
  return db.prepare('SELECT location_id, location FROM location_subscriptions WHERE user_id = ?')
    .bind(userId).all<{ location_id: number; location: string }>()
}

export function upsertLocationSubscription(db: D1Database, userId: string, locationId: number) {
  return db.prepare(`
    INSERT INTO location_subscriptions (user_id, location_id, location)
    VALUES (?, ?, (SELECT pad_location FROM launches WHERE pad_location_id = ? LIMIT 1))
    ON CONFLICT(user_id, location_id) DO UPDATE SET
      location = COALESCE((SELECT pad_location FROM launches WHERE pad_location_id = ? LIMIT 1), location)
  `).bind(userId, locationId, locationId, locationId).run()
}

export function deleteLocationSubscription(db: D1Database, userId: string, locationId: number) {
  return db.prepare('DELETE FROM location_subscriptions WHERE user_id = ? AND location_id = ?')
    .bind(userId, locationId).run()
}

export function fanOutLocationSubscriptions(db: D1Database, launchId: string, padLocationId: number) {
  return db.prepare(`
    INSERT OR IGNORE INTO subscriptions (launch_id, user_id)
    SELECT ?, ls.user_id
    FROM location_subscriptions ls
    JOIN user_devices ud ON ud.user_id = ls.user_id
    LEFT JOIN launch_opt_outs lo ON lo.user_id = ls.user_id AND lo.launch_id = ?
    WHERE ls.location_id = ? AND lo.launch_id IS NULL
    UNION
    SELECT ?, ssl.user_id
    FROM section_subscription_locations ssl
    JOIN user_devices ud ON ud.user_id = ssl.user_id
    LEFT JOIN launch_opt_outs lo ON lo.user_id = ssl.user_id AND lo.launch_id = ?
    WHERE ssl.location_id = ? AND lo.launch_id IS NULL
  `).bind(launchId, launchId, padLocationId, launchId, launchId, padLocationId).run()
}

export function resetReminderFlags(db: D1Database, launchId: string) {
  return db.prepare(`
    UPDATE subscriptions SET reminded_24h = 0, reminded_1h = 0, reminded_10m = 0
    WHERE launch_id = ?
  `).bind(launchId).run()
}

export function getSubscriptionsNeedingStart(db: D1Database, cutoffT0: number) {
  return db.prepare(`
    SELECT s.*, ud.device_token, ud.push_to_start_token,
           l.name as launch_name, l.t0, l.window_start, l.window_end, l.ll2_status_id
    FROM subscriptions s
    JOIN user_devices ud ON ud.user_id = s.user_id
    JOIN launches l ON l.id = s.launch_id
    WHERE ud.push_to_start_token IS NOT NULL
      AND s.attributes_json IS NOT NULL
      AND s.start_dispatched = 0
      AND l.ll2_status_id IN (${CONFIRMED_GO_IDS.join(',')})
      AND l.t0 IS NOT NULL
      AND l.t0 <= ?
  `).bind(cutoffT0).all<SubscriptionWithDevice & { launch_name: string; t0: number; window_start: number | null; window_end: number | null; ll2_status_id: number }>()
}

export function markStartDispatched(db: D1Database, subscriptionId: string) {
  return db.prepare('UPDATE subscriptions SET start_dispatched = 1 WHERE id = ?')
    .bind(subscriptionId).run()
}

export function markSuccessAt(db: D1Database, launchId: string, successAt: number) {
  return db.prepare(`
    UPDATE launches SET success_at = ? WHERE id = ? AND success_at IS NULL
  `).bind(successAt, launchId).run()
}

export function getLaunchesNeedingEnd(db: D1Database, now: number) {
  return db.prepare(`
    SELECT * FROM launches
    WHERE success_at IS NOT NULL
      AND end_dispatched = 0
      AND success_at + 1800 <= ?
  `).bind(now).all<Launch>()
}

export function markEndDispatched(db: D1Database, launchId: string) {
  return db.prepare('UPDATE launches SET end_dispatched = 1 WHERE id = ?')
    .bind(launchId).run()
}

export function updateActivityToken(db: D1Database, userId: string, launchId: string, activityToken: string, activityId: string) {
  return db.prepare(`
    UPDATE subscriptions SET activity_token = ?, activity_id = ?
    WHERE user_id = ? AND launch_id = ?
  `).bind(activityToken, activityId, userId, launchId).run()
}

export function getDueTimelineEvents(db: D1Database, now: number) {
  return db.prepare(`
    SELECT te.*, l.name as launch_name, l.rocket, l.t0, l.window_start, l.window_end, l.ll2_status_id
    FROM timeline_events te
    JOIN launches l ON l.id = te.launch_id
    WHERE te.fire_at <= ? AND te.sent_at IS NULL
      AND l.ll2_status_id IN (${CONFIRMED_GO_IDS.join(',')})
    ORDER BY te.fire_at ASC
    LIMIT 100
  `).bind(now).all<TimelineEvent & { launch_name: string; rocket: string; t0: number; window_start: number | null; window_end: number | null; ll2_status_id: number }>()
}

export function markEventSent(db: D1Database, eventId: string) {
  return db.prepare('UPDATE timeline_events SET sent_at = unixepoch() WHERE id = ?')
    .bind(eventId).run()
}

export function getSubscribedLaunchIds(db: D1Database) {
  return db.prepare(`
    SELECT DISTINCT launch_id FROM subscriptions
    JOIN launches ON launches.id = subscriptions.launch_id
    WHERE launches.ll2_status_id NOT IN (${TERMINAL_IDS.join(',')})
  `).all<{ launch_id: string }>()
}

export function getSubscriptionsNeedingReminder(
  db: D1Database,
  windowLabel: '24h' | '1h' | '10m',
  fromT0: number,
  toT0: number
) {
  const subCol = windowLabel === '24h' ? 'reminded_24h' : windowLabel === '1h' ? 'reminded_1h' : 'reminded_10m'
  const prefCol = windowLabel === '24h' ? 'remind_24h' : windowLabel === '1h' ? 'remind_1h' : 'remind_10m'
  return db.prepare(`
    SELECT s.id, ud.device_token, s.launch_id, s.user_id, l.name as launch_name, l.t0, l.rocket
    FROM subscriptions s
    JOIN user_devices ud ON ud.user_id = s.user_id
    JOIN launches l ON l.id = s.launch_id
    LEFT JOIN user_preferences up ON up.user_id = s.user_id
    WHERE s.${subCol} = 0
      AND (up.${prefCol} IS NULL OR up.${prefCol} = 1)
      AND l.ll2_status_id IN (${CONFIRMED_GO_IDS.join(',')})
      AND l.t0 IS NOT NULL
      AND l.t0 > ? AND l.t0 <= ?
  `).bind(fromT0, toT0).all<{
    id: string
    device_token: string
    launch_id: string
    user_id: string
    launch_name: string
    t0: number
    rocket: string
  }>()
}

export interface UserPreferences {
  user_id: string
  remind_24h: number
  remind_1h: number
  remind_10m: number
}

export function getUserPreferences(db: D1Database, userId: string) {
  return db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').bind(userId).first<UserPreferences>()
}

export function upsertUserPreferences(db: D1Database, userId: string, remind24h: boolean, remind1h: boolean, remind10m: boolean) {
  return db.prepare(`
    INSERT INTO user_preferences (user_id, remind_24h, remind_1h, remind_10m, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      remind_24h = excluded.remind_24h,
      remind_1h = excluded.remind_1h,
      remind_10m = excluded.remind_10m,
      updated_at = unixepoch()
  `).bind(userId, remind24h ? 1 : 0, remind1h ? 1 : 0, remind10m ? 1 : 0).run()
}


export function fanOutAllUpcomingSubscriptions(db: D1Database, launchId: string) {
  return db.prepare(`
    INSERT OR IGNORE INTO subscriptions (launch_id, user_id)
    SELECT ?, ss.user_id
    FROM section_subscriptions ss
    JOIN user_devices ud ON ud.user_id = ss.user_id
    LEFT JOIN launch_opt_outs lo ON lo.user_id = ss.user_id AND lo.launch_id = ?
    WHERE ss.all_upcoming = 1 AND lo.launch_id IS NULL
  `).bind(launchId, launchId).run()
}


export function insertLaunchOptOut(db: D1Database, userId: string, launchId: string) {
  return db.prepare('INSERT OR IGNORE INTO launch_opt_outs (user_id, launch_id) VALUES (?, ?)')
    .bind(userId, launchId).run()
}

export function deleteLaunchOptOut(db: D1Database, userId: string, launchId: string) {
  return db.prepare('DELETE FROM launch_opt_outs WHERE user_id = ? AND launch_id = ?')
    .bind(userId, launchId).run()
}

export function markReminderSent(db: D1Database, subscriptionId: string, windowLabel: '24h' | '1h' | '10m') {
  const col = windowLabel === '24h' ? 'reminded_24h' : windowLabel === '1h' ? 'reminded_1h' : 'reminded_10m'
  return db.prepare(`UPDATE subscriptions SET ${col} = 1 WHERE id = ?`).bind(subscriptionId).run()
}

export function getActiveNoTimelineLaunches(db: D1Database) {
  return db.prepare(`
    SELECT * FROM launches
    WHERE has_timeline = 0
      AND ll2_status_id NOT IN (${TERMINAL_IDS.join(',')})
      AND t0 IS NOT NULL
  `).all<Launch>()
}

export function upsertTimelineEvents(db: D1Database, launchId: string, events: Array<{ label: string; t_offset_s: number }>, t0: number) {
  const stmts = events.map(e =>
    db.prepare(`
      INSERT INTO timeline_events (launch_id, label, t_offset_s, fire_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(launch_id, t_offset_s) DO UPDATE SET
        label = excluded.label,
        fire_at = excluded.fire_at,
        sent_at = CASE WHEN excluded.fire_at > unixepoch() THEN NULL ELSE sent_at END
    `).bind(launchId, e.label, e.t_offset_s, t0 + e.t_offset_s)
  )
  return db.batch(stmts)
}
