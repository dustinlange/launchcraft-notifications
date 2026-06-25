-- Migration: add feed_templates table and seed default presets
-- Run with: wrangler d1 execute launchcraft-db --remote --file=src/db/add-feed-templates.sql

CREATE TABLE IF NOT EXISTS feed_templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  title          TEXT    NOT NULL,
  logo_url       TEXT,
  system_image   TEXT    NOT NULL DEFAULT 'rectangle.stack',
  section_type   TEXT    NOT NULL DEFAULT 'launches',
  agency_ids     TEXT    NOT NULL DEFAULT '[]',
  agency_names   TEXT    NOT NULL DEFAULT '[]',
  agency_abbrevs TEXT    NOT NULL DEFAULT '[]',
  in_space_only  INTEGER NOT NULL DEFAULT 0,
  launch_layout  TEXT    NOT NULL DEFAULT 'list',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO feed_templates (sort_order, title, logo_url, system_image, section_type, agency_ids, agency_names, agency_abbrevs, in_space_only, launch_layout) VALUES
  (0, 'All Upcoming Launches', NULL,          'rocket',         'launches',   '[]',    '[]',             '[]',       0, 'list'),
  (1, 'Who''s in Space Now?',  NULL,          'person.2.circle','astronauts', '[]',    '[]',             '[]',       1, 'list'),
  (2, 'SpaceX Launches',       'https://spacelaunchnow-prod-east.nyc3.digitaloceanspaces.com/media/logo/spacex0/logo_20220826094919.png',       'flame',      'launches',   '[121]', '["SpaceX"]',     '["SpX"]',  0, 'list'),
  (3, 'Blue Origin Launches',  'https://spacelaunchnow-prod-east.nyc3.digitaloceanspaces.com/media/logo/blue_origin0/logo_20220826094813.png',  'cloud',      'launches',   '[141]', '["Blue Origin"]','["BO"]',   0, 'list'),
  (4, 'NASA Launches',         'https://spacelaunchnow-prod-east.nyc3.digitaloceanspaces.com/media/logo/national_aeronautics_and_space_administration0/logo_20190207124401.jpg', 'star.circle', 'launches', '[44]', '["NASA"]', '["NASA"]', 0, 'list');
