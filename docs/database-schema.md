# Database Schema

All tables live in a single Cloudflare D1 (SQLite) database. The source of truth is [`src/db/schema.sql`](../src/db/schema.sql).

---

## `launches`

The central source of truth for every tracked launch. Populated and kept up-to-date by the LL2 poller and webhook handler. Stores the launch name, rocket, pad, T-0 timestamp, launch window, LL2 status ID, and provider/location with their stable integer IDs. Also tracks whether a timeline has been built for the launch, when it reached a terminal status (`success_at`), and whether the post-launch end notification has been sent (`end_dispatched`).

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | LL2 launch ID |
| `name` | TEXT | Launch name |
| `rocket` | TEXT | Rocket name |
| `pad` | TEXT | Pad name |
| `pad_location` | TEXT | Pad location display name (e.g. "Cape Canaveral, FL, USA") |
| `pad_location_id` | INTEGER | LL2 `pad.location.id`; stable key for location fan-out |
| `provider` | TEXT | Launch service provider name (e.g. "SpaceX") |
| `provider_id` | INTEGER | LL2 agency ID; stable key for provider fan-out |
| `t0` | INTEGER | Unix timestamp of T-0; NULL if NET not confirmed |
| `window_start` | INTEGER | Launch window open (unix timestamp) |
| `window_end` | INTEGER | Launch window close (unix timestamp) |
| `ll2_status_id` | INTEGER | LL2 status ID: 1=Go, 2=TBD, 3=Success, 4=Failure, 5=Hold, 6=InFlight, 7=PartialFailure, 8=TBC |
| `has_timeline` | INTEGER | 1 if timeline events have been built for this launch |
| `success_at` | INTEGER | Unix timestamp when status first became terminal |
| `end_dispatched` | INTEGER | 1 after the post-launch end notification has been sent |
| `last_updated` | INTEGER | Unix timestamp of last upsert |

---

## `user_devices`

One row per user. Stores the APNs device token (for alert notifications) and the push-to-start token (for starting Live Activities remotely). Keyed on a stable anonymous `user_id` UUID generated on first app launch.

| Column | Type | Description |
|---|---|---|
| `user_id` | TEXT PK | Stable anonymous UUID from the app |
| `device_token` | TEXT | APNs device token for alert pushes |
| `push_to_start_token` | TEXT | APNs token for starting Live Activities; NULL until received |
| `updated_at` | INTEGER | Unix timestamp of last update |

---

## `subscriptions`

The active per-launch subscriptions — one row per `(user, launch)` pair. This is the table the notification system reads from when sending reminders, status changes, and Live Activity updates. Also carries the Live Activity tokens, the ActivityKit attributes blob for push-to-start, and reminder-sent flags so each window fires exactly once.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | Random hex ID |
| `launch_id` | TEXT | References `launches.id` |
| `user_id` | TEXT | References `user_devices.user_id` |
| `activity_token` | TEXT | Live Activity push token; NULL until the activity starts |
| `activity_id` | TEXT | ActivityKit activity identifier |
| `attributes_json` | TEXT | JSON-encoded `LaunchActivityAttributes` for push-to-start |
| `start_dispatched` | INTEGER | 1 after push-to-start has been sent |
| `reminded_24h` | INTEGER | 1 after the T-24h reminder has been sent |
| `reminded_1h` | INTEGER | 1 after the T-1h reminder has been sent |
| `reminded_10m` | INTEGER | 1 after the T-10m reminder has been sent |
| `created_at` | INTEGER | Unix timestamp of subscription creation |

---

## `timeline_events`

