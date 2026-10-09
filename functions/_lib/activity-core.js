// "Latest from the workshop" feed behind GET /api/activity (functions/api/activity.js).
// Pure logic with no JSON import, so tools/test-activity.js can run it in Node with mocks.
// This module exports no onRequest* handler, so it never becomes a route of its own.
//
// Source: the owner's PUBLIC GitHub events, https://api.github.com/users/dgreen52/events/public.
// Only three kinds survive the reducer, each cut down to { repo, type, message, url, date }:
//   push     one item per push: the newest commit's first line (GitHub dropped the commit list from
//            PushEvent payloads in 2025, so the message is looked up by the head SHA through the small
//            git-data endpoint, once per SHA, then remembered; commit messages never change)
//   create   a new repository (branch and tag creation are ignored)
//   release  a published release
// Only repos owned by the account are listed. Nothing else from GitHub is passed on: no author names or
// emails, no avatars, no payload fields, no API URLs. Links are always https://github.com/<owner>/<repo>...
//
// Caching (the unauthenticated GitHub limit is 60 requests an hour per egress IP, shared with every other
// Worker on that IP): one stored result in caches.default (synthetic key, kept for days so it can always
// stand in) plus per-isolate memory, refreshed at most every 30 minutes with an ETag (a 304 reuses the
// items). If GitHub errors, times out or rate-limits, the last good copy is served (stale: true) and
// GitHub isn't asked again for 5 minutes (or until its rate-limit reset, at most 30). Concurrent cold
// requests share one refresh. env.GITHUB_TOKEN (optional; a fine-grained token with no extra permissions
// is enough, it only raises the limit) is sent as a bearer token if set.

