-- Migration: add news_sources column to feed_templates
-- Run with: wrangler d1 execute launchcraft-db --remote --file=src/db/alter-feed-templates-v4.sql

ALTER TABLE feed_templates ADD COLUMN news_sources TEXT NOT NULL DEFAULT '[]';
