-- Migration: restore agency_names column on feed_templates
-- Run with: wrangler d1 execute launchcraft-db --remote --file=src/db/alter-feed-templates-v3.sql

ALTER TABLE feed_templates ADD COLUMN agency_names TEXT NOT NULL DEFAULT '[]';
