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
  provider_logo_url        TEXT,              -- LL2 agency logo image URL
  provider_social_logo_url TEXT,              -- LL2 agency square/social icon (used as nationUrl in Live Activity)
  image_url          TEXT,                    -- LL2 launch image URL
  rocket_image_url   TEXT,                    -- LL2 rocket configuration image URL (fallback)
  mission_patch_url  TEXT,                    -- highest-priority mission patch image URL
  landing_location   TEXT,                    -- first stage landing location abbrev e.g. "OCISLY", "LZ-1"
  landing_type_id    INTEGER,                 -- first stage landing type ID (1=ASDS drone ship, 2=RTLS etc.)
  ll2_status_id    INTEGER NOT NULL DEFAULT 1,  -- LL2 status ID: 1=Go,2=TBD,3=Success,4=Failure,5=Hold,6=InFlight,7=PartialFailure,8=TBC
  has_timeline     INTEGER NOT NULL DEFAULT 0,
  is_crewed        INTEGER,                     -- 1 = crewed mission, 0 = uncrewed, NULL = unknown
  success_at       INTEGER,                     -- unix timestamp when status first became 'success'
  end_dispatched   INTEGER NOT NULL DEFAULT 0,  -- 1 after end push sent ~30min post terminal status
  webcast_live     INTEGER,                     -- 1 = webcast is currently live, 0/NULL = not live
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
CREATE TABLE IF NOT EXISTS launch_subscriptions (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  launch_id         TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  activity_token      TEXT,            -- Live Activity push token; NULL until activity started
  activity_id         TEXT,            -- ActivityKit activity identifier
  attributes_json     TEXT,            -- JSON-encoded LaunchActivityAttributes for push-to-start
  start_dispatched    INTEGER NOT NULL DEFAULT 0,
  reminded_24h        INTEGER NOT NULL DEFAULT 0,
  reminded_1h         INTEGER NOT NULL DEFAULT 0,
  reminded_10m        INTEGER NOT NULL DEFAULT 0,
  webcast_notified    INTEGER NOT NULL DEFAULT 0,  -- 1 after webcast-live push sent
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
  event_remind_24h         INTEGER NOT NULL DEFAULT 1,  -- event reminder 24h before (default on)
  event_remind_1h          INTEGER NOT NULL DEFAULT 1,  -- event reminder 1h before (default on)
  event_remind_10m         INTEGER NOT NULL DEFAULT 1,  -- event reminder 10m before (default on)
  notify_webcast_live      INTEGER NOT NULL DEFAULT 1,  -- webcast goes live (default on)
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Feed-level subscriptions (one row per subscribed For You feed).
-- Previously named section_subscriptions.
-- D1 migration:
--   ALTER TABLE section_subscriptions RENAME TO feed_subscriptions;
--   ALTER TABLE feed_subscriptions ADD COLUMN section_type TEXT NOT NULL DEFAULT 'launches';
--   ALTER TABLE feed_subscriptions ADD COLUMN in_space_only INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS feed_subscriptions (
  user_id       TEXT NOT NULL,
  feed_id       TEXT NOT NULL,   -- ForYouSection.id (UUID string)
  section_type  TEXT NOT NULL DEFAULT 'launches',  -- 'launches'|'events'|'news'|'astronauts'
  all_upcoming  INTEGER NOT NULL DEFAULT 0,   -- launches: 1 = subscribe to every upcoming launch
  crewed_only   INTEGER,                      -- launches: NULL = all, 1 = crewed only, 0 = uncrewed only
  in_space_only INTEGER NOT NULL DEFAULT 0,   -- astronauts: 1 = only notify for in-space astronauts
  PRIMARY KEY (user_id, feed_id)
);

-- Provider entries for a launch feed subscription.
-- Previously named section_subscription_providers.
-- D1 migration: ALTER TABLE section_subscription_providers RENAME TO feed_subscription_providers;
CREATE TABLE IF NOT EXISTS feed_subscription_providers (
  user_id     TEXT    NOT NULL,
  feed_id     TEXT    NOT NULL,
  provider_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, feed_id, provider_id)
);

-- Location entries for a launch feed subscription.
-- Previously named section_subscription_locations.
-- D1 migration: ALTER TABLE section_subscription_locations RENAME TO feed_subscription_locations;
CREATE TABLE IF NOT EXISTS feed_subscription_locations (
  user_id     TEXT    NOT NULL,
  feed_id     TEXT    NOT NULL,
  location_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, feed_id, location_id)
);

