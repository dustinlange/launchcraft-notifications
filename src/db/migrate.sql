-- =============================================================================
-- Migration: section_subscriptions → feed_subscriptions (breaking change)
-- Safe to run because the app is not yet in production.
-- =============================================================================

-- Drop old section subscription tables (replaced by feed_subscription_*)
DROP TABLE IF EXISTS section_subscription_locations;
DROP TABLE IF EXISTS section_subscription_providers;
DROP TABLE IF EXISTS section_subscriptions;

-- Drop new tables in case a partial migration was attempted previously
DROP TABLE IF EXISTS feed_subscription_astronaut_agencies;
DROP TABLE IF EXISTS feed_subscription_news_sources;
DROP TABLE IF EXISTS feed_subscription_event_types;
DROP TABLE IF EXISTS feed_subscription_locations;
DROP TABLE IF EXISTS feed_subscription_providers;
DROP TABLE IF EXISTS feed_subscriptions;

DROP TABLE IF EXISTS astronaut_status_snapshots;
DROP TABLE IF EXISTS event_dispatch_log;
DROP TABLE IF EXISTS events;

-- -------------------------------------------------------------------------
-- Feed-level subscriptions (one row per subscribed For You feed)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_subscriptions (
  user_id       TEXT NOT NULL,
  feed_id       TEXT NOT NULL,   -- ForYouSection.id (UUID string)
  section_type  TEXT NOT NULL DEFAULT 'launches',  -- 'launches'|'events'|'news'|'astronauts'
  all_upcoming  INTEGER NOT NULL DEFAULT 0,   -- launches: 1 = subscribe to every upcoming launch
  in_space_only INTEGER NOT NULL DEFAULT 0,   -- astronauts: 1 = only notify for in-space astronauts
  PRIMARY KEY (user_id, feed_id)
);

-- Provider entries for a launch feed subscription
CREATE TABLE IF NOT EXISTS feed_subscription_providers (
  user_id     TEXT    NOT NULL,
  feed_id     TEXT    NOT NULL,
  provider_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, feed_id, provider_id)
);

-- Location entries for a launch feed subscription
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

-- -------------------------------------------------------------------------
-- Upcoming space events from LL2 /events/upcoming/
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,  -- LL2 event ID
  name          TEXT NOT NULL,
  event_type_id INTEGER,
  event_type    TEXT,                 -- human-readable type name e.g. "Static Fire"
  description   TEXT,
  location      TEXT,
  date          INTEGER,              -- unix timestamp of the event
  last_updated  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Deduplication log for event notifications
CREATE TABLE IF NOT EXISTS event_dispatch_log (
  event_id      INTEGER NOT NULL,
  window_label  TEXT    NOT NULL,   -- '24h' | '1h'
  dispatched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (event_id, window_label)
);

-- -------------------------------------------------------------------------
-- Astronaut status snapshots — used to detect enters/leaves-space changes
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS astronaut_status_snapshots (
  astronaut_id  INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  in_space      INTEGER NOT NULL DEFAULT 0,  -- 1 = currently in space
  agency_id     INTEGER,
  flights_count INTEGER,
  last_checked  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- -------------------------------------------------------------------------
-- Indexes
-- -------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
