-- Launches being tracked
CREATE TABLE IF NOT EXISTS launches (
  id            TEXT PRIMARY KEY,   -- launch provider ID (e.g. "ll2:12345")
  name          TEXT NOT NULL,
  mission_name  TEXT,                -- LL2 mission.name; may differ from launch name (e.g. "NROL-172" vs "Falcon 9 | NROL-172")
  rocket        TEXT NOT NULL,
  pad           TEXT NOT NULL,
  pad_location     TEXT,             -- LL2 pad.location.name e.g. "Cape Canaveral, FL, USA"
  pad_location_id  INTEGER,          -- LL2 pad.location.id; stable key for location subscriptions
  t0            INTEGER,            -- unix timestamp; NULL if NET not confirmed
  window_start  INTEGER,            -- launch window open (unix timestamp)
  window_end    INTEGER,            -- launch window close (unix timestamp)
  provider      TEXT,                         -- launch service provider name e.g. "SpaceX"
  provider_id   INTEGER,                      -- LL2 agency ID; stable foreign key for subscriptions
  provider_logo_url  TEXT,                    -- LL2 agency logo image URL
  image_url          TEXT,                    -- LL2 launch image URL
  rocket_image_url   TEXT,                    -- LL2 rocket configuration image URL (fallback)
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

-- Location-level subscriptions (auto-fan-out to per-launch on new launches)
CREATE TABLE IF NOT EXISTS location_subscriptions (
  user_id      TEXT    NOT NULL,
  location_id  INTEGER NOT NULL,    -- LL2 pad.location.id; stable key
  location     TEXT,                -- display name; derived from launches table, may be NULL until a launch syncs
  PRIMARY KEY (user_id, location_id)
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
  fire_at          INTEGER,           -- absolute unix timestamp; computed from t0
  sent_at          INTEGER,           -- NULL until checkmark push dispatched
  transition_sent  INTEGER NOT NULL DEFAULT 0,  -- 1 after countdown-to-next push dispatched (~60s after sent_at)
  UNIQUE(launch_id, t_offset_s)
);

-- Per-user notification preferences (all reminders enabled by default)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id                  TEXT    PRIMARY KEY,
  remind_24h               INTEGER NOT NULL DEFAULT 1,
  remind_1h                INTEGER NOT NULL DEFAULT 1,
  remind_10m               INTEGER NOT NULL DEFAULT 1,
  notify_net_change        INTEGER NOT NULL DEFAULT 0,  -- NET / T-0 changed (default off)
  notify_status_change     INTEGER NOT NULL DEFAULT 0,  -- non-terminal status changed (default off)
  notify_terminal_status   INTEGER NOT NULL DEFAULT 1,  -- success / failure / partial failure (default on)
  auto_live_activity       INTEGER NOT NULL DEFAULT 1,  -- automatically start Live Activity (default on)
  live_activity_window     INTEGER NOT NULL DEFAULT 3600, -- seconds before T-0 to start (14400=4h, 3600=1h, 1800=30m)
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Section-level subscriptions (one row per subscribed For You section)
CREATE TABLE IF NOT EXISTS section_subscriptions (
  user_id      TEXT    NOT NULL,
  section_id   TEXT    NOT NULL,   -- ForYouSection.id (UUID string)
  all_upcoming INTEGER NOT NULL DEFAULT 0,  -- 1 = subscribe to every upcoming launch
  PRIMARY KEY (user_id, section_id)
);

-- Provider entries for a section subscription
CREATE TABLE IF NOT EXISTS section_subscription_providers (
  user_id     TEXT    NOT NULL,
  section_id  TEXT    NOT NULL,
  provider_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, section_id, provider_id)
);

-- Location entries for a section subscription
CREATE TABLE IF NOT EXISTS section_subscription_locations (
  user_id     TEXT    NOT NULL,
  section_id  TEXT    NOT NULL,
  location_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, section_id, location_id)
);

-- Explicit per-launch opt-outs for users with subscribe_all_upcoming or fan-out subscriptions.
-- Prevents a manual unsubscribe from being overridden on the next launch sync.
CREATE TABLE IF NOT EXISTS launch_opt_outs (
  user_id   TEXT NOT NULL,
  launch_id TEXT NOT NULL,
  PRIMARY KEY (user_id, launch_id)
);

CREATE INDEX IF NOT EXISTS idx_timeline_fire ON timeline_events(fire_at, sent_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_launch ON subscriptions(launch_id);
CREATE INDEX IF NOT EXISTS idx_launches_t0 ON launches(t0);

-- Master on/off + source list for news notifications per user
CREATE TABLE IF NOT EXISTS user_news_preferences (
  user_id    TEXT    PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Which news sources a user has selected (empty = all sources)
CREATE TABLE IF NOT EXISTS user_news_sources (
  user_id TEXT NOT NULL,
  source  TEXT NOT NULL,
  PRIMARY KEY (user_id, source)
);

-- Deduplication log — prevents re-sending the same article
CREATE TABLE IF NOT EXISTS news_dispatch_log (
  article_id    INTEGER PRIMARY KEY,
  dispatched_at INTEGER NOT NULL DEFAULT (unixepoch())
);
