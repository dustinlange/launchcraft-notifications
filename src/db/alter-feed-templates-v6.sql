-- Migration: add crewed_only column to feed_templates (NULL = all, 1 = crewed, 0 = uncrewed)
-- Run with: wrangler d1 execute launchcraft-db --remote --file=src/db/alter-feed-templates-v6.sql

ALTER TABLE feed_templates ADD COLUMN crewed_only INTEGER;
