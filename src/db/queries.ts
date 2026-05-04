export interface Launch {
  id: string
  name: string
  rocket: string
  pad: string
  t0: number | null
  window_start: number | null
  window_end: number | null
  status: 'go' | 'hold' | 'scrub' | 'success' | 'failure'
  ll2_status_id: number
  has_timeline: number
  success_at: number | null
  end_dispatched: number
  last_updated: number
}

export interface Subscription {
  id: string
  launch_id: string
  device_token: string
  activity_token: string | null
  activity_id: string | null
  push_to_start_token: string | null
  attributes_json: string | null
  start_dispatched: number
  user_id: string
  created_at: number
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
    INSERT INTO launches (id, name, rocket, pad, t0, window_start, window_end, status, ll2_status_id, has_timeline, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, rocket = excluded.rocket, pad = excluded.pad,
      t0 = excluded.t0, window_start = excluded.window_start, window_end = excluded.window_end,
      status = excluded.status, ll2_status_id = excluded.ll2_status_id,
      has_timeline = excluded.has_timeline, last_updated = unixepoch()
  `).bind(
    launch.id, launch.name, launch.rocket, launch.pad,
    launch.t0, launch.window_start, launch.window_end,
    launch.status, launch.ll2_status_id, launch.has_timeline
  ).run()
}

export function getSubscriptionsForLaunch(db: D1Database, launchId: string) {
  return db.prepare('SELECT * FROM subscriptions WHERE launch_id = ?')
    .bind(launchId).all<Subscription>()
}

export function upsertSubscription(db: D1Database, sub: Pick<Subscription, 'launch_id' | 'device_token' | 'user_id' | 'push_to_start_token' | 'attributes_json'>) {
  return db.prepare(`
    INSERT INTO subscriptions (launch_id, device_token, user_id, push_to_start_token, attributes_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(launch_id, user_id) DO UPDATE SET
      device_token = excluded.device_token,
      push_to_start_token = COALESCE(excluded.push_to_start_token, push_to_start_token),
      attributes_json = COALESCE(excluded.attributes_json, attributes_json)
  `).bind(sub.launch_id, sub.device_token, sub.user_id, sub.push_to_start_token, sub.attributes_json).run()
}

export function updatePushToStartToken(db: D1Database, userId: string, token: string) {
  return db.prepare(`
    UPDATE subscriptions SET push_to_start_token = ?, start_dispatched = 0
    WHERE user_id = ?
  `).bind(token, userId).run()
}

export function getSubscriptionsNeedingStart(db: D1Database, cutoffT0: number) {
  return db.prepare(`
    SELECT s.*, l.name as launch_name, l.t0, l.window_start, l.window_end, l.ll2_status_id
    FROM subscriptions s
    JOIN launches l ON l.id = s.launch_id
    WHERE s.push_to_start_token IS NOT NULL
      AND s.attributes_json IS NOT NULL
      AND s.start_dispatched = 0
      AND l.status = 'go'
      AND l.t0 IS NOT NULL
      AND l.t0 <= ?
  `).bind(cutoffT0).all<Subscription & { launch_name: string; t0: number; window_start: number | null; window_end: number | null; ll2_status_id: number }>()
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
    WHERE te.fire_at <= ? AND te.sent_at IS NULL AND l.status = 'go'
    ORDER BY te.fire_at ASC
    LIMIT 100
  `).bind(now).all<TimelineEvent & { launch_name: string; rocket: string; t0: number; window_start: number | null; window_end: number | null; ll2_status_id: number }>()
}

export function markEventSent(db: D1Database, eventId: string) {
  return db.prepare('UPDATE timeline_events SET sent_at = unixepoch() WHERE id = ?')
    .bind(eventId).run()
}

export function getActiveNoTimelineLaunches(db: D1Database) {
  return db.prepare(`
    SELECT * FROM launches
    WHERE has_timeline = 0 AND status NOT IN ('success', 'failure', 'scrub')
    AND t0 IS NOT NULL
  `).all<Launch>()
}

export function upsertTimelineEvents(db: D1Database, launchId: string, events: Array<{ label: string; t_offset_s: number }>, t0: number) {
  const stmts = events.map(e =>
    db.prepare(`
      INSERT INTO timeline_events (launch_id, label, t_offset_s, fire_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).bind(launchId, e.label, e.t_offset_s, t0 + e.t_offset_s)
  )
  return db.batch(stmts)
}
