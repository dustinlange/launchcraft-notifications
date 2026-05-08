-- Launches being tracked
CREATE TABLE IF NOT EXISTS launches (
  id            TEXT PRIMARY KEY,   -- launch provider ID (e.g. "ll2:12345")
  name          TEXT NOT NULL,
  rocket        TEXT NOT NULL,
  pad           TEXT NOT NULL,
  t0            INTEGER,            -- unix timestamp; NULL if NET not confirmed
  window_start  INTEGER,            -- launch window open (unix timestamp)
  window_end    INTEGER,            -- launch window close (unix timestamp)
  provider      TEXT,                         -- launch service provider name e.g. "SpaceX"
  provider_id   INTEGER,                      -- LL2 agency ID; stable foreign key for subscriptions
  ll2_status_id    INTEGER NOT NULL DEFAULT 1,  -- LL2 status ID: 1=Go,2=TBD,3=Success,4=Failure,5=Hold,6=InFlight,7=PartialFailure,8=TBC
  has_timeline     INTEGER NOT NULL DEFAULT 0,
  success_at       INTEGER,                     -- unix timestamp when status first became 'success'
  end_dispatched   INTEGER NOT NULL DEFAULT 0,  -- 1 after end push sent ~30min post terminal status
  last_updated     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Per-user device tokens (decoupled from per-launch subscriptions)
CREATE TABLE IF NOT EXISTS user_devices (
  user_id             TEXT PRIMARY KEY,
  device_token        TEXT NOT NULL,
  push_to_start_token TEXT,
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Provider-level subscriptions (auto-fan-out to per-launch on new launches)
CREATE TABLE IF NOT EXISTS provider_subscriptions (
  user_id     TEXT    NOT NULL,
  provider_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider_id)
);

-- Per-user subscriptions to a launch
-- One row per (user, launch) pair
CREATE TABLE IF NOT EXISTS subscriptions (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  launch_id         TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  activity_token      TEXT,            -- Live Activity push token; NULL until activity started
  activity_id         TEXT,            -- ActivityKit activity identifier
  attributes_json     TEXT,            -- JSON-encoded LaunchActivityAttributes for push-to-start
  start_dispatched    INTEGER NOT NULL DEFAULT 0,
  reminded_24h        INTEGER NOT NULL DEFAULT 0,
  reminded_1h         INTEGER NOT NULL DEFAULT 0,
  reminded_10m        INTEGER NOT NULL DEFAULT 0,
  user_id             TEXT NOT NULL,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(launch_id, user_id)
);

-- Timeline events for launches that have them
CREATE TABLE IF NOT EXISTS timeline_events (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  launch_id   TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,         -- e.g. "Max-Q", "MECO", "Stage Sep"
  t_offset_s  INTEGER NOT NULL,      -- seconds relative to T-0 (negative = before)
  fire_at     INTEGER,               -- absolute unix timestamp; computed from t0
  sent_at     INTEGER,               -- NULL until dispatched
  UNIQUE(launch_id, t_offset_s)
);

-- Per-user notification preferences (all reminders enabled by default)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id      TEXT PRIMARY KEY,
  remind_24h   INTEGER NOT NULL DEFAULT 1,
  remind_1h    INTEGER NOT NULL DEFAULT 1,
  remind_10m   INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_timeline_fire ON timeline_events(fire_at, sent_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_launch ON subscriptions(launch_id);
CREATE INDEX IF NOT EXISTS idx_launches_t0 ON launches(t0);