-- Event type entries for an events feed subscription (empty = all event types)
CREATE TABLE IF NOT EXISTS feed_subscription_event_types (
  user_id       TEXT    NOT NULL,
  feed_id       TEXT    NOT NULL,
  event_type_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, feed_id, event_type_id)
);

-- News source entries for a news feed subscription (empty = all sources)
CREATE TABLE IF NOT EXISTS feed_subscription_news_sources (
  user_id  TEXT NOT NULL,
  feed_id  TEXT NOT NULL,
  source   TEXT NOT NULL,
  PRIMARY KEY (user_id, feed_id, source)
);

-- Astronaut agency entries for an astronauts feed subscription (empty = all agencies)
CREATE TABLE IF NOT EXISTS feed_subscription_astronaut_agencies (
  user_id    TEXT    NOT NULL,
  feed_id    TEXT    NOT NULL,
  agency_id  INTEGER NOT NULL,
  PRIMARY KEY (user_id, feed_id, agency_id)
);

-- Explicit per-launch opt-outs for users with subscribe_all_upcoming or fan-out subscriptions.
-- Prevents a manual unsubscribe from being overridden on the next launch sync.
CREATE TABLE IF NOT EXISTS launch_opt_outs (
  user_id   TEXT NOT NULL,
  launch_id TEXT NOT NULL,
  PRIMARY KEY (user_id, launch_id)
);

-- Upcoming space events from LL2 /events/upcoming/
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,  -- LL2 event ID
  name          TEXT NOT NULL,
  event_type_id INTEGER,
  event_type    TEXT,                 -- human-readable type name e.g. "Static Fire"
  description   TEXT,
  location      TEXT,
  date          INTEGER,              -- unix timestamp of the event
  image_url     TEXT,                 -- LL2 feature_image URL; attached by Notification Service Extension
  last_updated  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Deduplication log for event notifications — prevents re-sending the same reminder
CREATE TABLE IF NOT EXISTS event_dispatch_log (
  event_id      INTEGER NOT NULL,
  window_label  TEXT    NOT NULL,   -- '24h' | '1h'
  dispatched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (event_id, window_label)
);

-- Last-known in-space status for each astronaut, used to detect status changes
CREATE TABLE IF NOT EXISTS astronaut_status_snapshots (
  astronaut_id  INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  in_space         INTEGER NOT NULL DEFAULT 0,  -- 1 = currently in space
  agency_id        INTEGER,
  flights_count    INTEGER,
  entered_space_at INTEGER,                     -- unix timestamp of last 0→1 in_space transition
  last_checked     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Server-managed list of For You feed presets shown in the template picker.
-- Add/remove rows here (or via the D1 console) to update all app clients without a release.
CREATE TABLE IF NOT EXISTS feed_templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  title          TEXT    NOT NULL,
  logo_url       TEXT,                                    -- provider logo; shown as circle in top-left of card
  section_type   TEXT    NOT NULL DEFAULT 'launches',    -- 'launches' | 'events' | 'news' | 'astronauts'
  agency_ids     TEXT    NOT NULL DEFAULT '[]',           -- JSON int array  e.g. [121]
  agency_names   TEXT    NOT NULL DEFAULT '[]',           -- JSON string array e.g. ["SpaceX"]
  location_ids   TEXT    NOT NULL DEFAULT '[]',           -- JSON int array  e.g. [27]
  location_names TEXT    NOT NULL DEFAULT '[]',           -- JSON string array e.g. ["Cape Canaveral, FL, USA"]
  news_sources   TEXT    NOT NULL DEFAULT '[]',           -- JSON string array e.g. ["NASA"] (empty = all sources)
  crewed_only    INTEGER,                                 -- NULL = all missions, 1 = crewed only, 0 = uncrewed only
  in_space_only  INTEGER NOT NULL DEFAULT 0,
  launch_layout  TEXT    NOT NULL DEFAULT 'list',         -- 'list' | 'card'
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_timeline_fire ON timeline_events(fire_at, sent_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_launch ON launch_subscriptions(launch_id);
CREATE INDEX IF NOT EXISTS idx_launches_t0 ON launches(t0);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);

-- Legacy global news preference tables — superseded by per-feed news subscriptions.
-- Kept for reference; no longer read by the notification dispatch pipeline.
CREATE TABLE IF NOT EXISTS user_news_preferences (
  user_id    TEXT    PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

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
