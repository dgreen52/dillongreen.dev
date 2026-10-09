// Shared helpers for the guestbook and waitlist endpoints (Cloudflare Pages Functions).
// This module exports no onRequest* handler, so it never becomes a route of its own.

// ip_hash = HMAC-SHA-256(key = IP_SALT secret, message = the client's IP, or its /64 for IPv6).
// IP_SALT is set with `wrangler pages secret put IP_SALT`, so it never lives in the repo; without it
// the endpoints refuse posts instead of storing reversible hashes. Hashes are only compared with each
// other (rate limiting), never reversed, and are cleared after two days (purgeOldHashes).

export const RATE_LIMIT_PER_HOUR = 3;                              // per ip_hash, per table
export const GLOBAL_LIMIT_PER_HOUR = { guestbook: 20, waitlist: 30 }; // whole table, all visitors
export const MAX_BODY_BYTES = 8 * 1024;

const SECURITY_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export function json(status, body, extra) {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, ...(extra || {}) } });
}

// Generic, friendly replies. Raw errors are logged server-side and never sent to the browser.
export const MSG = {
  offline: "That didn't go through on my end. Please try again in a minute.",
  badRequest: "Something about that didn't look right. Please check the form and try again.",
  tooFast: "You've sent a few already. Give it an hour and try again.",
  busy: "Lots of people are writing in right now. Please try again in an hour.",
};

// Stripped from all user text: C0 controls (tab/newline are handled in clean()), DEL, C1 controls,
// bidi marks/overrides/isolates (U+061C, U+200E/F, U+202A-E, U+2066-9), the zero-width space,
// word joiner and BOM (U+200B, U+2060, U+FEFF), and the unassigned/deprecated start of the tag
// block (U+E0000-E001F). Kept on purpose: ZWNJ/ZWJ (U+200C/D), which emoji sequences such as the
// family and rainbow flag need (and scripts like Persian and the Indic ones), and the tag characters
// U+E0020-E007F that spell out subdivision flags (England, Scotland, Wales). Every entry is moderated
// by hand, so emoji fidelity wins over stripping every invisible code point.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u{E0000}-\u{E001F}]/gu;

/** Normalize user text: NFC, strip control/invisible chars, trim. Single-line fields lose newlines/tabs. */
export function clean(value, multiline) {
  if (typeof value !== "string") return "";
  let s = value.normalize("NFC").replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(CONTROL, "");
  if (multiline) {
    s = s.replace(/\t/g, " ").replace(/[ \u00A0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  } else {
    s = s.replace(/[\t\n]+/g, " ").replace(/\s{2,}/g, " ");
  }
  return s.trim();
}

/** Length in code points, so an emoji counts as one character. */
export const charLen = (s) => Array.from(s).length;

const URLISH = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|info|biz|io|co|dev|app|xyz|top|ru|cn|me|site|online|shop|store|link|click|live|life|pro|club|vip|win|ly|gg|tk)\b(?:\/\S*)?/gi;
export const countUrls = (s) => (s.match(URLISH) || []).length;

/**
 * Read a request body as text, refusing anything over maxBytes. Streams the body and stops (and
 * cancels the stream) as soon as the cap is passed, so a chunked upload without Content-Length is
 * never buffered whole. Returns the text, "" for no body, or null if too large / unreadable.
 */
export async function readCapped(request, maxBytes) {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && !(Number(declared) <= maxBytes)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch (e) { return null; }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch (e) { return null; }
}

/** Parse a JSON body defensively: JSON content type, small body, plain object. Returns null if unusable. */
export async function readJson(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!/^application\/json\b/i.test(type)) return null;
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch (e) { return null; }
}

/** Browsers send Origin on POST; refuse posts that come from some other site's page. */
export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // non-browser clients; the other checks still apply
  try { return new URL(origin).host === new URL(request.url).host; } catch (e) { return false; }
}

/** The honeypot field is visually hidden; a person leaves it empty. */
export const trippedHoneypot = (data) => typeof data.fax === "string" ? data.fax.trim() !== "" : data.fax != null;

