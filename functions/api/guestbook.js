// /api/guestbook
//   GET  -> approved entries, newest first (max 100), the approved total, and `countries`: the distinct
//           country codes of approved entries (most signatures first), never tied to a name.
//   POST -> { name, url?, message, fax (honeypot) } stored as 'pending' until approved by hand, with the
//           visitor's country from Cloudflare's CF-IPCountry header (two letters, or NULL).
// The country column comes from db/migrations/002_guestbook_country.sql. Until that migration has run,
// both handlers fall back to the old column set, so deploying the code first can't break signing.
import {
  json, MSG, clean, charLen, countUrls, readJson, sameOrigin, trippedHoneypot, ipHash,
  capClause, inserted, ownLimitHit, purgeOldHashes, requestCountry, countryCode,
} from "../_lib/forms.js";
import { notifyOwner, lastRowId } from "../_lib/notify.js";

const LIMITS = { name: 40, url: 80, message: 280 };
// Rate limit + insert in ONE statement (atomic in D1): see capClause in ../_lib/forms.js.
const INSERT = "INSERT INTO guestbook (name, url, message, status, ip_hash, country) SELECT ?1, ?2, ?3, 'pending', ?4, ?5 WHERE " +
  capClause("guestbook", "?4");
const INSERT_NO_COUNTRY = "INSERT INTO guestbook (name, url, message, status, ip_hash) SELECT ?1, ?2, ?3, 'pending', ?4 WHERE " +
  capClause("guestbook", "?4");
const LIST = "SELECT name, url, message, created_at FROM guestbook WHERE status = 'approved' ORDER BY created_at DESC, id DESC LIMIT 100";
const TOTAL = "SELECT COUNT(*) AS n FROM guestbook WHERE status = 'approved'";
const COUNTRIES = "SELECT country, COUNT(*) AS n, MIN(created_at) AS first FROM guestbook " +
  "WHERE status = 'approved' AND country IS NOT NULL GROUP BY country ORDER BY n DESC, first ASC, country ASC LIMIT 250";
// D1 says "no such column: country" (SELECT) or "table guestbook has no column named country" (INSERT)
const NO_COUNTRY_COLUMN = /no such column: country|has no column named country/i;
const URL_FIELD = /^(?:https?:\/\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?::\d{2,5})?(?:\/\S*)?$/i;
const THANKS = "Thanks for signing! Your entry will show up once I've had a look.";

export async function onRequestGet({ env }) {
  if (!env.DB) return json(503, { ok: false, error: MSG.offline });
  try {
    let rows, total, geo = { results: [] };
    try {
      [rows, total, geo] = await env.DB.batch([env.DB.prepare(LIST), env.DB.prepare(TOTAL), env.DB.prepare(COUNTRIES)]);
    } catch (e) {
      if (!NO_COUNTRY_COLUMN.test(String(e && e.message))) throw e;
      console.error("guestbook GET: no country column yet (apply db/migrations/002_guestbook_country.sql)");
      [rows, total] = await env.DB.batch([env.DB.prepare(LIST), env.DB.prepare(TOTAL)]);
    }
    const entries = rows.results.map((r) => ({
      name: r.name, url: r.url || "", message: r.message, date: String(r.created_at || "").slice(0, 10),
    }));
    const countries = geo.results.map((r) => countryCode(r.country)).filter(Boolean);
    return json(200, { ok: true, total: Number(total.results[0].n) || 0, entries, countries }, { "Cache-Control": "public, max-age=60" });
  } catch (e) {
    console.error("guestbook GET failed", e && e.message);
    return json(500, { ok: false, error: MSG.offline });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!sameOrigin(request)) return json(403, { ok: false, error: MSG.badRequest });
  const data = await readJson(request);
  if (!data) return json(400, { ok: false, error: MSG.badRequest });
  // Bots that fill every field get a cheerful reply and nothing is stored.
  if (trippedHoneypot(data)) return json(200, { ok: true, message: THANKS });

  const name = clean(data.name, false);
  const url = clean(data.url, false);
  const message = clean(data.message, true);

  // `field` names the input to highlight; the form focuses it and shows the message next to the button.
  if (!name) return json(400, { ok: false, field: "name", error: "Please add your name." });
  if (!message) return json(400, { ok: false, field: "message", error: "Please add a message." });
  if (charLen(name) > LIMITS.name) return json(400, { ok: false, field: "name", error: `Names can be up to ${LIMITS.name} characters.` });
  if (charLen(message) > LIMITS.message) return json(400, { ok: false, field: "message", error: `Messages can be up to ${LIMITS.message} characters.` });
  if (url && (charLen(url) > LIMITS.url || !URL_FIELD.test(url))) {
    return json(400, { ok: false, field: "url", error: "That site address doesn't look right. Something like example.com works." });
  }
  if (countUrls(message) > 1) return json(400, { ok: false, field: "message", error: "One link per message, please. Your site can go in the site field." });
  if (countUrls(name) > 0) return json(400, { ok: false, field: "name", error: "Put your site in the site field, and just your name in the name field." });

  if (!env.DB) return json(503, { ok: false, error: MSG.offline });
  try {
    const hash = await ipHash(request, env);
    if (!hash) {
      console.error("guestbook POST refused: IP_SALT is not set");
      return json(503, { ok: false, error: MSG.offline });
    }
    let ins;
    try {
      ins = await env.DB.prepare(INSERT).bind(name, url || null, message, hash, requestCountry(request)).run();
    } catch (e) {
      if (!NO_COUNTRY_COLUMN.test(String(e && e.message))) throw e;
      console.error("guestbook POST: no country column yet (apply db/migrations/002_guestbook_country.sql)");
      ins = await env.DB.prepare(INSERT_NO_COUNTRY).bind(name, url || null, message, hash).run();
    }
    if (!inserted(ins)) {
      const own = await ownLimitHit(env.DB, "guestbook", hash);
      return json(429, { ok: false, error: own ? "You've signed a few times already. Try again in an hour." : MSG.busy });
    }
    await purgeOldHashes(env.DB, "guestbook");
    // Owner email alert (dg-notify via the NOTIFY binding): fire-and-forget, never changes this reply. No ip_hash.
    notifyOwner(context, { type: "guestbook", id: lastRowId(ins), name, url: url || "", message });
    return json(201, { ok: true, message: THANKS });
  } catch (e) {
    console.error("guestbook POST failed", e && e.message);
    return json(500, { ok: false, error: MSG.offline });
  }
}
