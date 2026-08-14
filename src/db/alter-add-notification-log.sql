-- Migration: add notification_log table (backs /admin/metrics push counters)
-- Run with: wrangler d1 execute launchcraft-db --remote --file=src/db/alter-add-notification-log.sql

CREATE TABLE IF NOT EXISTS notification_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  type     TEXT    NOT NULL,
  user_id  TEXT,
  success  INTEGER NOT NULL,
  sent_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_notification_log_sent_at ON notification_log(sent_at);
CREATE INDEX IF NOT EXISTS idx_notification_log_type ON notification_log(type, sent_at);
