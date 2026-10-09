// Moderation API behind Cloudflare Access (used by /admin/, served at /api/admin/*).
//   GET  /api/admin/pending | approved | waitlist      -> { ok, who, counts, items }
//   POST /api/admin/approve | delete-guestbook | delete-waitlist   { id: <positive integer> } -> { ok, changed }
// Only answered on ADMIN_HOSTS (where Cloudflare Access sits in front); 404 on any other host
// (dillongreen.pages.dev, preview and per-deployment URLs). Every request: valid Access JWT
// (./access.js) or 403. POSTs also: same-origin Origin header (required), a JSON content type and a
// body of at most 1 KB. SQL is parameterized; ids must be positive integers.
// This module exports no onRequest* handler, so it never becomes a route of its own.
import { verifyAccess } from "./access.js";
import { readCapped } from "./forms.js";

export const ADMIN_HOSTS = new Set(["dillongreen.dev", "www.dillongreen.dev"]);
const MAX_ADMIN_BODY_BYTES = 1024;

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
};
const out = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });

const LISTS = {
  pending: "SELECT id, name, url, message, created_at FROM guestbook WHERE status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 200",
  approved: "SELECT id, name, url, message, created_at FROM guestbook WHERE status = 'approved' ORDER BY created_at DESC, id DESC LIMIT 500",
  waitlist: "SELECT id, email, role, org_size, workflow, notify, created_at FROM waitlist ORDER BY created_at DESC, id DESC LIMIT 500",
};
const COUNTS = "SELECT (SELECT COUNT(*) FROM guestbook WHERE status = 'pending') AS pending, " +
  "(SELECT COUNT(*) FROM guestbook WHERE status = 'approved') AS approved, (SELECT COUNT(*) FROM waitlist) AS waitlist";
const ACTIONS = {
  approve: "UPDATE guestbook SET status = 'approved' WHERE id = ?1 AND status = 'pending'",
  "delete-guestbook": "DELETE FROM guestbook WHERE id = ?1",
  "delete-waitlist": "DELETE FROM waitlist WHERE id = ?1",
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * LOCAL-ONLY dev bypass for testing the admin UI under `wrangler pages dev`. Needs BOTH
 * DEV_ADMIN_BYPASS === "1" (passed on the command line with --binding, never in wrangler.toml
 * or a Pages secret) AND a request addressed to 127.0.0.1/localhost, which can't reach production.
 */
export function devBypass(request, env) {
  if (!env || env.DEV_ADMIN_BYPASS !== "1") return false;
  try { return LOCAL_HOSTS.has(new URL(request.url).hostname); } catch (e) { return false; }
}

export async function authorize(request, env, opts) {
  if (devBypass(request, env)) return { ok: true, email: "local-dev", dev: true };
  const result = await verifyAccess(request, env, opts);
  // Log why a request was refused (never the token itself) so `wrangler pages deployment tail` shows it.
  if (!result.ok) console.warn("[admin] access denied:", result.reason, new URL(request.url).pathname);
  return result;
}

function sameOriginStrict(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch (e) { return false; }
}

export function positiveId(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2147483647 ? v : null;
}

/** Own-property lookup, so "constructor", "__proto__" and friends are just unknown routes. */
const lookup = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null);

export async function handleAdmin(context, opts = {}) {
  const { request, env } = context;
  // Outside the Access-protected hostnames there is no admin API at all (the local dev bypass aside).
  const host = new URL(request.url).hostname;
  if (!devBypass(request, env) && !ADMIN_HOSTS.has(host)) {
    console.warn("[admin] refused: host not allowed", host);
    return out(404, { ok: false, error: "not found" });
  }
  const auth = await authorize(request, env, opts);
  if (!auth.ok) {
    console.warn("admin: refused", auth.reason);
    return out(403, { ok: false, error: "forbidden" });
  }
  const route = new URL(request.url).pathname.replace(/^\/api\/admin\/?/, "").replace(/\/+$/, "");
  if (!env.DB) return out(503, { ok: false, error: "database unavailable" });

  try {
    if (request.method === "GET" || request.method === "HEAD") {
      const sql = lookup(LISTS, route);
      if (!sql) return out(404, { ok: false, error: "not found" });
      const [rows, counts] = await env.DB.batch([env.DB.prepare(sql), env.DB.prepare(COUNTS)]);
      const c = (counts.results && counts.results[0]) || {};
      return out(200, {
        ok: true,
        who: auth.email || "",
        counts: { pending: Number(c.pending) || 0, approved: Number(c.approved) || 0, waitlist: Number(c.waitlist) || 0 },
        items: rows.results || [],
      });
    }
    if (request.method === "POST") {
      const sql = lookup(ACTIONS, route);
      if (!sql) return out(404, { ok: false, error: "not found" });
      if (!sameOriginStrict(request)) return out(403, { ok: false, error: "bad origin" });
      if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return out(415, { ok: false, error: "json only" });
      let data = null;
      try {
        const text = await readCapped(request, MAX_ADMIN_BODY_BYTES);
        if (text !== null) data = JSON.parse(text);
      } catch (e) { data = null; }
      const id = data && typeof data === "object" ? positiveId(data.id) : null;
      if (!id) return out(400, { ok: false, error: "id must be a positive integer" });
      const res = await env.DB.prepare(sql).bind(id).run();
      const changed = Number(res && res.meta && res.meta.changes) || 0;
      return out(200, { ok: true, changed });
    }
    return out(405, { ok: false, error: "method not allowed" });
  } catch (e) {
    console.error("admin failed", e && e.message);
    return out(500, { ok: false, error: "server error" });
  }
}
