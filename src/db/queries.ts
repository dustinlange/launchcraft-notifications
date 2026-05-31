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
  mission_name: string | null
  rocket: string
  pad: string
  pad_location: string | null
  pad_location_id: number | null
  provider: string | null
  provider_id: number | null
  provider_logo_url: string | null
  image_url: string | null
  rocket_image_url: string | null
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
  // Per-user notification prefs (NULL = use default)
  notify_net_change: number | null
  notify_status_change: number | null
  notify_terminal_status: number | null
  // Launch images for notification thumbnails
  image_url: string | null
  rocket_image_url: string | null
}

export interface TimelineEvent {
  id: string
  launch_id: string
  label: string
  t_offset_s: number
  fire_at: number | null
  sent_at: number | null
  transition_sent: number
}

export function getLaunch(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM launches WHERE id = ?').bind(id).first<Launch>()
}

export function upsertLaunch(db: D1Database, launch: Omit<Launch, 'last_updated'>) {
  return db.prepare(`
    INSERT INTO launches (id, name, mission_name, rocket, pad, pad_location, pad_location_id, provider, provider_id, provider_logo_url, image_url, rocket_image_url, t0, window_start, window_end, ll2_status_id, has_timeline, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      mission_name = COALESCE(excluded.mission_name, mission_name),
      rocket = excluded.rocket, pad = excluded.pad,
      pad_location = COALESCE(excluded.pad_location, pad_location),
      pad_location_id = COALESCE(excluded.pad_location_id, pad_location_id),
      provider = COALESCE(excluded.provider, provider),
      provider_id = COALESCE(excluded.provider_id, provider_id),
      provider_logo_url = COALESCE(excluded.provider_logo_url, provider_logo_url),
      image_url = COALESCE(excluded.image_url, image_url),
      rocket_image_url = COALESCE(excluded.rocket_image_url, rocket_image_url),
      t0 = excluded.t0, window_start = excluded.window_start, window_end = excluded.window_end,
      ll2_status_id = excluded.ll2_status_id,
      has_timeline = excluded.has_timeline, last_updated = unixepoch()
  `).bind(
    launch.id, launch.name, launch.mission_name, launch.rocket, launch.pad,
    launch.pad_location, launch.pad_location_id,
    launch.provider, launch.provider_id, launch.provider_logo_url,
    launch.image_url, launch.rocket_image_url,
    launch.t0, launch.window_start, launch.window_end,
    launch.ll2_status_id, launch.has_timeline
  ).run()
}

export function getActiveSubscriptionsForUser(db: D1Database, userId: string) {
  return db.prepare(`
    SELECT s.launch_id, l.name, l.provider
    FROM launch_subscriptions s
    JOIN launches l ON l.id = s.launch_id
    WHERE s.user_id = ?
      AND l.ll2_status_id NOT IN (${TERMINAL_IDS.join(',')})
  `).bind(userId).all<{ launch_id: string; name: string; provider: string | null }>()
}

export function getSubscriptionsForLaunch(db: D1Database, launchId: string) {
  return db.prepare(`
    SELECT s.*, ud.device_token, ud.push_to_start_token,
           up.notify_net_change, up.notify_status_change, up.notify_terminal_status,
           l.image_url, l.rocket_image_url
    FROM launch_subscriptions s
    JOIN user_devices ud ON ud.user_id = s.user_id
    JOIN launches l ON l.id = s.launch_id
    LEFT JOIN user_preferences up ON up.user_id = s.user_id
    WHERE s.launch_id = ?
  `).bind(launchId).all<SubscriptionWithDevice>()
}

export function upsertSubscription(db: D1Database, sub: Pick<Subscription, 'launch_id' | 'user_id' | 'attributes_json'>) {
  return db.prepare(`
    INSERT INTO launch_subscriptions (launch_id, user_id, attributes_json)
    VALUES (?, ?, ?)
    ON CONFLICT(launch_id, user_id) DO UPDATE SET
      attributes_json = COALESCE(excluded.attributes_json, attributes_json)
  `).bind(sub.launch_id, sub.user_id, sub.attributes_json).run()
}

