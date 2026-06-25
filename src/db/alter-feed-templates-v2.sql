-- Migration: simplify feed_templates — drop system_image/agency_names/agency_abbrevs, add location_ids
-- Run with: wrangler d1 execute launchcraft-db --remote --file=src/db/alter-feed-templates-v2.sql

ALTER TABLE feed_templates DROP COLUMN system_image;
ALTER TABLE feed_templates DROP COLUMN agency_names;
ALTER TABLE feed_templates DROP COLUMN agency_abbrevs;
ALTER TABLE feed_templates ADD COLUMN location_ids TEXT NOT NULL DEFAULT '[]';
