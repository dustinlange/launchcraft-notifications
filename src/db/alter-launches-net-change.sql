-- Adds NET-change tracking columns to launches.
-- Run once against the remote DB: wrangler d1 execute launchcraft-db --remote --file=src/db/alter-launches-net-change.sql
ALTER TABLE launches ADD COLUMN previous_t0 INTEGER;
ALTER TABLE launches ADD COLUMN net_changed_at INTEGER;
