-- dillongreen.dev: guestbook + studio waitlist (Cloudflare D1, SQLite dialect).
-- Safe to re-run: every statement is IF NOT EXISTS.
--   local:  npx wrangler d1 execute dillongreen-db --local  --file db/schema.sql
--   remote: npx wrangler d1 execute dillongreen-db --remote --file db/schema.sql
-- Timestamps are UTC text ('YYYY-MM-DD HH:MM:SS') so they compare correctly as strings.
-- This file is the whole current schema, for a new database. An existing database is brought up to date
-- by db/migrations/ (each one safe to re-run), e.g.
--   npx wrangler d1 migrations apply dillongreen-db --remote

CREATE TABLE IF NOT EXISTS guestbook (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  url        TEXT,                                   -- shown as plain text, never linked
  message    TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'approved')),
  ip_hash    TEXT    NOT NULL,                       -- SHA-256(ip + salt), for rate limiting only
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  country    TEXT                                    -- CF-IPCountry (2 letters) or NULL; never the IP (002)
             CHECK (country IS NULL OR (length(country) = 2 AND country GLOB '[A-Z][A-Z]'))
);
-- public listing: approved entries, newest first
CREATE INDEX IF NOT EXISTS idx_guestbook_status_created ON guestbook (status, created_at DESC);
-- rate limit: posts per ip_hash in the last hour
CREATE INDEX IF NOT EXISTS idx_guestbook_ip_created ON guestbook (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS waitlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL,
  role       TEXT    NOT NULL,
  org_size   TEXT,
  workflow   TEXT,
  notify     INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0, 1)),
  ip_hash    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_waitlist_ip_created ON waitlist (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist (email);
