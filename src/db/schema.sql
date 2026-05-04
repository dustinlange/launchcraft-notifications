-- Launches being tracked
CREATE TABLE IF NOT EXISTS launches (
  id            TEXT PRIMARY KEY,   -- launch provider ID (e.g. "ll2:12345")
  name          TEXT NOT NULL,
  rocket        TEXT NOT NULL,
  pad           TEXT NOT NULL,
  t0            INTEGER,            -- unix timestamp; NULL if NET not confirmed
  window_start  INTEGER,            -- launch window open (unix timestamp)
  window_end    INTEGER,            -- launch window close (unix timestamp)
  status        TEXT NOT NULL DEFAULT 'go',  -- go | hold | scrub | success | failure
  ll2_status_id    INTEGER NOT NULL DEFAULT 1,  -- raw LL2 status ID passed through to iOS widget
  has_timeline     INTEGER NOT NULL DEFAULT 0,
  success_at       INTEGER,                     -- unix timestamp when status first became 'success'
  end_dispatched   INTEGER NOT NULL DEFAULT 0,  -- 1 after end push sent ~30min post-success
  last_updated     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Per-user subscriptions to a launch
-- One row per (user, launch) pair; holds both APNs token types
CREATE TABLE IF NOT EXISTS subscriptions (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  launch_id         TEXT NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  device_token      TEXT NOT NULL,   -- standard APNs token for alert notifications
  activity_token      TEXT,            -- Live Activity push token; NULL until activity started
  activity_id         TEXT,            -- ActivityKit activity identifier
  push_to_start_token TEXT,            -- token for remotely starting a Live Activity
  attributes_json     TEXT,            -- JSON-encoded LaunchActivityAttributes for push-to-start
  start_dispatched    INTEGER NOT NULL DEFAULT 0,
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

CREATE INDEX IF NOT EXISTS idx_timeline_fire ON timeline_events(fire_at, sent_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_launch ON subscriptions(launch_id);
CREATE INDEX IF NOT EXISTS idx_launches_t0 ON launches(t0, status);
