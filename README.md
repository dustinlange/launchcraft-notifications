# Launchcraft Notifications

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
      "status": "go"
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
    "ll2StatusId": 1,
    "status": "go"
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
```

---

## System Workflow

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
