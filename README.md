# Launchcraft Live Activity — System Workflow

## Registration (user subscribes to a launch)

1. App calls `LiveActivityManager.startActivity()` → creates an `Activity<LaunchActivityAttributes>` via ActivityKit
2. App POSTs to `/register` with the device push token + launch metadata
3. App receives the activity's push token, POSTs to `/activity-token`
4. Backend stores both tokens in D1, triggers an immediate LL2 sync for fresh data

---

## Keeping data fresh (background, every 5 min)

1. Cron fires → `pollLL2()` fetches upcoming launches from Launch Library 2
2. Each launch is diffed against the DB — if `status` or `t0` changed:
   - Live Activity updated via APNs `liveactivity` push
   - Alert notification sent via APNs `alert` push

---

## Timeline events (launches with a flightplan)

1. At registration time, LL2's `flightplan` is parsed into `timeline_events` rows with absolute `fire_at` timestamps
2. Every minute, cron fires → `dispatchTimelineEvents()` queries for rows where `fire_at <= now AND sent_at IS NULL`
3. Each due event triggers a Live Activity update showing the current event + next event countdown
4. Row is marked `sent_at` so it never fires twice

---

## No-timeline launches (heartbeat)

1. Every 5 min, `pollNoTimelineLaunches()` finds active launches without a flightplan where T-0 is within 24 hours
2. Sends a quiet Live Activity update so the widget's countdown stays accurate

---

## Push notifications (alerts)

Sent alongside Live Activity updates on any of these triggers:

| Event | Type |
|---|---|
| Status changes (hold, scrub, success, failure) | `status_change` |
| T-0 window moves | `schedule_change` |
| *(future)* T-24h, T-1h, T-5min reminders | `reminder` |

Tapping a notification posts `.openLaunch` to `NotificationCenter` → app deep-links to the launch detail.

---

## Token rotation

ActivityKit rotates the activity push token periodically. `LiveActivityManager` watches `pushTokenUpdates` as an async stream and POSTs the new token to `/activity-token` transparently whenever it changes.

---

## Teardown (launch concludes)

1. LL2 status flips to `success`, `failure`, or `scrub`
2. Backend sends a final Live Activity push with `event: end` + `dismissal-date` 30 min out
3. Widget lingers on screen for 30 minutes showing the final state, then dismisses
