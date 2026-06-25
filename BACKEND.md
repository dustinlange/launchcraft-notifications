# Launchcraft Notifications Backend

**Stack:** Cloudflare Workers (TypeScript, Hono) · Cloudflare D1 (SQLite) · Cloudflare KV · Apple Push Notification Service (APNs)

---

## Architecture Overview

A single Cloudflare Worker serves two roles simultaneously: an **HTTP API** for the iOS app and a **cron worker** that fires every minute to dispatch notifications, sync launch data, and manage Live Activities.

---

## HTTP API

All routes except `/webhook` and `/health` require an `X-API-Key` header. An `API_KEY_PREVIOUS` secret is also accepted during key rotation so older app versions keep working.

### App Startup

**`GET /startup?userId=`**
Single round-trip call on app launch. Returns all active launch subscriptions, notification preferences, provider subscription IDs, and location subscriptions in one parallel query. Avoids multiple API calls on cold start.

### Launch Subscriptions

**`POST /register`**
Subscribes to a specific launch. Accepts device token, push-to-start token, `attributesJson` (Live Activity attributes), and launch metadata. If T-0 is within the user's configured live activity window, immediately dispatches a push-to-start. Also triggers a fresh LL2 sync for the launch in the background.

**`DELETE /subscription`**
Unsubscribes from a launch and removes the device token/push-to-start token relationship for that subscription.

**`GET /subscriptions?userId=`**
Returns all non-terminal launch subscriptions for a user.

### Device Token Management

**`POST /device-token`**
Updates the user's APNs device token. Called on every app launch if the token changed.

**`POST /push-to-start-token`**
Updates the user's push-to-start token (used to remotely start Live Activities). Re-registered on every app launch in case the token rotated while the app was backgrounded.

### Live Activity Token Management

**`POST /activity-token`**
Stores the activity token for a running Live Activity so the server can push content-state updates (timeline events, status changes).

**`DELETE /activity-token`**
Clears the activity token when the Live Activity ends. Prevents the server from pushing to a dead token.

### Provider & Location Subscriptions

**`GET/POST/DELETE /provider-subscription`**
Per-provider subscriptions (e.g. "all SpaceX launches"). Fan-out creates launch subscriptions for all upcoming matching launches.

**`GET/POST/DELETE /location-subscription`**
Per-pad-location subscriptions (e.g. "all launches from KSC"). Same fan-out model.

### For You Feed Subscriptions

**`GET /feed-subscription?userId=&feedId=`**
Returns whether a user is subscribed to a specific feed.

**`POST /feed-subscription`**
Subscribes to a For You feed. Four section types, each with their own filter payload:

| Type | Filter fields |
|---|---|
| `launches` | `providerIds`, `locationIds`, `crewedOnly` (null/true/false), `allUpcoming` flag |
| `events` | `eventTypeIds` (empty = all types) |
| `news` | `sources` (empty = all sources) |
| `astronauts` | `agencyIds`, `inSpaceOnly` flag |

On subscribe, immediately fans out to all existing upcoming launches within 30 days that match the feed's filters, so the user doesn't wait for the next poll cycle.

**`DELETE /feed-subscription`**
Unsubscribes and cascade-deletes all launch subscriptions that were fanned out solely from this feed (unless covered by another subscription source).

### Notification Preferences

**`GET/POST /preferences?userId=`**
Per-user notification preference flags:

| Preference | Default |
|---|---|
| Launch reminders: 24h / 1h / 10m | On |
| NET change notifications | Off |
| Status change notifications | Off |
| Terminal status notifications | On |
| Auto-start Live Activity | On |
| Live Activity start window | 1 hour before T-0 |
| Event reminders: 24h / 1h / 10m | On |

### Webhook

**`POST /webhook`**
Authenticated endpoint (separate `WEBHOOK_SECRET`) for pushing launch updates directly without waiting for the poll cycle. Upserts the launch, updates timeline events, and immediately dispatches Live Activity updates and alert notifications to all subscribers if status or T-0 changed.

### Proxies

**`GET /ll2/*`**
Transparent proxy to Launch Library 2 API (v2.2.0 and v2.3.0) with KV caching. All app users share a single cache entry per URL, so one cache miss per TTL window regardless of user count.

| Endpoint | Cache TTL |
|---|---|
| `/launches/`, `/events/` | 5 minutes |
| `/astronauts/` | 10 minutes |
| `/agencies/`, `/pads/`, `/locations/`, `/mission_patches/` | 24 hours |

