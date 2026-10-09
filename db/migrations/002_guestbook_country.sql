-- 002: guestbook.country, the visitor's country as Cloudflare reports it (CF-IPCountry, two letters) or
-- NULL. Never the IP. Shown publicly only as the "signed from N countries" flag row of approved entries.
-- (001 is the original db/schema.sql.)
--
-- Safe to run more than once, on any version of the table, and on an empty database:
--   npx wrangler d1 migrations apply dillongreen-db --remote      (tracked: runs once)
--   npx wrangler d1 execute dillongreen-db --remote --file db/migrations/002_guestbook_country.sql
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so instead of ALTER TABLE ... ADD COLUMN (which fails the
-- second time) the table is rebuilt: copy every row into a new table that has the column, carry over any
-- countries already stored, swap the tables, recreate the indexes. Rows keep their ids.
--
-- The trick that makes it re-runnable is in step 4: inside the correlated subquery an unqualified
-- `country` resolves to guestbook.country when the old table has that column, and otherwise falls back
-- to the outer guestbook_v2.country (still NULL), so the same statement works before and after.
-- Fail-safe: if a previous run was interrupted after step 5, guestbook_v2 still holds the data and step 2
-- stops with "table guestbook_v2 already exists" instead of touching it.

-- 1. a brand-new database: start from the current shape
CREATE TABLE IF NOT EXISTS guestbook (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  url        TEXT,
  message    TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  ip_hash    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  country    TEXT    CHECK (country IS NULL OR (length(country) = 2 AND country GLOB '[A-Z][A-Z]'))
);

-- 2. the new table (same definition as db/schema.sql)
CREATE TABLE guestbook_v2 (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  url        TEXT,
  message    TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  ip_hash    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  country    TEXT    CHECK (country IS NULL OR (length(country) = 2 AND country GLOB '[A-Z][A-Z]'))
);

-- 3. every row, ids included
INSERT INTO guestbook_v2 (id, name, url, message, status, ip_hash, created_at)
  SELECT id, name, url, message, status, ip_hash, created_at FROM guestbook;

-- 4. countries already stored (a re-run); a no-op the first time (see above)
UPDATE guestbook_v2 SET country = (SELECT country FROM guestbook AS g WHERE g.id = guestbook_v2.id);

-- 5. swap
DROP TABLE guestbook;
ALTER TABLE guestbook_v2 RENAME TO guestbook;

-- 6. the indexes went with the old table
CREATE INDEX IF NOT EXISTS idx_guestbook_status_created ON guestbook (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guestbook_ip_created ON guestbook (ip_hash, created_at);
