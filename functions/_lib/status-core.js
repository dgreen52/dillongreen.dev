// Live status checks behind GET /api/status (functions/api/status.js).
// Pure logic with no JSON import, so tools/test-status.js can run it in Node with mocks.
// This module exports no onRequest* handler, so it never becomes a route of its own.
//
// Each node is fetched once, in parallel, with a 4 s budget:
//   up    2xx/3xx in under 1.5 s        slow  2xx/3xx in 1.5 s or more
//   down  network error, timeout, 4xx or 5xx (anything that isn't a working page)
// Redirects are not followed (a 3xx already proves the origin answered).
//
// Why service bindings: a Worker or Pages Function fetching another Worker on the same account's
// workers.dev subdomain can be refused (Cloudflare error 1042, loop protection). Workers-hosted
// nodes are therefore fetched through SVC_<SERVICE> bindings (wrangler.toml), which call the
// Worker directly. When the binding is absent (local dev, or not configured) plain fetch() is used.

export const TIMEOUT_MS = 4000;
export const SLOW_MS = 1500;
export const CACHE_TTL_S = 60;      // shared result, in caches.default and in isolate memory
export const CLIENT_MAX_AGE_S = 30; // what browsers / the CDN may reuse
export const CACHE_PATH = "/__status-cache/v1"; // synthetic Cache API key; never a real route

// pocket429's and Linework's public URLs are custom domains on this same zone (*.dillongreen.dev).
// A subrequest from this zone's Pages Function back into the zone is avoidable, so check each
// project's own pages.dev origin instead; it is served by the same deployment. (Linework's Pages
// project is "linework-c4u": the plain linework.pages.dev name belongs to someone else.)
export const CHECK_URL = {
  pocket429: "https://pocket429.pages.dev/",
  linework: "https://linework-c4u.pages.dev/",
};

/** SVC_<SERVICE>: "little-airfield" -> "SVC_LITTLE_AIRFIELD". */
export function bindingName(service) {
  return "SVC_" + String(service).toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** HTTP status + latency -> "up" | "slow" | "down". */
export function classify(httpStatus, ms) {
  if (!(Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus < 400)) return "down";
  return ms >= SLOW_MS ? "slow" : "up";
}

/** Check one node. Never throws; resolves within ~timeoutMs. */
export async function checkNode(node, env, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const now = opts.now || (() => Date.now());
  const fetchImpl = opts.fetch || ((...a) => fetch(...a));
  const url = CHECK_URL[node.slug] || node.url;
  const ctrl = new AbortController();
  const init = {
    method: "GET",
    redirect: "manual",
    signal: ctrl.signal,
    headers: { "User-Agent": "dillongreen.dev-status/1", Accept: "text/html,*/*;q=0.8" },
  };
  const svc = node.kind === "workers" && node.service && env ? env[bindingName(node.service)] : null;

  const t0 = now();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } resolve(null); }, timeoutMs);
  });
  const attempt = (async () => {
    let res;
    if (svc && typeof svc.fetch === "function") {
      try {
        res = await svc.fetch(new Request(url, init));
      } catch (e) {
        if (ctrl.signal.aborted) throw e;
        res = await fetchImpl(url, init); // binding misconfigured: try the public URL once
      }
    } else {
      res = await fetchImpl(url, init);
    }
    try { if (res.body && typeof res.body.cancel === "function") res.body.cancel(); } catch (e) { /* ignore */ }
    return res.status;
  })();
  attempt.catch(() => {}); // a late rejection after a timeout must not surface as unhandled

  let httpStatus = 0;
  try {
    const r = await Promise.race([attempt, timeout]);
    httpStatus = r === null ? 0 : r;
  } catch (e) {
    httpStatus = 0;
  } finally {
    clearTimeout(timer);
  }
  const ms = Math.max(0, Math.round(now() - t0));
  return { slug: node.slug, name: node.name, status: classify(httpStatus, ms), ms, url: node.url };
}

/** Check every node in parallel. `up` counts nodes that answered (status "up" or "slow"). */
export async function checkAll(nodes, env, opts = {}) {
  const now = opts.now || (() => Date.now());
  const results = await Promise.all(nodes.map((n) => checkNode(n, env, opts)));
  return {
    checked_at: new Date(now()).toISOString(),
    up: results.filter((r) => r.status !== "down").length,
    total: results.length,
    nodes: results,
  };
}

// Per-isolate memory: a warm isolate answers without touching the Cache API, and concurrent
// requests share one in-flight check instead of fanning out one subrequest per node each.
let memo = null;     // { at, text }
let inflight = null; // Promise<string>
export function _resetMemory() { memo = null; inflight = null; }

function fresh(text, nowMs) {
  try {
    const t = Date.parse(JSON.parse(text).checked_at);
    return Number.isFinite(t) && nowMs - t < CACHE_TTL_S * 1000 && nowMs - t > -30000;
  } catch (e) { return false; }
}

function respond(text) {
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CLIENT_MAX_AGE_S}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * GET /api/status. Uses nothing from the request except its origin (for the synthetic cache key).
 * ctx: Pages Functions context ({ request, env, waitUntil }). opts: test hooks (fetch, now, caches, timeoutMs).
 */
export async function statusResponse(ctx, nodes, opts = {}) {
  const now = opts.now || (() => Date.now());
  const store = opts.caches !== undefined ? opts.caches : (typeof caches !== "undefined" ? caches : null);
  const wait = (p) => { try { if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p); } catch (e) { /* ignore */ } };

  if (memo && now() - memo.at < CACHE_TTL_S * 1000) return respond(memo.text);

  let key = null;
  try { key = new Request(new URL(CACHE_PATH, ctx.request.url).toString()); } catch (e) { key = null; }
  const cache = store && store.default ? store.default : null;
  if (cache && key) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const text = await hit.text();
        if (fresh(text, now())) {
          memo = { at: Date.parse(JSON.parse(text).checked_at), text };
          return respond(text);
        }
      }
    } catch (e) { /* Cache API unavailable (e.g. *.pages.dev preview): just check live */ }
  }

  if (!inflight) {
    inflight = (async () => {
      const body = await checkAll(nodes, ctx && ctx.env, opts);
      const text = JSON.stringify(body);
      memo = { at: now(), text };
      if (cache && key) {
        const stored = new Response(text, {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_TTL_S}` },
        });
        wait(Promise.resolve().then(() => cache.put(key, stored)).catch((e) => console.error("status cache put failed", e && e.message)));
      }
      return text;
    })().finally(() => { inflight = null; });
  }
  return respond(await inflight);
}
