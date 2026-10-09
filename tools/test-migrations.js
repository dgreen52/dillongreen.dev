// D1 migration checks on throwaway LOCAL databases (never --remote, never the dev database: every run
// uses its own --persist-to folder under .wrangler/, deleted afterwards).
//   node tools/test-migrations.js
// db/migrations/002_guestbook_country.sql must:
//   * add guestbook.country to a table made by the old schema, keeping every row, id and timestamp
//   * be safe to run again (and again), keeping countries stored in between
//   * work on an empty database and on one made from the current db/schema.sql
//   * leave the indexes and the CHECK on country in place
// and `wrangler d1 migrations apply` must apply it once, then report nothing left to apply.
// Set WRANGLER to a wrangler binary if `npx wrangler` isn't usable offline.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const WRANGLER = process.env.WRANGLER || "npx wrangler";
const MIGRATION = "db/migrations/002_guestbook_country.sql";
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };

// the guestbook table as db/schema.sql created it before 002
const OLD_SCHEMA = `CREATE TABLE IF NOT EXISTS guestbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT, message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  ip_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_guestbook_status_created ON guestbook (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guestbook_ip_created ON guestbook (ip_hash, created_at);
INSERT INTO guestbook (id, name, url, message, status, ip_hash, created_at) VALUES
  (1, 'Ada', 'example.com', 'Hello from the hangar.', 'approved', '', '2026-10-01 10:00:00'),
  (2, 'Grace', NULL, 'Second!', 'pending', 'abc', '2026-10-02 11:30:00'),
  (5, 'Linus', NULL, 'Gap in the ids on purpose', 'approved', '', '2026-10-03 12:45:00');`;