export const OWNER = "dgreen52";
export const EVENTS_URL = `https://api.github.com/users/${OWNER}/events/public?per_page=50`;
export const MAX_ITEMS = 8;
export const MAX_MESSAGE = 90;
export const FRESH_S = 30 * 60;     // refresh at most this often
export const BACKOFF_S = 5 * 60;    // after a failure, wait this long before asking GitHub again
export const KEEP_S = 7 * 24 * 3600; // how long caches.default may keep the last good copy
export const CLIENT_MAX_AGE_S = 300;
export const TIMEOUT_MS = 5000;
export const CACHE_PATH = "/__activity-cache/v1"; // synthetic Cache API key; never a real route

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
// C0/C1 controls, bidi marks/overrides/isolates, zero-width characters and BOM
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
// commit trailers and tool footers that must never reach the page
const TRAILER = /^\s*(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|cc|change-id)\s*:/i;
const TRAILER_INLINE = /\s*\b(co-authored-by|signed-off-by)\s*:.*$/i;
const FOOTER = /generated with \[?claude|🤖/i;
const EMAIL = /<?[^\s<>()@,;:"]+@[^\s<>()@,;:"]+\.[a-z]{2,}>?/gi;

/** A commit message (or release / repo description) -> one clean line of at most 90 characters, or "". */
export function cleanMessage(raw) {
  if (typeof raw !== "string") return "";
  const lines = raw.normalize("NFC").split(/\r\n?|\n|[\u2028\u2029]/);
  for (const line of lines) {
    if (TRAILER.test(line) || FOOTER.test(line)) continue;
    let s = line.replace(INVISIBLE, "").replace(TRAILER_INLINE, "").replace(EMAIL, "").replace(/\s+/g, " ").trim();
    s = s.replace(/[\s:;,-]+$/, "").trim();
    if (!s) continue;
    const chars = Array.from(s);
    return chars.length > MAX_MESSAGE ? chars.slice(0, MAX_MESSAGE - 1).join("").trimEnd() + "…" : s;
  }
  return "";
}

/** The only links that ever leave this module: https://github.com/<repo>[/<path>]. */
export function githubUrl(full, path) {
  if (!REPO.test(full)) return null;
  const tail = path ? "/" + path : "";
  return `https://github.com/${full}${tail}`;
}
function releaseUrl(full, html) {
  try {
    const u = new URL(String(html || ""));
    if (u.protocol === "https:" && u.hostname === "github.com" && u.username === "" && u.password === "" &&
        u.pathname.toLowerCase().startsWith(`/${full.toLowerCase()}/releases/`)) {
      return "https://github.com" + u.pathname;
    }
  } catch (e) { /* fall through */ }
  return githubUrl(full, "releases");
}
function isoDate(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

/**
 * GitHub events (newest first) -> internal items, newest first, at most `max`.
 * Push items carry their head `sha` until finalize() swaps it for the message.
 */
export function reduceEvents(events, opts = {}) {
  const owner = String(opts.owner || OWNER).toLowerCase();
  const max = opts.max || MAX_ITEMS;
  const out = [];
  const seen = new Set();
  if (!Array.isArray(events)) return out;
  for (const ev of events) {
    if (out.length >= max) break;
    if (!ev || typeof ev !== "object" || ev.public === false) continue;
    const full = ev.repo && typeof ev.repo.name === "string" ? ev.repo.name : "";
    if (!REPO.test(full) || full.split("/")[0].toLowerCase() !== owner) continue;
    const date = isoDate(ev.created_at);
    if (!date) continue;
    const p = ev.payload && typeof ev.payload === "object" ? ev.payload : {};
    const repo = full.split("/")[1];
    let item = null;
    if (ev.type === "PushEvent") {
      const sha = typeof p.head === "string" ? p.head.toLowerCase() : "";
      if (!SHA.test(sha)) continue;
      const key = "push:" + full + ":" + sha;
      if (seen.has(key)) continue; // the API sometimes repeats an event
      seen.add(key);
      const branch = typeof p.ref === "string" ? p.ref.replace(/^refs\/heads\//, "") : "";
      // older payloads still list the commits (oldest first); the last one is the newest
      const commits = Array.isArray(p.commits) ? p.commits : [];
      const last = commits.length ? commits[commits.length - 1] : null;
      item = { repo, full, type: "push", sha, branch: cleanMessage(branch).slice(0, 40), message: last ? cleanMessage(last.message) : "",
        url: githubUrl(full, "commit/" + sha), date };
    } else if (ev.type === "CreateEvent") {
      if (p.ref_type !== "repository") continue;
      const key = "create:" + full;
      if (seen.has(key)) continue;
      seen.add(key);
      item = { repo, full, type: "create", message: cleanMessage(p.description) || "New repository", url: githubUrl(full), date };
    } else if (ev.type === "ReleaseEvent") {
      if (p.action && p.action !== "published") continue;
      const r = p.release && typeof p.release === "object" ? p.release : {};
      if (r.draft) continue;
      const key = "release:" + full + ":" + String(r.id || r.tag_name || date);
      if (seen.has(key)) continue;
      seen.add(key);
      const title = cleanMessage(r.name) || cleanMessage(r.tag_name);
      item = { repo, full, type: "release", message: title ? cleanMessage("Released " + title) : "New release", url: releaseUrl(full, r.html_url), date };
    }
    if (item && item.url) out.push(item);
  }
  return out;
}

/** Internal items + known commit messages -> exactly what the API returns. */
export function finalize(items, msgs) {
  return (items || []).map((it) => {
    let message = it.message;
    if (!message && it.type === "push") message = (msgs && msgs[it.sha]) || (it.branch ? "Pushed to " + it.branch : "Pushed new commits");
    return { repo: it.repo, type: it.type, message: cleanMessage(String(message || "")), url: it.url, date: it.date };
  });
}

function ghHeaders(env, etag) {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "dillongreen.dev-activity/1 (+https://dillongreen.dev/now/)",
  };
  const token = env && typeof env.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN.trim() : "";
  if (token) h.Authorization = "Bearer " + token;
  if (etag) h["If-None-Match"] = etag;
  return h;
}

async function timedFetch(fetchImpl, url, init, timeoutMs) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } reject(new Error("timeout")); }, timeoutMs);
  });
  const attempt = fetchImpl(url, { ...init, signal: ctrl.signal });
  attempt.catch(() => {}); // a late rejection after the timeout must not surface as unhandled
  try { return await Promise.race([attempt, timeout]); } finally { clearTimeout(timer); }
}

class GitHubError extends Error {
  constructor(status, retryAt) { super("GitHub HTTP " + status); this.status = status; this.retryAt = retryAt; }
}

/** Look up the first line of each missing head commit (small git-data endpoint). Never throws. */
async function lookUpMessages(items, msgs, env, opts) {
  const fetchImpl = opts.fetch || ((...a) => fetch(...a));
  const want = items.filter((it) => it.type === "push" && !it.message && !msgs[it.sha]);
  await Promise.all(want.map(async (it) => {
    try {
      const res = await timedFetch(fetchImpl, `https://api.github.com/repos/${it.full}/git/commits/${it.sha}`,
        { headers: ghHeaders(env), redirect: "follow" }, opts.timeoutMs || TIMEOUT_MS);
      if (!res.ok) { try { res.body && res.body.cancel && res.body.cancel(); } catch (e) { /* ignore */ } return; }
      const j = await res.json();
      const m = cleanMessage(j && j.message);
      if (m) msgs[it.sha] = m;
    } catch (e) { /* keep the "Pushed to <branch>" fallback; try again next refresh */ }
  }));
  return msgs;
}

// Per-isolate memory: a warm isolate answers without touching the Cache API, and concurrent requests
// share one in-flight refresh instead of each asking GitHub.
let memo = null;     // the stored state (see refresh())
let inflight = null; // Promise<state>
export function _resetMemory() { memo = null; inflight = null; }