/**
 * The rate-limit bucket for an IP: IPv4 (and IPv4-mapped) addresses as they are, IPv6 addresses
 * reduced to their /64 network, since one connection usually owns a whole /64 and could otherwise
 * rotate through endless addresses. "2001:db8:1:2::5" -> "2001:db8:1:2::/64".
 */
export function rateKey(ip) {
  const s = String(ip || "").trim().toLowerCase();
  if (!s.includes(":") || s.includes(".")) return s || "unknown";
  const halves = s.split("::");
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? Math.max(0, 8 - head.length - tail.length) : 0;
  const groups = head.concat(new Array(fill).fill("0"), tail);
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return s;
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

/**
 * HMAC-SHA-256 (hex) of the client's rate-limit bucket, keyed with the IP_SALT secret.
 * Cloudflare sets CF-Connecting-IP and clients can't override it. Returns null when IP_SALT is
 * missing: callers then refuse the post rather than store an unkeyed (reversible) hash.
 */
export async function ipHash(request, env) {
  const salt = env && typeof env.IP_SALT === "string" ? env.IP_SALT : "";
  if (!salt) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rateKey(request.headers.get("CF-Connecting-IP"))));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The visitor's country as Cloudflare sees it: the CF-IPCountry header (ISO 3166-1 alpha-2), never the
 * IP itself. Returns two upper-case letters, or null for anything else, including Cloudflare's "XX"
 * (no country data) and "T1" (Tor). Only the guestbook keeps it, for the "signed from N countries" row.
 */
export function countryCode(value) {
  const c = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : null;
}
export const requestCountry = (request) => countryCode(request.headers.get("CF-IPCountry"));

const TABLES = new Set(["guestbook", "waitlist"]);
function table(t) {
  if (!TABLES.has(t)) throw new Error("unknown table");
  return t;
}

/**
 * WHERE clause for an atomic INSERT ... SELECT ... WHERE: the row is only written while this
 * ip_hash (bound as hashParam) has fewer than RATE_LIMIT_PER_HOUR rows in the last hour AND the
 * whole table has fewer than its GLOBAL_LIMIT_PER_HOUR. One SQL statement runs atomically in D1,
 * so parallel requests can't all pass the check before any of them inserts.
 */
export function capClause(t, hashParam) {
  const tb = table(t);
  const perKey = Number(RATE_LIMIT_PER_HOUR), global = Number(GLOBAL_LIMIT_PER_HOUR[tb]);
  return `(SELECT COUNT(*) FROM ${tb} WHERE ip_hash = ${hashParam} AND created_at > datetime('now', '-1 hour')) < ${perKey}` +
    ` AND (SELECT COUNT(*) FROM ${tb} WHERE created_at > datetime('now', '-1 hour')) < ${global}`;
}

/** D1 run() result -> true when exactly the one row was written. */
export const inserted = (result) => Number(result && result.meta && result.meta.changes) === 1;

const RATE_SQL = {
  guestbook: "SELECT COUNT(*) AS n FROM guestbook WHERE ip_hash = ?1 AND created_at > datetime('now', '-1 hour')",
  waitlist: "SELECT COUNT(*) AS n FROM waitlist WHERE ip_hash = ?1 AND created_at > datetime('now', '-1 hour')",
};

/** True when this ip_hash has already posted RATE_LIMIT_PER_HOUR times to `table` in the last hour. */
export async function rateLimited(db, t, hash) {
  const row = await db.prepare(RATE_SQL[table(t)]).bind(hash).first();
  return Number(row && row.n) >= RATE_LIMIT_PER_HOUR;
}

/**
 * After a refused insert: was it this visitor's own limit (true) or the global one (false)?
 * Only picks the wording of the 429; any error counts as the visitor's own limit.
 */
export async function ownLimitHit(db, t, hash) {
  try { return await rateLimited(db, t, hash); } catch (e) { return true; }
}

/**
 * Clear ip_hash on rows older than two days (it only matters for the one-hour limit). Runs after
 * each successful insert; cheap, and never allowed to affect the visitor's reply.
 */
export async function purgeOldHashes(db, t) {
  try {
    await db.prepare(`UPDATE ${table(t)} SET ip_hash = '' WHERE ip_hash <> '' AND created_at < datetime('now', '-2 days')`).run();
  } catch (e) {
    console.error("ip_hash purge failed", e && e.message);
  }
}
