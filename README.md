# Launchcraft Notifications

Cloudflare Workers backend for Launchcraft push notifications and Live Activities. Polls [Launch Library 2](https://thespacedevs.com/llapi), fans out APNs pushes, and manages per-launch, per-provider, per-location, and per-section subscriptions in a D1 SQLite database.

## Local Development

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine for local dev)

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.dev.vars`

Copy the example and fill in your values:

```bash
cp .dev.vars.example .dev.vars
```

| Variable | Description |
|---|---|
| `LL2_API_KEY` | Launch Library 2 API key |
| `APNS_KEY_ID` | 10-character APNs key ID from Apple Developer |
| `APNS_TEAM_ID` | 10-character Apple Developer team ID |
| `BUNDLE_ID` | App bundle ID e.g. `com.yourname.launchcraft` |
| `APNS_ENV` | `sandbox` for development, `production` for release |
| `WEBHOOK_SECRET` | Any string — used to authenticate `/webhook` calls |
| `APNS_PRIVATE_KEY` | Full contents of your `.p8` file including header/footer |
| `API_KEY` | Shared secret sent by the iOS app as `X-API-Key` on every request |

For `APNS_PRIVATE_KEY`, wrap the multi-line value in quotes:
```
APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIGHAgEA...
-----END PRIVATE KEY-----"
```

### 3. Set up the local database

```bash
npx wrangler d1 execute launchcraft-db --local --file src/db/schema.sql
```

### 4. Start the dev server

```bash
npx wrangler dev --test-scheduled
```

The server runs at `http://localhost:8787`.

### 5. Test the endpoints

**Fetch all startup data in one call:**
```bash
curl "http://localhost:8787/startup?userId=test-user"
```

**Register a subscription:**
```bash
curl -X POST http://localhost:8787/register \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user",
    "deviceToken": "abc123",
    "launch": {
      "id": "your-launch-id",
      "name": "Test Launch",
      "rocket": "Falcon 9",
      "pad": "LC-39A",
      "t0": null,
      "ll2StatusId": 1
    }
  }'
```

**Trigger the cron manually:**
```bash
curl "http://localhost:8787/__scheduled"
```

**Send a webhook update:**
```bash
curl -X POST http://localhost:8787/webhook \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: localsecret" \
  -d '{
    "id": "your-launch-id",
    "name": "Test Launch",
    "rocket": "Falcon 9",
    "pad": "LC-39A",
    "t0": '"$(date -v+1H +%s)"',
    "windowStart": null,
    "windowEnd": null,
    "ll2StatusId": 1
  }'
```

**Query the database:**
```bash
npx wrangler d1 execute launchcraft-db --local --command "SELECT * FROM launches"
npx wrangler d1 execute launchcraft-db --local --command "SELECT * FROM subscriptions"
npx wrangler d1 execute launchcraft-db --local --command "SELECT * FROM timeline_events"
```

### 6. Deploy to production

```bash
npx wrangler deploy
```

Secrets must be set separately (they are not read from `.dev.vars` in production):
```bash
npx wrangler secret put LL2_API_KEY
npx wrangler secret put APNS_PRIVATE_KEY
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put BUNDLE_ID
npx wrangler secret put APNS_ENV
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put API_KEY
```

The iOS app reads `API_KEY` from `LaunchcraftAPIKey` in `Info.plist` (or the `LAUNCHCRAFT_API_KEY` environment variable in your Xcode scheme for local development).

---

## API Reference

### App launch

| Method | Path | Description |
|---|---|---|
| `GET` | `/startup` | Returns subscriptions, preferences, provider IDs, and location subscriptions in one call |

### Launch subscriptions

| Method | Path | Description |
|---|---|---|
| `POST` | `/register` | Subscribe to a launch; triggers an immediate LL2 sync |
| `DELETE` | `/subscription` | Unsubscribe from a launch; records an opt-out to prevent fan-out re-adding it |
| `GET` | `/subscriptions` | List active (non-terminal) launch subscriptions for a user |
| `POST` | `/activity-token` | Store a Live Activity push token after the activity starts |
| `POST` | `/push-to-start-token` | Update the push-to-start token when it rotates |

### Provider subscriptions

| Method | Path | Description |
|---|---|---|
| `GET` | `/provider-subscriptions` | List subscribed provider IDs for a user |
| `POST` | `/provider-subscription` | Subscribe to a launch provider |
| `DELETE` | `/provider-subscription` | Unsubscribe from a launch provider |

### Location subscriptions

| Method | Path | Description |
|---|---|---|
| `GET` | `/location-subscriptions` | List subscribed locations for a user |
| `POST` | `/location-subscription` | Subscribe to a pad location |
| `DELETE` | `/location-subscription` | Unsubscribe from a pad location |

### Section subscriptions

| Method | Path | Description |
|---|---|---|
| `POST` | `/section-subscription` | Subscribe a For You section; pass `sectionId` + provider/location ID arrays (empty arrays = all upcoming) |
| `DELETE` | `/section-subscription` | Unsubscribe a For You section by `sectionId` |

### Notification preferences

| Method | Path | Description |
|---|---|---|
| `GET` | `/preferences` | Fetch reminder window preferences for a user |
| `POST` | `/preferences` | Save reminder window preferences |

