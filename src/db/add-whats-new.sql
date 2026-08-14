-- Migration: add whats_new table
-- Run with: wrangler d1 execute launchcraft-db --remote --file=src/db/add-whats-new.sql
--
-- Backs the "What's New in Launchcraft" modal the app shows once after each
-- update. One row per app version; the highlights are a JSON blob so an admin
-- write replaces a whole release's content in a single upsert.

CREATE TABLE IF NOT EXISTS whats_new (
  version     TEXT    PRIMARY KEY,               -- CFBundleShortVersionString, e.g. '2026.3'
  title       TEXT    NOT NULL DEFAULT 'What''s New',
  items       TEXT    NOT NULL DEFAULT '[]',     -- [{ "systemImage": "", "title": "", "description": "" }]
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