// Fills attributes_json for any subscriptions to this launch that don't have it yet.
// Used to support fan-out subscriptions that are created server-side without the iOS app context.
// The JSON shape must match LaunchActivityAttributes (Codable, camelCase keys).
export function backfillAttributesJson(
  db: D1Database,
  launchId: string,
  name: string,
  missionName: string | null,
  rocket: string | null,
  provider: string | null,
  providerLogoUrl: string | null,
  statusId: number,
) {
  const rocketAndProvider = [rocket, provider].filter(Boolean).join(' | ') || null
  const attrs = JSON.stringify({
    launchId,
    missionName: missionName ?? name,
    rocketAndProvider,
    statusId,
    logoUrl: providerLogoUrl,
    landingLocation: null,
    landingTypeId: null,
    landingSuccess: null,
    nationUrl: null,
    missionPatchUrl: null,
  })
  return db.prepare(`
    UPDATE launch_subscriptions SET attributes_json = ?
    WHERE launch_id = ? AND attributes_json IS NULL
  `).bind(attrs, launchId).run()
}

export function deleteSubscription(db: D1Database, userId: string, launchId: string) {
  return db.prepare('DELETE FROM launch_subscriptions WHERE user_id = ? AND launch_id = ?')
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
    INSERT OR IGNORE INTO launch_subscriptions (launch_id, user_id)
    SELECT ?, ps.user_id
    FROM provider_subscriptions ps
    JOIN user_devices ud ON ud.user_id = ps.user_id
    LEFT JOIN launch_opt_outs lo ON lo.user_id = ps.user_id AND lo.launch_id = ?
    WHERE ps.provider_id = ? AND lo.launch_id IS NULL
    UNION
    SELECT ?, fsp.user_id
    FROM feed_subscription_providers fsp
    JOIN user_devices ud ON ud.user_id = fsp.user_id
    JOIN feed_subscriptions fs ON fs.user_id = fsp.user_id AND fs.feed_id = fsp.feed_id AND fs.section_type = 'launches'
    LEFT JOIN launch_opt_outs lo ON lo.user_id = fsp.user_id AND lo.launch_id = ?
    WHERE fsp.provider_id = ? AND lo.launch_id IS NULL
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

/// Inserts or replaces a launches feed subscription record.
/// Pass allUpcoming=true and empty arrays for "all upcoming" feeds.
export function upsertLaunchesFeedSubscription(
  db: D1Database,
  userId: string,
  feedId: string,
  allUpcoming: boolean,
  providerIds: number[],
  locationIds: number[]
) {
  const stmts = [
    db.prepare(`
      INSERT INTO feed_subscriptions (user_id, feed_id, section_type, all_upcoming)
      VALUES (?, ?, 'launches', ?)
      ON CONFLICT(user_id, feed_id) DO UPDATE SET
        section_type = 'launches',
        all_upcoming = excluded.all_upcoming
    `).bind(userId, feedId, allUpcoming ? 1 : 0),
    // Clear old filter entries so re-subscribing with a different filter is always clean
    db.prepare('DELETE FROM feed_subscription_providers WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    db.prepare('DELETE FROM feed_subscription_locations WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    ...providerIds.map(id =>
      db.prepare('INSERT OR IGNORE INTO feed_subscription_providers (user_id, feed_id, provider_id) VALUES (?, ?, ?)')
        .bind(userId, feedId, id)
    ),
    ...locationIds.map(id =>
      db.prepare('INSERT OR IGNORE INTO feed_subscription_locations (user_id, feed_id, location_id) VALUES (?, ?, ?)')
        .bind(userId, feedId, id)
    ),
  ]
  return db.batch(stmts)
}

/// Inserts or replaces an events feed subscription record.
export function upsertEventsFeedSubscription(
  db: D1Database,
  userId: string,
  feedId: string,
  eventTypeIds: number[]
) {
  const stmts = [
    db.prepare(`
      INSERT INTO feed_subscriptions (user_id, feed_id, section_type)
      VALUES (?, ?, 'events')
      ON CONFLICT(user_id, feed_id) DO UPDATE SET section_type = 'events'
    `).bind(userId, feedId),
    db.prepare('DELETE FROM feed_subscription_event_types WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    ...eventTypeIds.map(id =>
      db.prepare('INSERT OR IGNORE INTO feed_subscription_event_types (user_id, feed_id, event_type_id) VALUES (?, ?, ?)')
        .bind(userId, feedId, id)
    ),
  ]
  return db.batch(stmts)
}

/// Inserts or replaces a news feed subscription record.
export function upsertNewsFeedSubscription(
  db: D1Database,
  userId: string,
  feedId: string,
  sources: string[]   // empty = all sources
) {
  const stmts = [
    db.prepare(`
      INSERT INTO feed_subscriptions (user_id, feed_id, section_type)
      VALUES (?, ?, 'news')
      ON CONFLICT(user_id, feed_id) DO UPDATE SET section_type = 'news'
    `).bind(userId, feedId),
    db.prepare('DELETE FROM feed_subscription_news_sources WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    ...sources.map(s =>
      db.prepare('INSERT OR IGNORE INTO feed_subscription_news_sources (user_id, feed_id, source) VALUES (?, ?, ?)')
        .bind(userId, feedId, s)
    ),
  ]
  return db.batch(stmts)
}

/// Inserts or replaces an astronauts feed subscription record.
export function upsertAstronautsFeedSubscription(
  db: D1Database,
  userId: string,
  feedId: string,
  agencyIds: number[],  // empty = all agencies
  inSpaceOnly: boolean
) {
  const stmts = [
    db.prepare(`
      INSERT INTO feed_subscriptions (user_id, feed_id, section_type, in_space_only)
      VALUES (?, ?, 'astronauts', ?)
      ON CONFLICT(user_id, feed_id) DO UPDATE SET
        section_type = 'astronauts',
        in_space_only = excluded.in_space_only
    `).bind(userId, feedId, inSpaceOnly ? 1 : 0),
    db.prepare('DELETE FROM feed_subscription_astronaut_agencies WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    ...agencyIds.map(id =>
      db.prepare('INSERT OR IGNORE INTO feed_subscription_astronaut_agencies (user_id, feed_id, agency_id) VALUES (?, ?, ?)')
        .bind(userId, feedId, id)
    ),
  ]
  return db.batch(stmts)
}

/// Removes a feed subscription and, for launches feeds, all individual launch subscriptions
/// that were fanned out from it — unless the launch is still covered by another source.
///
/// IMPORTANT: the launch subscription DELETE must run first, before the feed tables
/// are cleared, so it can still query what this feed covered.
export function deleteFeedSubscription(db: D1Database, userId: string, feedId: string) {
  return db.batch([
    // Step 1: remove individual launch subscriptions that belonged solely to this launches feed.
    // Non-launches feeds (events/news/astronauts) don't fan-out to the subscriptions table,
    // so the DELETE is scoped only to this feed's provider/location/all-upcoming coverage.
    db.prepare(`
      DELETE FROM launch_subscriptions
      WHERE user_id = ?
        AND launch_id IN (
          SELECT l.id
          FROM launches l
          INNER JOIN launch_subscriptions s ON s.launch_id = l.id AND s.user_id = ?
          WHERE (
            -- This feed covers the launch via a provider filter
            l.provider_id IN (
              SELECT provider_id FROM feed_subscription_providers
              WHERE user_id = ? AND feed_id = ?
            )
            -- Or via a location filter
            OR l.pad_location_id IN (
              SELECT location_id FROM feed_subscription_locations
              WHERE user_id = ? AND feed_id = ?
            )
            -- Or via the all-upcoming flag
            OR EXISTS (
              SELECT 1 FROM feed_subscriptions
              WHERE user_id = ? AND feed_id = ? AND all_upcoming = 1
            )
          )
          -- Exclude launches still covered by another source
          AND l.id NOT IN (
            SELECT l2.id FROM launches l2 WHERE
              -- Another feed's provider filter still covers it
              l2.provider_id IN (
                SELECT fsp.provider_id FROM feed_subscription_providers fsp
                WHERE fsp.user_id = ? AND fsp.feed_id != ?
              )
              -- Another feed's location filter still covers it
              OR l2.pad_location_id IN (
                SELECT fsl.location_id FROM feed_subscription_locations fsl
                WHERE fsl.user_id = ? AND fsl.feed_id != ?
              )
              -- Another all-upcoming feed still covers it
              OR EXISTS (
                SELECT 1 FROM feed_subscriptions fs
                WHERE fs.user_id = ? AND fs.feed_id != ? AND fs.all_upcoming = 1
              )
              -- Direct provider subscription covers it
              OR l2.provider_id IN (
                SELECT ps.provider_id FROM provider_subscriptions ps
                WHERE ps.user_id = ?
              )
              -- Direct location subscription covers it
              OR l2.pad_location_id IN (
                SELECT ls.location_id FROM location_subscriptions ls
                WHERE ls.user_id = ?
              )
          )
        )
    `).bind(
      userId,
      userId,
      userId, feedId,
      userId, feedId,
      userId, feedId,
      userId, feedId,
      userId, feedId,
      userId, feedId,
      userId, feedId,
      userId,
      userId,
    ),

    // Step 2: remove the feed subscription rows (order matters — after the DELETE above).
    db.prepare('DELETE FROM feed_subscriptions WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    db.prepare('DELETE FROM feed_subscription_providers WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    db.prepare('DELETE FROM feed_subscription_locations WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    db.prepare('DELETE FROM feed_subscription_event_types WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    db.prepare('DELETE FROM feed_subscription_news_sources WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
    db.prepare('DELETE FROM feed_subscription_astronaut_agencies WHERE user_id = ? AND feed_id = ?').bind(userId, feedId),
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
    INSERT OR IGNORE INTO launch_subscriptions (launch_id, user_id)
    SELECT ?, ls.user_id
    FROM location_subscriptions ls
    JOIN user_devices ud ON ud.user_id = ls.user_id
    LEFT JOIN launch_opt_outs lo ON lo.user_id = ls.user_id AND lo.launch_id = ?
    WHERE ls.location_id = ? AND lo.launch_id IS NULL
    UNION
    SELECT ?, fsl.user_id
    FROM feed_subscription_locations fsl
    JOIN user_devices ud ON ud.user_id = fsl.user_id
    JOIN feed_subscriptions fs ON fs.user_id = fsl.user_id AND fs.feed_id = fsl.feed_id AND fs.section_type = 'launches'
    LEFT JOIN launch_opt_outs lo ON lo.user_id = fsl.user_id AND lo.launch_id = ?
    WHERE fsl.location_id = ? AND lo.launch_id IS NULL
  `).bind(launchId, launchId, padLocationId, launchId, launchId, padLocationId).run()
}

export function resetReminderFlags(db: D1Database, launchId: string) {
  return db.prepare(`
    UPDATE launch_subscriptions SET reminded_24h = 0, reminded_1h = 0, reminded_10m = 0
    WHERE launch_id = ?
  `).bind(launchId).run()
}

export function getSubscriptionsNeedingStart(db: D1Database, now: number) {
  return db.prepare(`
    SELECT s.*, ud.device_token, ud.push_to_start_token,
           l.name as launch_name, l.t0, l.window_start, l.window_end, l.ll2_status_id,
           first_te.label   AS first_event_name,
           first_te.fire_at AS first_event_fire_at
    FROM launch_subscriptions s
    JOIN user_devices ud ON ud.user_id = s.user_id
    JOIN launches l ON l.id = s.launch_id
    LEFT JOIN user_preferences up ON up.user_id = s.user_id
    LEFT JOIN timeline_events first_te ON first_te.id = (
      SELECT id FROM timeline_events
      WHERE launch_id = s.launch_id AND fire_at > unixepoch()
      ORDER BY fire_at ASC LIMIT 1
    )
    WHERE ud.push_to_start_token IS NOT NULL
      AND s.attributes_json IS NOT NULL
      AND s.start_dispatched = 0
      AND s.activity_token IS NULL  -- skip if user already has a running Live Activity
      AND l.ll2_status_id IN (${CONFIRMED_GO_IDS.join(',')})
      AND l.t0 IS NOT NULL
      AND COALESCE(up.auto_live_activity, 1) = 1
      AND l.t0 <= ? + COALESCE(up.live_activity_window, 3600)
  `).bind(now).all<SubscriptionWithDevice & { launch_name: string; t0: number; window_start: number | null; window_end: number | null; ll2_status_id: number; first_event_name: string | null; first_event_fire_at: number | null }>()
}

export function markStartDispatched(db: D1Database, subscriptionId: string) {
  return db.prepare('UPDATE launch_subscriptions SET start_dispatched = 1 WHERE id = ?')
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
    UPDATE launch_subscriptions SET activity_token = ?, activity_id = ?
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

// Events whose checkmark has been displayed for ≥60s and are ready to transition
// to a countdown for the next upcoming event.
export function getDueTransitionEvents(db: D1Database, now: number) {
  return db.prepare(`
    SELECT te.id, te.launch_id,
           te.label   AS current_event_name,
           te.fire_at AS current_event_fire_at,
           next_te.label   AS next_event_name,
           next_te.fire_at AS next_event_fire_at,
           l.t0, l.window_start, l.window_end, l.ll2_status_id
    FROM timeline_events te
    JOIN launches l ON l.id = te.launch_id
    JOIN timeline_events next_te ON next_te.launch_id = te.launch_id
      AND next_te.fire_at = (
        SELECT MIN(fire_at) FROM timeline_events
        WHERE launch_id = te.launch_id AND fire_at > te.fire_at AND sent_at IS NULL
      )
    WHERE te.sent_at IS NOT NULL
      AND te.sent_at + 60 <= ?
      AND te.transition_sent = 0
      AND next_te.fire_at > ?
      AND l.ll2_status_id IN (${CONFIRMED_GO_IDS.join(',')})
  `).bind(now, now).all<{
    id: string; launch_id: string
    current_event_name: string; current_event_fire_at: number
    next_event_name: string; next_event_fire_at: number
    t0: number | null; window_start: number | null; window_end: number | null; ll2_status_id: number
  }>()
}

export function markTransitionSent(db: D1Database, eventId: string) {
  return db.prepare('UPDATE timeline_events SET transition_sent = 1 WHERE id = ?')
    .bind(eventId).run()
}

export function getSubscribedLaunchIds(db: D1Database) {
  return db.prepare(`
    SELECT DISTINCT launch_id FROM launch_subscriptions
    JOIN launches ON launches.id = launch_subscriptions.launch_id
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
    SELECT s.id, ud.device_token, s.launch_id, s.user_id, l.name as launch_name, l.t0, l.rocket,
           l.image_url, l.rocket_image_url
    FROM launch_subscriptions s
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
    image_url: string | null
    rocket_image_url: string | null
  }>()
}

export interface UserPreferences {
  user_id: string
  remind_24h: number
  remind_1h: number
  remind_10m: number
  notify_net_change: number
  notify_status_change: number
  notify_terminal_status: number
  auto_live_activity: number
  live_activity_window: number
  event_remind_24h: number
  event_remind_1h: number
  event_remind_10m: number
}

export function getUserPreferences(db: D1Database, userId: string) {
  return db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').bind(userId).first<UserPreferences>()
}

export function upsertUserPreferences(
  db: D1Database,
  userId: string,
  remind24h: boolean,
  remind1h: boolean,
  remind10m: boolean,
  notifyNetChange: boolean,
  notifyStatusChange: boolean,
  notifyTerminalStatus: boolean,
  autoLiveActivity: boolean,
  liveActivityWindow: number,
  eventRemind24h: boolean,
  eventRemind1h: boolean,
  eventRemind10m: boolean,
) {
  return db.prepare(`
    INSERT INTO user_preferences
      (user_id, remind_24h, remind_1h, remind_10m,
       notify_net_change, notify_status_change, notify_terminal_status,
       auto_live_activity, live_activity_window,
       event_remind_24h, event_remind_1h, event_remind_10m,
       updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      remind_24h = excluded.remind_24h,
      remind_1h = excluded.remind_1h,
      remind_10m = excluded.remind_10m,
      notify_net_change = excluded.notify_net_change,
      notify_status_change = excluded.notify_status_change,
      notify_terminal_status = excluded.notify_terminal_status,
      auto_live_activity = excluded.auto_live_activity,
      live_activity_window = excluded.live_activity_window,
      event_remind_24h = excluded.event_remind_24h,
      event_remind_1h = excluded.event_remind_1h,
      event_remind_10m = excluded.event_remind_10m,
      updated_at = unixepoch()
  `).bind(
    userId,
    remind24h ? 1 : 0, remind1h ? 1 : 0, remind10m ? 1 : 0,
    notifyNetChange ? 1 : 0, notifyStatusChange ? 1 : 0, notifyTerminalStatus ? 1 : 0,
    autoLiveActivity ? 1 : 0, liveActivityWindow,
    eventRemind24h ? 1 : 0, eventRemind1h ? 1 : 0, eventRemind10m ? 1 : 0,
  ).run()
}


export function fanOutAllUpcomingSubscriptions(db: D1Database, launchId: string) {
  return db.prepare(`
    INSERT OR IGNORE INTO launch_subscriptions (launch_id, user_id)
    SELECT ?, fs.user_id
    FROM feed_subscriptions fs
    JOIN user_devices ud ON ud.user_id = fs.user_id
    LEFT JOIN launch_opt_outs lo ON lo.user_id = fs.user_id AND lo.launch_id = ?
    WHERE fs.all_upcoming = 1 AND fs.section_type = 'launches' AND lo.launch_id IS NULL
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

/**
 * Clears opt-outs for launches now covered by the given feed subscription config.
 * Called when a user adds or updates a launches feed subscription so that previously
 * opted-out launches that fall under the new config are re-included in fan-out.
 *
 * allUpcoming=true  → clear all opt-outs for this user (feed covers everything)
 * providerIds/locationIds → clear opt-outs only for launches matching those filters
 */
export function clearOptOutsForFeedSubscription(
  db: D1Database,
  userId: string,
  allUpcoming: boolean,
  providerIds: number[],
  locationIds: number[]
) {
  if (allUpcoming) {
    // Section covers all upcoming launches — remove every opt-out for this user
    return db.prepare('DELETE FROM launch_opt_outs WHERE user_id = ?')
      .bind(userId).run()
  }

  if (providerIds.length === 0 && locationIds.length === 0) {
    // No coverage — nothing to clear
    return Promise.resolve()
  }

  const providerPlaceholders = providerIds.map(() => '?').join(', ')
  const locationPlaceholders = locationIds.map(() => '?').join(', ')

  const conditions: string[] = []
  const bindings: (string | number)[] = [userId]

  if (providerIds.length > 0) {
    conditions.push(`launch_id IN (SELECT id FROM launches WHERE provider_id IN (${providerPlaceholders}))`)
    bindings.push(...providerIds)
  }
  if (locationIds.length > 0) {
    conditions.push(`launch_id IN (SELECT id FROM launches WHERE pad_location_id IN (${locationPlaceholders}))`)
    bindings.push(...locationIds)
  }

  const sql = `DELETE FROM launch_opt_outs WHERE user_id = ? AND (${conditions.join(' OR ')})`
  return (db.prepare(sql) as D1PreparedStatement).bind(...bindings).run()
}

export function markReminderSent(db: D1Database, subscriptionId: string, windowLabel: '24h' | '1h' | '10m') {
  const col = windowLabel === '24h' ? 'reminded_24h' : windowLabel === '1h' ? 'reminded_1h' : 'reminded_10m'
  return db.prepare(`UPDATE launch_subscriptions SET ${col} = 1 WHERE id = ?`).bind(subscriptionId).run()
}

export function getActiveNoTimelineLaunches(db: D1Database) {
  return db.prepare(`
    SELECT * FROM launches
    WHERE has_timeline = 0
      AND ll2_status_id NOT IN (${TERMINAL_IDS.join(',')})
      AND t0 IS NOT NULL
  `).all<Launch>()
}

// Returns distinct launch IDs that have active subscriptions and whose T-0 falls
// within [now - lookbackS, now + lookaheadS]. Used to trigger a fresh LL2 sync
// in the minute(s) immediately before liftoff so status/NET changes are caught.
export function getLaunchesNearT0(db: D1Database, fromTs: number, toTs: number) {
  return db.prepare(`
    SELECT DISTINCT l.id
    FROM launches l
    JOIN launch_subscriptions s ON s.launch_id = l.id
    WHERE l.t0 BETWEEN ? AND ?
      AND l.ll2_status_id NOT IN (${TERMINAL_IDS.join(',')})
  `).bind(fromTs, toTs).all<{ id: string }>()
}

export function upsertTimelineEvents(db: D1Database, launchId: string, events: Array<{ label: string; t_offset_s: number }>, t0: number) {
  const stmts = events.map(e =>
    db.prepare(`
      INSERT INTO timeline_events (launch_id, label, t_offset_s, fire_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(launch_id, t_offset_s) DO UPDATE SET
        label = excluded.label,
        fire_at = excluded.fire_at,
        sent_at          = CASE WHEN excluded.fire_at > unixepoch() THEN NULL ELSE sent_at END,
        transition_sent  = CASE WHEN excluded.fire_at > unixepoch() THEN 0   ELSE transition_sent END
    `).bind(launchId, e.label, e.t_offset_s, t0 + e.t_offset_s)
  )
  return db.batch(stmts)
}

// When T-0 shifts but LL2 returns no timeline array (e.g. during a hold or early reschedule),
// recompute fire_at for all existing events using their stored t_offset_s and the new t0.
// Also clears sent_at / transition_sent for any event that is now in the future again.
// --- News notification queries ---

/** Returns distinct users who have a news feed subscription covering the given source.
 *  A subscription with no source entries covers all sources. */
export function getUsersForNewsSource(db: D1Database, source: string): Promise<{ results: { user_id: string; device_token: string }[] }> {
  return db.prepare(`
    SELECT DISTINCT ud.user_id, ud.device_token
    FROM feed_subscriptions fs
    JOIN user_devices ud ON ud.user_id = fs.user_id
    WHERE fs.section_type = 'news'
      AND (
        NOT EXISTS (SELECT 1 FROM feed_subscription_news_sources WHERE user_id = fs.user_id AND feed_id = fs.feed_id)
        OR EXISTS (SELECT 1 FROM feed_subscription_news_sources WHERE user_id = fs.user_id AND feed_id = fs.feed_id AND source = ?)
      )
  `).bind(source).all<{ user_id: string; device_token: string }>()
}

export async function getNewsPreferences(db: D1Database, userId: string): Promise<{ enabled: boolean; sources: string[] }> {
  const [pref, sourcesResult] = await Promise.all([
    db.prepare('SELECT enabled FROM user_news_preferences WHERE user_id = ?').bind(userId).first<{ enabled: number }>(),
    db.prepare('SELECT source FROM user_news_sources WHERE user_id = ?').bind(userId).all<{ source: string }>(),
  ])
  return {
    enabled: pref ? pref.enabled === 1 : true,
    sources: sourcesResult.results.map(r => r.source),
  }
}

export async function upsertNewsPreferences(db: D1Database, userId: string, enabled: boolean, sources: string[]) {
  const stmts = [
    db.prepare(`
      INSERT INTO user_news_preferences (user_id, enabled, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = unixepoch()
    `).bind(userId, enabled ? 1 : 0),
    db.prepare('DELETE FROM user_news_sources WHERE user_id = ?').bind(userId),
    ...sources.map(s =>
      db.prepare('INSERT OR IGNORE INTO user_news_sources (user_id, source) VALUES (?, ?)').bind(userId, s)
    ),
  ]
  return db.batch(stmts)
}

/** Atomically claims an article for dispatch.
 *  Returns true if this caller won the claim (changes === 1) and should proceed to send.
 *  Returns false if another Worker instance already claimed it (INSERT OR IGNORE no-ops). */
export async function claimArticleForDispatch(db: D1Database, articleId: number): Promise<boolean> {
  const result = await db.prepare('INSERT OR IGNORE INTO news_dispatch_log (article_id) VALUES (?)').bind(articleId).run()
  return result.meta.changes === 1
}

export function pruneOldDispatchLog(db: D1Database) {
  return db.prepare('DELETE FROM news_dispatch_log WHERE dispatched_at < unixepoch() - 604800').run()
}

// --- End news notification queries ---

export function recalculateTimelineFireAt(db: D1Database, launchId: string, t0: number) {
  return db.prepare(`
    UPDATE timeline_events
    SET fire_at         = ? + t_offset_s,
        sent_at         = CASE WHEN (? + t_offset_s) > unixepoch() THEN NULL ELSE sent_at END,
        transition_sent = CASE WHEN (? + t_offset_s) > unixepoch() THEN 0   ELSE transition_sent END
    WHERE launch_id = ?
  `).bind(t0, t0, t0, launchId).run()
}

export function clearActivityToken(db: D1Database, subscriptionId: string) {
  return db.prepare(
    'UPDATE launch_subscriptions SET activity_token = NULL, activity_id = NULL WHERE id = ?'
  ).bind(subscriptionId).run()
}

/** Clears a stale APNs device token for a user (e.g. after a 410 Unregistered response). */
export function clearDeviceToken(db: D1Database, userId: string, deviceToken: string) {
  return db.prepare(
    'UPDATE user_devices SET device_token = NULL WHERE user_id = ? AND device_token = ?'
  ).bind(userId, deviceToken).run()
}

/** Clears a stale push-to-start token for a user (e.g. after a 410 Unregistered response). */
export function clearPushToStartToken(db: D1Database, userId: string, pushToStartToken: string) {
  return db.prepare(
    'UPDATE user_devices SET push_to_start_token = NULL WHERE user_id = ? AND push_to_start_token = ?'
  ).bind(userId, pushToStartToken).run()
}

// --- Events notification queries ---

export interface LL2Event {
  id: number
  name: string
  event_type_id: number | null
  event_type: string | null
  description: string | null
  location: string | null
  date: number | null
}

export function upsertEvent(db: D1Database, event: LL2Event) {
  return db.prepare(`
    INSERT INTO events (id, name, event_type_id, event_type, description, location, date, image_url, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      event_type_id = excluded.event_type_id,
      event_type = excluded.event_type,
      description = COALESCE(excluded.description, description),
      location = COALESCE(excluded.location, location),
      date = excluded.date,
      image_url = COALESCE(excluded.image_url, image_url),
      last_updated = unixepoch()
  `).bind(event.id, event.name, event.event_type_id, event.event_type, event.description, event.location, event.date, event.image_url).run()
}

export type EventWindowLabel = '24h' | '1h' | '10m'

/** Atomically claims an event/window pair for dispatch.
 *  Returns true if this caller won the claim and should proceed to send. */
export async function claimEventForDispatch(db: D1Database, eventId: number, windowLabel: EventWindowLabel): Promise<boolean> {
  const result = await db.prepare('INSERT OR IGNORE INTO event_dispatch_log (event_id, window_label) VALUES (?, ?)')
    .bind(eventId, windowLabel).run()
  return result.meta.changes === 1
}

export function pruneOldEventDispatchLog(db: D1Database) {
  return db.prepare('DELETE FROM event_dispatch_log WHERE dispatched_at < unixepoch() - 172800').run()
}

/** Returns distinct users subscribed to events feeds that cover the given event type
 *  AND have the given reminder window enabled in their notification preferences.
 *  A feed with no event_type entries covers all event types. */
export function getUsersForEventType(
  db: D1Database,
  eventTypeId: number | null,
  windowLabel: EventWindowLabel,
): Promise<{ results: { user_id: string; device_token: string }[] }> {
  const prefCol = windowLabel === '24h' ? 'event_remind_24h'
                : windowLabel === '1h'  ? 'event_remind_1h'
                :                         'event_remind_10m'

  const typeFilter = eventTypeId === null
    // Event has no type — only notify users whose feed covers all types (no type entries)
    ? `AND NOT EXISTS (SELECT 1 FROM feed_subscription_event_types WHERE user_id = fs.user_id AND feed_id = fs.feed_id)`
    : `AND (
        NOT EXISTS (SELECT 1 FROM feed_subscription_event_types WHERE user_id = fs.user_id AND feed_id = fs.feed_id)
        OR EXISTS (SELECT 1 FROM feed_subscription_event_types WHERE user_id = fs.user_id AND feed_id = fs.feed_id AND event_type_id = ${eventTypeId})
      )`

  return db.prepare(`
    SELECT DISTINCT ud.user_id, ud.device_token
    FROM feed_subscriptions fs
    JOIN user_devices ud ON ud.user_id = fs.user_id
    LEFT JOIN user_preferences up ON up.user_id = fs.user_id
    WHERE fs.section_type = 'events'
      ${typeFilter}
      AND (up.${prefCol} IS NULL OR up.${prefCol} = 1)
  `).all<{ user_id: string; device_token: string }>()
}

// --- Astronaut notification queries ---

export interface AstronautSnapshot {
  astronaut_id: number
  name: string
  in_space: number
  agency_id: number | null
  flights_count: number | null
  entered_space_at: number | null  // unix timestamp when in_space last transitioned 0→1
  last_checked: number
}

export function getAllAstronautSnapshots(db: D1Database) {
  return db.prepare('SELECT * FROM astronaut_status_snapshots').all<AstronautSnapshot>()
}

export function upsertAstronautSnapshot(db: D1Database, snap: Omit<AstronautSnapshot, 'last_checked' | 'entered_space_at'>) {
  return db.prepare(`
    INSERT INTO astronaut_status_snapshots (astronaut_id, name, in_space, agency_id, flights_count, entered_space_at, last_checked)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN unixepoch() ELSE NULL END, unixepoch())
    ON CONFLICT(astronaut_id) DO UPDATE SET
      name = excluded.name,
      agency_id = excluded.agency_id,
      flights_count = excluded.flights_count,
      entered_space_at = CASE
        WHEN excluded.in_space = 1 AND astronaut_status_snapshots.in_space = 0 THEN unixepoch()
        WHEN excluded.in_space = 1 THEN astronaut_status_snapshots.entered_space_at
        ELSE NULL
      END,
      in_space = excluded.in_space,
      last_checked = unixepoch()
  `).bind(snap.astronaut_id, snap.name, snap.in_space, snap.agency_id, snap.flights_count, snap.in_space).run()
}

/** Returns distinct users with an astronauts feed covering the given agency_id.
 *  A feed with no agency entries covers all agencies. */
export function getUsersForAstronautAgency(db: D1Database, agencyId: number | null): Promise<{ results: { user_id: string; device_token: string }[] }> {
  if (agencyId === null) {
    return db.prepare(`
      SELECT DISTINCT ud.user_id, ud.device_token
      FROM feed_subscriptions fs
      JOIN user_devices ud ON ud.user_id = fs.user_id
      WHERE fs.section_type = 'astronauts'
        AND NOT EXISTS (
          SELECT 1 FROM feed_subscription_astronaut_agencies
          WHERE user_id = fs.user_id AND feed_id = fs.feed_id
        )
    `).all<{ user_id: string; device_token: string }>()
  }
  return db.prepare(`
    SELECT DISTINCT ud.user_id, ud.device_token
    FROM feed_subscriptions fs
    JOIN user_devices ud ON ud.user_id = fs.user_id
    WHERE fs.section_type = 'astronauts'
      AND (
        NOT EXISTS (SELECT 1 FROM feed_subscription_astronaut_agencies WHERE user_id = fs.user_id AND feed_id = fs.feed_id)
        OR EXISTS (SELECT 1 FROM feed_subscription_astronaut_agencies WHERE user_id = fs.user_id AND feed_id = fs.feed_id AND agency_id = ?)
      )
  `).bind(agencyId).all<{ user_id: string; device_token: string }>()
}
