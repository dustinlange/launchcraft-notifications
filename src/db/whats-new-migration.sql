CREATE TABLE IF NOT EXISTS whats_new_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version     TEXT    NOT NULL UNIQUE,
  title       TEXT,
  released_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS whats_new_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES whats_new_versions(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL DEFAULT 'feature',
  title      TEXT    NOT NULL,
  body       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_whats_new_items_version ON whats_new_items(version_id, sort_order);
