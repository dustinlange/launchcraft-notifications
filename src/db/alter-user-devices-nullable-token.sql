-- Migration: make user_devices.device_token nullable
-- Run with: wrangler d1 execute launchcraft-db --remote --file=src/db/alter-user-devices-nullable-token.sql
--
-- device_token was NOT NULL, which meant clearDeviceToken()'s
-- "UPDATE user_devices SET device_token = NULL" has been silently failing
-- (constraint violation swallowed by Promise.allSettled) every time it's
-- ever been called, for any user. SQLite can't drop a column constraint
-- directly, so this rebuilds the table.

CREATE TABLE user_devices_new (
  user_id                 TEXT PRIMARY KEY,
  device_token            TEXT,
  push_to_start_token     TEXT,
  updated_at              INTEGER NOT NULL DEFAULT (unixepoch()),
  pro_active              INTEGER NOT NULL DEFAULT 0,
  original_transaction_id TEXT
);

INSERT INTO user_devices_new (user_id, device_token, push_to_start_token, updated_at, pro_active, original_transaction_id)
SELECT user_id, device_token, push_to_start_token, updated_at, pro_active, original_transaction_id
FROM user_devices;

DROP TABLE user_devices;

ALTER TABLE user_devices_new RENAME TO user_devices;
