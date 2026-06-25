-- Migration: add location_names column to feed_templates
-- Run with: wrangler d1 execute launchcraft-db --remote --file=src/db/alter-feed-templates-v5.sql

ALTER TABLE feed_templates ADD COLUMN location_names TEXT NOT NULL DEFAULT '[]';
