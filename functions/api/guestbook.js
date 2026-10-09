// /api/guestbook
//   GET  -> approved entries, newest first (max 100), plus the approved total.
//   POST -> { name, url?, message, fax (honeypot) } stored as 'pending' until approved by hand.
import {
  json, MSG, clean, charLen, countUrls, readJson, sameOrigin, trippedHoneypot, ipHash,
  capClause, inserted, ownLimitHit, purgeOldHashes,
} from "../_lib/forms.js";
import { notifyOwner, lastRowId } from "../_lib/notify.js";

const LIMITS = { name: 40, url: 80, message: 280 };
// Rate limit + insert in ONE statement (atomic in D1): see capClause in ../_lib/forms.js.
const INSERT = "INSERT INTO guestbook (name, url, message, status, ip_hash) SELECT ?1, ?2, ?3, 'pending', ?4 WHERE " +
  capClause("guestbook", "?4");
const URL_FIELD = /^(?:https?:\/\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?::\d{2,5})?(?:\/\S*)?$/i;
const THANKS = "Thanks for signing! Your entry will show up once I've had a look.";

export async function onRequestGet({ env }) {
  if (!env.DB) return json(503, { ok: false, error: MSG.offline });
  try {
    const [rows, total] = await env.DB.batch([
      env.DB.prepare(
        "SELECT name, url, message, created_at FROM guestbook WHERE status = 'approved' ORDER BY created_at DESC, id DESC LIMIT 100"
      ),
      env.DB.prepare("SELECT COUNT(*) AS n FROM guestbook WHERE status = 'approved'"),
    ]);
    const entries = rows.results.map((r) => ({
      name: r.name, url: r.url || "", message: r.message, date: String(r.created_at || "").slice(0, 10),
    }));
    return json(200, { ok: true, total: Number(total.results[0].n) || 0, entries }, { "Cache-Control": "public, max-age=60" });
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
    const ins = await env.DB.prepare(INSERT).bind(name, url || null, message, hash).run();
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
