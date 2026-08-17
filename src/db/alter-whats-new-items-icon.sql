-- Migration: add system_image to whats_new_items
-- Run with: wrangler d1 execute launchcraft-db --remote --file=src/db/alter-whats-new-items-icon.sql
--
-- The app's "What's New" modal shows an SF Symbol per highlight, but the
-- normalized whats_new_items schema (whats-new-migration.sql) only carries
-- type/title/body. Adding the icon back as its own column rather than
-- deriving it from `type`, so each item can have a distinct symbol.

ALTER TABLE whats_new_items ADD COLUMN system_image TEXT NOT NULL DEFAULT 'sparkles';