### Webhook

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook` | Receive a launch update and push to subscribed users immediately |

---

## Authentication

All client-facing endpoints require an `X-API-Key` header matching the `API_KEY` secret. Requests without a valid key receive `401 Unauthorized`. Two endpoints are exempt:

- `/webhook` — uses its own `x-webhook-secret` header
- `/health` — public, for uptime monitors

### Key rotation

If the key is compromised, rotating it immediately breaks all existing app installs until users update. To rotate gracefully:

**1. Promote the current key to `API_KEY_PREVIOUS`** so old app versions keep working:
```bash
npx wrangler secret put API_KEY_PREVIOUS   # paste the current API_KEY value
```

**2. Set the new key:**
```bash
npx wrangler secret put API_KEY            # paste the new value
```

**3. Ship an app update** with the new key in `Info.plist` / xcconfig.

**4. Once old-version traffic has dropped off, remove the previous key:**
```bash
npx wrangler secret delete API_KEY_PREVIOUS
```

The worker accepts either key during the overlap window, so no users experience downtime. If you need an immediate hard revoke (active abuse), skip step 1 — some users will be temporarily broken until they update.

---

## System Workflow

### App launch (startup)

The app makes a single `GET /startup` call that returns everything needed in parallel:
- Active launch subscriptions
- Notification preferences (reminder windows)
- Provider subscription IDs
- Location subscriptions

### Registration (user subscribes to a launch)

1. App calls `LiveActivityManager.startActivity()` → creates an `Activity<LaunchActivityAttributes>` via ActivityKit
2. App POSTs to `/register` with the device token + launch metadata
3. App receives the activity's push token, POSTs to `/activity-token`
4. Backend stores both tokens in D1, triggers an immediate LL2 sync for fresh data

### Fan-out subscriptions

Users can subscribe to launches at four levels. All fan-out channels are unioned together, and `launch_opt_outs` ensures a manual unsubscribe is always respected.

| Source | How |
|---|---|
| **Individual launch** | Direct `/register` call |
| **Provider** | Bell tap on a provider → any new launch from that provider auto-subscribes the user |
| **Location** | Bell tap on a pad location → any new launch from that location auto-subscribes the user |
| **For You section** | Subscribe toggle on a section → fans out via provider IDs, location IDs, or all-upcoming |

### Keeping data fresh (every 5 min)

1. Cron fires → `pollLL2()` fetches upcoming launches from Launch Library 2
2. Each launch is upserted into the DB and fanned out to provider/location/section subscribers
3. If `t0` changed → schedule-change alert sent (body formatted in the user's locale via `UNNotificationServiceExtension`)
4. If `ll2_status_id` changed → status-change alert sent
5. If the status is now terminal (Success, Failure, PartialFailure) → end notification queued

### Push notifications (alerts)

| Trigger | Title | Body |
|---|---|---|
| T-0 changes | "Schedule Changed" | "{name} NET has changed to {localized date}" |
| Status changes (non-terminal) | "Status Changed" | "{name} status has changed from {prev} to {new}" |
| Status → Success | "Status Changed" | "{name} was successful!" |
| Status → Failure | "Status Changed" | "{name} has failed!" |
| Status → Partial Failure | "Status Changed" | "{name} was a partial failure!" |
| T-24h before launch | "Launch Tomorrow" | — |
| T-1h before launch | "Launch in 1 Hour" | — |
| T-10m before launch | "Launch in 10 Minutes" | — |

Schedule-change notifications use `mutable-content: 1` so a `UNNotificationServiceExtension` can format the timestamp in the user's local timezone before display.

### Timeline events (launches with a flightplan)

1. At registration time, LL2's `flightplan` is parsed into `timeline_events` rows with absolute `fire_at` timestamps
2. Every minute, cron fires → `dispatchTimelineEvents()` queries for rows where `fire_at <= now AND sent_at IS NULL`
3. Each due event triggers a Live Activity update showing the current event + next-event countdown
4. Row is marked `sent_at` so it never fires twice

### No-timeline launches (heartbeat)

Every 5 min, `pollNoTimelineLaunches()` finds active launches without a flightplan where T-0 is within 24 hours and sends a quiet Live Activity update to keep the countdown accurate.

### Live Activity lifecycle

- **Start**: push-to-start token stored at registration; cron sends a push-to-start notification when T-0 is within 1 hour and the launch is confirmed Go
- **Update**: sent on every T-0 or status change, and at each timeline milestone
- **End**: sent ~30 minutes after the launch reaches a terminal status; activity lingers showing the final state then dismisses

### Token rotation

ActivityKit rotates the activity push token periodically. `LiveActivityManager` watches `pushTokenUpdates` as an async stream and POSTs the new token to `/activity-token` transparently whenever it changes.

### Manual unsubscribe protection

When a user manually unsubscribes from a specific launch, a row is written to `launch_opt_outs`. All three fan-out paths (provider, location, section) check this table before inserting into `subscriptions`, so the user is never re-added by a background sync. The opt-out is cleared if the user re-subscribes directly.

---

## Further Reading

- [Database Schema](docs/database-schema.md) — table-by-table reference