const dirs = [];
function freshDir(tag) {
  const d = path.join(ROOT, ".wrangler", `migration-test-${process.pid}-${tag}`);
  fs.rmSync(d, { recursive: true, force: true });
  dirs.push(d);
  return d;
}
function wrangler(args) {
  return execSync(`${WRANGLER} ${args}`, { cwd: ROOT, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
}
function exec(dir, { file, command }) {
  const what = file ? `--file "${file}"` : `--command "${command.replace(/"/g, '\\"')}"`;
  const out = wrangler(`d1 execute dillongreen-db --local --persist-to "${dir}" --json ${what}`);
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[parsed.length - 1].results;
}
function tryExec(dir, opts) {
  try { exec(dir, opts); return null; } catch (e) { return String((e.stderr || "") + (e.stdout || "") + e.message); }
}
function tmpSql(dir, sql) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "seed.sql");
  fs.writeFileSync(f, sql);
  return f;
}
const cols = (dir) => exec(dir, { command: "SELECT name FROM pragma_table_info('guestbook') ORDER BY cid" }).map((r) => r.name);
const rows = (dir) => exec(dir, { command: "SELECT id, name, url, message, status, ip_hash, created_at, country FROM guestbook ORDER BY id" });
const indexes = (dir) => exec(dir, { command: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'guestbook' AND name LIKE 'idx_%' ORDER BY name" }).map((r) => r.name);
const tables = (dir) => exec(dir, { command: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'guestbook%' ORDER BY name" }).map((r) => r.name);
const WANT_COLS = "id,name,url,message,status,ip_hash,created_at,country";
const WANT_IDX = "idx_guestbook_ip_created,idx_guestbook_status_created";

try {
  /* ---- an existing database made by the old schema ---- */
  {
    const dir = freshDir("old");
    exec(dir, { file: tmpSql(dir, OLD_SCHEMA) });
    const before = exec(dir, { command: "SELECT id, name, url, message, status, ip_hash, created_at FROM guestbook ORDER BY id" });
    check(!cols(dir).includes("country") && before.length === 3, "old schema: 3 rows, no country column");

    exec(dir, { file: MIGRATION });
    let after = rows(dir);
    check(cols(dir).join() === WANT_COLS, "after 002: columns " + cols(dir).join());
    check(after.length === 3 && after.every((r, i) => ["id", "name", "url", "message", "status", "ip_hash", "created_at"].every((k) => r[k] === before[i][k]) && r.country === null),
      "after 002: every row, id (gap kept) and timestamp unchanged, country NULL");
    check(indexes(dir).join() === WANT_IDX && tables(dir).join() === "guestbook", "after 002: both indexes back, no guestbook_v2 left over");

    exec(dir, { command: "UPDATE guestbook SET country = 'NZ' WHERE id = 1; UPDATE guestbook SET country = 'CA' WHERE id = 5;" });
    exec(dir, { file: MIGRATION });
    after = rows(dir);
    check(cols(dir).join() === WANT_COLS && after.length === 3 && after[0].country === "NZ" && after[1].country === null && after[2].country === "CA",
      "re-run: same columns, same rows, stored countries kept (NZ, NULL, CA)");
    exec(dir, { file: MIGRATION });
    check(JSON.stringify(rows(dir)) === JSON.stringify(after) && indexes(dir).join() === WANT_IDX && tables(dir).join() === "guestbook", "third run: identical");

    // new rows still get fresh ids above the kept ones, and the CHECK on country holds
    exec(dir, { command: "INSERT INTO guestbook (name, message, ip_hash, country) VALUES ('New', 'hi', 'x', 'US')" });
    const added = exec(dir, { command: "SELECT id, country, status FROM guestbook WHERE name = 'New'" })[0];
    check(added && added.id > 5 && added.country === "US" && added.status === "pending", `insert after migration: id ${added && added.id}, default status pending`);
    const bad = ["usa", "us", "U1", "<b"].map((c) => tryExec(dir, { command: `INSERT INTO guestbook (name, message, ip_hash, country) VALUES ('Bad', 'x', 'x', '${c}')` }));
    check(bad.every((e) => e && /CHECK constraint failed/i.test(e)), "CHECK refuses country values that aren't two capital letters (usa, us, U1, <b)");
    check(!tryExec(dir, { command: "INSERT INTO guestbook (name, message, ip_hash) VALUES ('Nil', 'x', 'x')" }), "country may be NULL");
  }

  /* ---- an empty database, and one made from the current schema.sql ---- */
  {
    const dir = freshDir("empty");
    fs.mkdirSync(dir, { recursive: true });
    exec(dir, { file: MIGRATION });
    exec(dir, { file: MIGRATION });
    check(cols(dir).join() === WANT_COLS && indexes(dir).join() === WANT_IDX, "empty database: 002 creates the table (twice is fine)");
  }
  {
    const dir = freshDir("current");
    fs.mkdirSync(dir, { recursive: true });
    exec(dir, { file: "db/schema.sql" });
    check(cols(dir).join() === WANT_COLS, "db/schema.sql alone already has the country column");
    exec(dir, { command: "INSERT INTO guestbook (name, message, ip_hash, country, status) VALUES ('Kim', 'hey', 'x', 'KR', 'approved')" });
    exec(dir, { file: MIGRATION });
    exec(dir, { file: "db/schema.sql" }); // and schema.sql stays harmless on a migrated database
    const r = rows(dir);
    check(r.length === 1 && r[0].country === "KR" && indexes(dir).join() === WANT_IDX, "schema.sql, then 002, then schema.sql again: row and country kept");
  }

  /* ---- wrangler's own migration tracking (wrangler.toml migrations_dir = db/migrations) ---- */
  {
    const dir = freshDir("tracked");
    exec(dir, { file: tmpSql(dir, OLD_SCHEMA) });
    const first = wrangler(`d1 migrations apply dillongreen-db --local --persist-to "${dir}"`);
    check(/002_guestbook_country\.sql/.test(first) && cols(dir).join() === WANT_COLS && rows(dir).length === 3, "migrations apply: runs 002 on an old database");
    const second = wrangler(`d1 migrations apply dillongreen-db --local --persist-to "${dir}"`);
    check(/No migrations to apply/i.test(second), "migrations apply again: nothing to apply");
  }
} catch (e) {
  fails++;
  console.error("!! " + String(e.stderr || e.message || e).split("\n").slice(0, 12).join("\n   "));
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : "\nall migration tests passed");
process.exitCode = fails ? 1 : 0;