Milestone events (Max-Q, MECO, Stage Sep, etc.) for launches that have a detailed flightplan. Each row has a `t_offset_s` relative to T-0 and a computed `fire_at` absolute timestamp. The cron job checks this table every minute and sends a Live Activity update for any event that is due and hasn't been sent yet.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | Random hex ID |
| `launch_id` | TEXT | References `launches.id` |
| `label` | TEXT | Event name (e.g. "Max-Q", "MECO", "Stage Sep") |
| `t_offset_s` | INTEGER | Seconds relative to T-0 (negative = before launch) |
| `fire_at` | INTEGER | Absolute unix timestamp; computed from `t0 + t_offset_s` |
| `sent_at` | INTEGER | NULL until dispatched; set to prevent duplicate sends |

---

## `user_preferences`

Notification timing preferences per user — which reminder windows are enabled. Defaults to all on. Updated via the preferences screen in the app.

| Column | Type | Description |
|---|---|---|
| `user_id` | TEXT PK | References `user_devices.user_id` |
| `remind_24h` | INTEGER | 1 if T-24h reminder is enabled |
| `remind_1h` | INTEGER | 1 if T-1h reminder is enabled |
| `remind_10m` | INTEGER | 1 if T-10m reminder is enabled |
| `updated_at` | INTEGER | Unix timestamp of last update |

---

## `provider_subscriptions`

Individual bell-tap subscriptions to a launch provider (e.g. SpaceX). When a new launch syncs, the poller fans out into `subscriptions` for every user subscribed to that provider. Independent of section subscriptions — removing a section does not touch this table.

| Column | Type | Description |
|---|---|---|
| `user_id` | TEXT | References `user_devices.user_id` |
| `provider_id` | INTEGER | LL2 agency ID |

---

## `location_subscriptions`

Individual bell-tap subscriptions to a pad location (e.g. Cape Canaveral). Same fan-out behavior as `provider_subscriptions`. The `location` display name is derived lazily from the `launches` table and may be NULL until a launch with that location syncs.

| Column | Type | Description |
|---|---|---|
| `user_id` | TEXT | References `user_devices.user_id` |
| `location_id` | INTEGER | LL2 `pad.location.id` |
| `location` | TEXT | Display name; NULL until resolved from a synced launch |

---

## `section_subscriptions`

One row per For You section that has notifications enabled, keyed on `(user_id, section_id)` where `section_id` is the section's stable UUID from the iOS app. The `all_upcoming` flag covers the "Upcoming Launches — Show All" case: when set, the fan-out adds this user to every new upcoming launch. Deleting a section deletes its row here with no effect on any other section's subscriptions.

| Column | Type | Description |
|---|---|---|
| `user_id` | TEXT | References `user_devices.user_id` |
| `section_id` | TEXT | `ForYouSection.id` UUID string from the app |
| `all_upcoming` | INTEGER | 1 if this section subscribes to every upcoming launch |

---

## `section_subscription_providers`

The provider IDs belonging to a section subscription. One row per `(user, section, provider)`. During fan-out, these are unioned with `provider_subscriptions` so both individual and section-based provider subscriptions are covered in a single query.

| Column | Type | Description |
|---|---|---|
| `user_id` | TEXT | References `user_devices.user_id` |
| `section_id` | TEXT | References `section_subscriptions.section_id` |
| `provider_id` | INTEGER | LL2 agency ID |

---

## `section_subscription_locations`

The location IDs belonging to a section subscription. Same structure as `section_subscription_providers`, unioned with `location_subscriptions` during fan-out.

| Column | Type | Description |
|---|---|---|
| `user_id` | TEXT | References `user_devices.user_id` |
| `section_id` | TEXT | References `section_subscriptions.section_id` |
| `location_id` | INTEGER | LL2 `pad.location.id` |

---

## `launch_opt_outs`

Explicit per-launch opt-outs. When a user manually unsubscribes from a specific launch, a row is inserted here so that future fan-outs (from provider, location, or all-upcoming subscriptions) skip that user for that launch. Cleared when the user re-subscribes to the same launch directly.

| Column | Type | Description |
|---|---|---|
| `user_id` | TEXT | References `user_devices.user_id` |
| `launch_id` | TEXT | References `launches.id` |