**`GET /snapi/*`**
Transparent proxy to Spaceflight News API v4 with KV caching. Articles TTL is 2 minutes. No SNAPI auth required.

### Misc

**`GET /news-sources`** — Returns the list of available SNAPI news sources.

**`GET /health`** — Health check, no auth required.

---

## Cron Schedule

The worker runs on a `* * * * *` cron (every minute). Tasks are staggered across minute offsets within each 5-minute block to spread CPU usage.

### Every Minute

**`dispatchTimelineEvents`**
Queries for timeline events with `fire_at ≤ now` and `sent_at IS NULL`. Pushes Live Activity content-state updates (e.g. "Max-Q", "MECO", "Stage Sep") to all subscribers with active activity tokens, grouped by launch to minimise subscription lookups. 60 seconds after each event fires, sends a "transition" push to switch the display from a fired-event checkmark to a countdown for the next upcoming event.

**`prefetchNearT0Launches → dispatchReminders`**
Sequenced: prefetch runs first so any last-minute NET changes are committed before reminders fire. The prefetch syncs all subscribed launches with T-0 within the next 5 minutes or within ±90 seconds of T-0 (single combined query). Then `dispatchReminders` fires a single UNION ALL query across all three reminder windows (24h, 1h, 10m) and sends alert notifications to subscribed users whose preferences allow that window.

### Every 2 Minutes

**`dispatchActivityStarts`**
Finds subscriptions that need a push-to-start: have a push-to-start token, have `attributes_json`, `start_dispatched = 0`, no active activity token, launch is Go/In-Flight, and T-0 is within the user's configured start window. Atomically claims each subscription before sending to prevent duplicate dispatches from concurrent Worker instances.

### Every 5 Minutes — Minute :00

**`pollLL2`**
Fetches the next 50 upcoming launches from LL2. Bulk-fetches all existing DB records in one query, then for each launch compares `t0`, `status`, `has_timeline`, `is_crewed`, `image_url`, and `mission_name`. Skips the DB upsert entirely for unchanged launches (typically 48 of 50). Fan-out only runs for new launches or launches that just moved to a confirmed-Go status. Processed in batches of 10. Also individually syncs any subscribed launches not in the top 50 that are within 30 days of T-0 or have a direct explicit subscription.

**`pollNoTimelineLaunches`**
Sends heartbeat Live Activity updates for subscribed launches without a timeline that are within 24 hours of T-0, keeping the countdown widget accurate.

### Every 5 Minutes — Minute :01

**`dispatchNewsNotifications`**
Fetches articles from SNAPI published in the last 30 minutes. Pre-filters already-dispatched article IDs with a single bulk query to avoid redundant DB writes. For new articles only, atomically claims each one then pushes notifications to all users with a matching news feed subscription.

**`dispatchEventNotifications`**
Fetches upcoming events from LL2 (with an 11-minute KV cache to avoid redundant API calls). Upserts only near-term events (within 30 hours). Checks each event against 24h, 1h, and 10m notification windows, atomically claims any event/window pair, and pushes to all users whose event feed subscription covers that event type.

### Every 5 Minutes — Minute :02

**`dispatchActivityEnds`**
Finds launches that reached terminal status 30+ minutes ago with `end_dispatched = 0`. Sends `event: "end"` Live Activity pushes with a 30-minute dismissal date, then marks `end_dispatched = 1` and clears stored activity tokens.

**`detectSilentPushToStartFailures`**
Finds subscriptions where `start_dispatched = 1` but `activity_token IS NULL` — APNs accepted the push-to-start but iOS never started the activity. If the launch is still in the future, resets `start_dispatched = 0` for a retry. If T-0 is more than 5 minutes past, clears the push-to-start token as stale.

### Every 15 Minutes — Minute :03

**`pollAstronauts`**
Fetches all active astronauts from LL2 (status_id=1 only). Compares `in_space` against stored snapshots. On change, sends "Astronaut Launched to Space" or "Astronaut Returned to Earth" push notifications to all users with a matching astronaut feed subscription. Return-to-Earth notifications include days-in-space calculated from the stored `entered_space_at` timestamp. Upserts all snapshots after detection.

### Monitoring

On every successful cron tick, pings a `HEALTHCHECK_URL` (e.g. healthchecks.io) as a dead man's switch. A top-level `try/catch` also POSTs to `ERROR_WEBHOOK_URL` (e.g. Slack, Discord) on any unhandled cron error (including CPU limit exceeded).

---