/** One trip to GitHub. Returns the new state; on failure, the previous good one marked stale. */
async function refresh(prev, env, opts) {
  const now = opts.now || (() => Date.now());
  const fetchImpl = opts.fetch || ((...a) => fetch(...a));
  const t = now();
  try {
    const res = await timedFetch(fetchImpl, opts.eventsUrl || EVENTS_URL,
      { headers: ghHeaders(env, prev && prev.items ? prev.etag : null), redirect: "follow" }, opts.timeoutMs || TIMEOUT_MS);
    let items, etag;
    if (res.status === 304 && prev && prev.items) {
      items = prev.items;
      etag = prev.etag;
    } else if (res.ok) {
      const events = await res.json();
      if (!Array.isArray(events)) throw new Error("unexpected events payload");
      items = reduceEvents(events, opts);
      etag = res.headers.get("ETag") || null;
    } else {
      const reset = Number(res.headers.get("X-RateLimit-Reset")) * 1000;
      try { res.body && res.body.cancel && res.body.cancel(); } catch (e) { /* ignore */ }
      throw new GitHubError(res.status, Number.isFinite(reset) && reset > t ? reset : 0);
    }
    // keep only the messages still needed, then fill in any missing ones (skip if nearly out of requests)
    const msgs = {};
    const old = (prev && prev.msgs) || {};
    for (const it of items) if (it.type === "push" && old[it.sha]) msgs[it.sha] = old[it.sha];
    const remaining = res.headers.get("X-RateLimit-Remaining"); // absent on a 304
    if (remaining === null || !(Number(remaining) < 5)) await lookUpMessages(items, msgs, env, opts);
    return { v: 1, ok: true, stale: false, fetched_at: t, checked_at: t, next_try: t + FRESH_S * 1000, etag, items, msgs };
  } catch (e) {
    console.error("activity refresh failed", e && e.message);
    const until = Math.min(t + FRESH_S * 1000, Math.max(t + BACKOFF_S * 1000, (e && e.retryAt) || 0));
    if (prev && prev.items) return { ...prev, stale: true, checked_at: t, next_try: until };
    return { v: 1, ok: false, stale: true, fetched_at: null, checked_at: t, next_try: until, etag: null, items: null, msgs: {} };
  }
}

function respond(state) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" };
  if (!state || !state.items) {
    headers["Cache-Control"] = "public, max-age=60";
    return new Response(JSON.stringify({ ok: false, items: [] }), { status: 503, headers });
  }
  headers["Cache-Control"] = `public, max-age=${state.stale ? 60 : CLIENT_MAX_AGE_S}`;
  const body = {
    ok: true,
    stale: !!state.stale,
    fetched_at: new Date(state.fetched_at).toISOString().replace(/\.\d{3}Z$/, "Z"),
    items: finalize(state.items, state.msgs),
  };
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function parseState(text) {
  try {
    const s = JSON.parse(text);
    return s && s.v === 1 && Number.isFinite(s.next_try) ? s : null;
  } catch (e) { return null; }
}

/**
 * GET /api/activity. Uses nothing from the request except its origin (for the synthetic cache key).
 * ctx: Pages Functions context ({ request, env, waitUntil }). opts: test hooks (fetch, now, caches, timeoutMs, eventsUrl).
 */
export async function activityResponse(ctx, opts = {}) {
  const now = opts.now || (() => Date.now());
  const store = opts.caches !== undefined ? opts.caches : (typeof caches !== "undefined" ? caches : null);
  const cache = store && store.default ? store.default : null;
  const wait = (p) => { try { if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p); } catch (e) { /* ignore */ } };

  if (memo && now() < memo.next_try) return respond(memo);

  let key = null;
  try { key = new Request(new URL(CACHE_PATH, ctx.request.url).toString()); } catch (e) { key = null; }
  let prev = memo;
  if (cache && key) {
    try {
      const hit = await cache.match(key);
      const s = hit ? parseState(await hit.text()) : null;
      if (s && (!prev || s.checked_at >= prev.checked_at)) prev = s;
    } catch (e) { /* Cache API unavailable (e.g. *.pages.dev): memory only */ }
  }
  if (prev && now() < prev.next_try) { memo = prev; return respond(prev); }

  if (!inflight) {
    inflight = (async () => {
      const state = await refresh(prev, ctx && ctx.env, opts);
      memo = state;
      if (cache && key) {
        const stored = new Response(JSON.stringify(state), {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${KEEP_S}` },
        });
        wait(Promise.resolve().then(() => cache.put(key, stored)).catch((e) => console.error("activity cache put failed", e && e.message)));
      }
      return state;
    })().finally(() => { inflight = null; });
  }
  return respond(await inflight);
}