## Database (D1 / SQLite)

| Table | Purpose |
|---|---|
| `launches` | Cached LL2 launch records: status, T-0, provider, pad, timeline flag, `is_crewed` |
| `user_devices` | One row per user: APNs device token + push-to-start token |
| `launch_subscriptions` | Per-user per-launch subscriptions with Live Activity tokens, reminder flags, `attributes_json` |
| `provider_subscriptions` | Direct per-provider subscriptions |
| `location_subscriptions` | Direct per-pad-location subscriptions |
| `feed_subscriptions` | For You feed subscriptions with type and filter flags (`all_upcoming`, `crewed_only`, `in_space_only`) |
| `feed_subscription_providers` | Provider filter entries for a launches feed |
| `feed_subscription_locations` | Location filter entries for a launches feed |
| `feed_subscription_event_types` | Event type filter entries for an events feed |
| `feed_subscription_news_sources` | Source filter entries for a news feed |
| `feed_subscription_astronaut_agencies` | Agency filter entries for an astronauts feed |
| `launch_opt_outs` | Explicit opt-outs preventing fan-out from re-subscribing to a manually unsubscribed launch |
| `timeline_events` | Per-launch timeline events with `t_offset_s`, `fire_at`, `sent_at`, `transition_sent` |
| `user_preferences` | Per-user notification preference flags |
| `events` | Cached LL2 upcoming events (near-term only) |
| `event_dispatch_log` | Deduplication: event ID + window label, prevents re-sending reminders |
| `astronaut_status_snapshots` | Last-known `in_space` status per active astronaut with `entered_space_at` for duration calculation |
| `news_dispatch_log` | Article deduplication: article ID, 7-day retention |

### Fan-Out Model

When a user subscribes to a provider, location, or For You feed, individual `launch_subscriptions` rows are created for all matching upcoming launches. This fan-out happens:

1. **At subscription time** — immediately for new feed subscriptions (via `fanOutExistingLaunchesToFeedSubscription`)
2. **At poll time** — for brand new launches (first appearance from LL2) and launches that just moved to a confirmed-Go status
3. **At registration time** — when a user explicitly subscribes to a specific launch via `POST /register`

Fan-out is capped at launches within 30 days of T-0 to prevent subscribing to launches years in the future. Explicitly subscribed launches (with `attributes_json` set by the iOS app) are always synced individually regardless of T-0 distance.

---

## APNs Integration

A JWT is generated using ES256 (ECDSA P-256) from the `.p8` private key and cached in KV for 40 minutes to avoid regenerating it on every push. Four push payload shapes are used:

| Type | When | APNs `apns-push-type` |
|---|---|---|
| Alert notification | Reminders, status/NET changes, news, events, astronauts | `alert` |
| Live Activity update | Timeline events, status/NET changes via webhook/poll | `liveactivity` (`event: "update"`) |
| Live Activity end | 30 min after terminal status | `liveactivity` (`event: "end"`) |
| Push-to-start | Up to configured window before T-0 | `liveactivity` (`event: "start"`) |

Live Activity timestamps are converted from Unix epoch to Apple reference date (seconds since Jan 1 2001) before sending. Stale device tokens (APNs 400/410) are automatically cleared from `user_devices` or `launch_subscriptions` to stop repeated delivery failures.

---

## Environment Variables & Secrets

| Name | Type | Purpose |
|---|---|---|
| `APNS_PRIVATE_KEY` | Secret | Contents of the `.p8` key file |
| `APNS_KEY_ID` | Secret | 10-character key ID from Apple Developer |
| `APNS_TEAM_ID` | Secret | 10-character team ID from Apple Developer |
| `BUNDLE_ID` | Secret | App bundle identifier |
| `APNS_ENV` | Secret | `"production"` or `"sandbox"` |
| `WEBHOOK_SECRET` | Secret | Shared secret for the `/webhook` endpoint |
| `LL2_API_KEY` | Secret | Launch Library 2 API token |
| `API_KEY` | Secret | `X-API-Key` required on all app-facing routes |
| `API_KEY_PREVIOUS` | Secret | Previous key, accepted during rotation |
| `HEALTHCHECK_URL` | Secret | Dead man's switch ping URL (healthchecks.io) |
| `ERROR_WEBHOOK_URL` | Secret | Webhook URL for cron error alerts (Slack, Discord, etc.) |
| `DB` | D1 Binding | Primary SQLite database |
| `KV` | KV Binding | Response cache + APNs JWT cache |
