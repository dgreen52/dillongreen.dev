// Unit tests for /api/status (functions/_lib/status-core.js) with mocked fetch, service bindings
// and Cache API. No network.   node tools/test-status.js
const path = require("path");
const { pathToFileURL } = require("url");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockFetch(table, calls) {
  // table: host -> { status, delay } | "throw" | "hang"
  return async (url, init) => {
    const host = new URL(typeof url === "string" ? url : url.url).host;
    calls.push({ via: "fetch", host, init });
    const t = table[host];
    if (t === "throw") throw new TypeError("network down");
    if (t === "hang") return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    if (!t) return new Response("nope", { status: 404 });
    if (t.delay) await sleep(t.delay);
    return new Response("<html>", { status: t.status });
  };
}

function mockCaches() {
  const store = new Map();
  return {
    store,
    default: {
      async match(req) { const v = store.get(req.url); return v ? new Response(v.body, { headers: v.headers }) : undefined; },
      async put(req, res) { store.set(req.url, { body: await res.text(), headers: Object.fromEntries(res.headers) }); },
    },
  };
}

(async () => {
  const core = await import(pathToFileURL(path.join(ROOT, "functions/_lib/status-core.js")).href);
  const nodes = JSON.parse(fs.readFileSync(path.join(ROOT, "functions/_lib/projects-live.json"), "utf8"));

  /* ---- generated node list (expectations derived from tools/projects.json, the source of truth) ---- */
  const live = require(path.join(ROOT, "tools/projects.json")).projects.filter((p) => p.url);
  const N = live.length;
  check(N >= 1 && nodes.length === N && nodes.map((n) => n.slug).join() === live.map((p) => p.slug).join(),
    `projects-live.json has one node per live project in tools/projects.json (${nodes.length}/${N}; run tools/build_projects.py if not)`);
  check(nodes.every((n) => n.slug && n.name && /^https:\/\//.test(n.url) && (n.kind === "pages" || n.kind === "workers")), "every node has slug/name/https url/kind");
  const workers = nodes.filter((n) => n.kind === "workers").map((n) => n.service).sort();
  const wantWorkers = live.map((p) => new URL(p.url).hostname).filter((h) => h.endsWith(".workers.dev")).map((h) => h.split(".")[0]).sort();
  check(JSON.stringify(workers) === JSON.stringify(wantWorkers) && workers.includes("fernwood"), `${workers.length} workers-hosted services (${workers.join(", ")})`);
  const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8").split("\r\n").join("\n"); // checkouts may be CRLF
  const missing = workers.filter((s) => !toml.includes(`binding = "${core.bindingName(s)}"\nservice = "${s}"`));
  check(missing.length === 0, "wrangler.toml has an SVC_ binding for each Workers node" + (missing.length ? " (missing: " + missing.join(", ") + ")" : ""));
  check(core.bindingName("little-airfield") === "SVC_LITTLE_AIRFIELD", "binding name mapping");

  /* ---- classification ---- */
  check(core.classify(200, 10) === "up", "200 fast -> up");
  check(core.classify(301, 100) === "up", "301 fast -> up");
  check(core.classify(204, 1499) === "up", "204 at 1499ms -> up");
  check(core.classify(200, 1500) === "slow", "200 at 1500ms -> slow");
  check(core.classify(302, 3999) === "slow", "302 slow -> slow");
  check(core.classify(500, 10) === "down", "500 -> down");
  check(core.classify(503, 10) === "down", "503 -> down");
  check(core.classify(404, 10) === "down", "404 -> down");
  check(core.classify(0, 4000) === "down", "no response -> down");
  check(core.TIMEOUT_MS === 4000 && core.SLOW_MS === 1500, "defaults: 4s timeout, 1.5s slow threshold");

  /* ---- checkNode / checkAll with fetch + bindings ---- */
  const calls = [];
  const fetchTable = {
    "pocket429.pages.dev": { status: 200 },
    "linework-c4u.pages.dev": { status: 200 },
    "surprisepass.pages.dev": { status: 503 },
    // workers.dev hosts must NOT be fetched when a binding exists
    "butter.dillon-eu-green.workers.dev": { status: 200 },
  };
  const binding = (status, delay, mode) => ({
    calls: 0,
    async fetch(req) {
      this.calls++;
      calls.push({ via: "binding", host: new URL(req.url).host, redirect: req.redirect });
      if (mode === "throw") throw new Error("boom");
      if (mode === "hang") return new Promise(() => {});
      if (delay) await sleep(delay);
      return new Response("ok", { status });
    },
  });
  const env = {
    SVC_LITTLE_AIRFIELD: binding(200),
    SVC_MIXTAPE_DRIFT: binding(302),
    SVC_CRUMB: binding(200, 260),        // "slow" with SLOW_MS scaled down below
    SVC_DRAGONREALM: binding(0, 0, "hang"),
    SVC_BUTTER: binding(0, 0, "throw"),  // binding throws -> falls back to fetch (200)
    SVC_BEEPBEACH: binding(500),
    // SVC_HALFSIES missing -> global fetch -> not in table -> 404 -> down
  };
  // scale time: real timers, short timeout; SLOW_MS is a constant so emulate slowness with a fake clock
  let clock = 0;
  const realNow = Date.now;
  const t0 = Date.now();
  const opts = { fetch: mockFetch(fetchTable, calls), timeoutMs: 300, now: () => (Date.now() - t0) * 6 + clock };
  const started = Date.now();
  const body = await core.checkAll(nodes, env, opts);
  const took = Date.now() - started;
  const by = Object.fromEntries(body.nodes.map((n) => [n.slug, n]));
  check(took < 900, `checks run in parallel and respect the timeout (${took}ms for ${N} nodes, timeout 300ms)`);
  check(by.pocket429.status === "up", "pocket429 checked via pages.dev -> up");
  check(calls.some((c) => c.via === "fetch" && c.host === "pocket429.pages.dev") && !calls.some((c) => c.host === "pocket429.dillongreen.dev"), "pocket429 uses https://pocket429.pages.dev, not the same-zone custom domain");
  check(by.linework && by.linework.status === "up" && by.linework.url === "https://linework.dillongreen.dev", "linework checked via its pages.dev origin -> up; public URL kept for the widget link");
  check(calls.some((c) => c.via === "fetch" && c.host === "linework-c4u.pages.dev") && !calls.some((c) => c.host === "linework.dillongreen.dev" || c.host === "linework.pages.dev"),
    "linework uses https://linework-c4u.pages.dev (its Pages project), never the same-zone custom domain or linework.pages.dev");
  check(by.airfield.status === "up", "binding 200 -> up");
  check(by.mixtape.status === "up", "binding 302 -> up (redirect not followed)");
  check(calls.filter((c) => c.via === "binding").every((c) => c.redirect === "manual"), "binding requests use redirect: manual");
  check(by.crumb.status === "slow" && by.crumb.ms >= 1500, `binding 200 after a (scaled) 1.5s+ -> slow (${by.crumb.ms}ms)`);
  check(by.dragonrealm.status === "down", "hanging binding -> down after timeout");
  check(by.butter.status === "up" && calls.some((c) => c.via === "fetch" && c.host === "butter.dillon-eu-green.workers.dev"), "throwing binding falls back to fetch");
  check(by.beepbeach.status === "down", "binding 500 -> down");
  check(by.halfsies.status === "down" && calls.some((c) => c.via === "fetch" && c.host === "halfsies.dillon-eu-green.workers.dev"), "missing binding -> global fetch (local dev path)");
  check(by.surprisepass.status === "down", "pages 503 -> down");
  check(!calls.some((c) => c.via === "fetch" && ["little-airfield", "mixtape-drift", "crumb", "dragonrealm", "beepbeach"].some((s) => c.host.startsWith(s + "."))), "no workers.dev fetch when the binding works");
  // up: pocket429, linework, airfield, mixtape, crumb (slow), butter (fallback). Nodes without a mock (e.g. fernwood) are down.
  check(body.total === N && body.up === body.nodes.filter((n) => n.status !== "down").length && body.up === 6, `up counts up+slow (${body.up}/${N})`);
  check(!isNaN(Date.parse(body.checked_at)) && body.nodes.every((n) => Object.keys(n).join() === "slug,name,status,ms,url" && Number.isInteger(n.ms)), "response shape {checked_at, up, total, nodes:[{slug,name,status,ms,url}]}");

  /* ---- real 4s default timeout on one hanging node ---- */
  {
    const s = Date.now();
    const r = await core.checkNode({ slug: "x", name: "x", url: "https://x.example/", kind: "pages" }, {}, { fetch: mockFetch({ "x.example": "hang" }, []) });
    const d = Date.now() - s;
    check(r.status === "down" && d >= 3900 && d < 4800, `default timeout aborts at ~4s (${d}ms)`);
  }
  check((await core.checkNode({ slug: "y", name: "y", url: "https://y.example/", kind: "pages" }, {}, { fetch: mockFetch({ "y.example": "throw" }, []) })).status === "down", "network error -> down");

  /* ---- caching ---- */
  core._resetMemory();
  const caches = mockCaches();
  let fetches = 0;
  const countingFetch = async () => { fetches++; return new Response("ok", { status: 200 }); };
  const waits = [];
  const ctx = { request: new Request("https://dillongreen.dev/api/status?x=<script>"), env: {}, waitUntil: (p) => waits.push(p) };
  let nowMs = Date.parse("2026-10-03T12:00:00Z");
  const copts = { fetch: countingFetch, caches, now: () => nowMs, timeoutMs: 500 };

  let res = await core.statusResponse(ctx, nodes, copts);
  await Promise.all(waits);
  let j = await res.json();
  check(res.status === 200 && res.headers.get("Cache-Control") === "public, max-age=30", "Cache-Control: public, max-age=30");
  check(res.headers.get("Content-Type").startsWith("application/json"), "JSON content type");
  check(fetches === N && j.up === N, `first request checks all ${N} nodes`);
  const key = "https://dillongreen.dev/__status-cache/v1";
  check(caches.store.has(key) && caches.store.size === 1, "stored once under the synthetic key (query string ignored)");
  check(/max-age=60/.test(caches.store.get(key).headers["cache-control"]), "cache entry max-age=60");

  nowMs += 20000;
  res = await core.statusResponse(ctx, nodes, copts);
  check(fetches === N, "20s later: served from isolate memory, no new checks");

  core._resetMemory(); // new isolate: memory empty, Cache API still warm
  nowMs += 20000;
  res = await core.statusResponse({ ...ctx, request: new Request("https://dillongreen.dev/api/status") }, nodes, copts);
  check(fetches === N && (await res.json()).checked_at === j.checked_at, "40s later in a fresh isolate: served from caches.default");

  nowMs += 25000; // 65s after the check
  core._resetMemory();
  res = await core.statusResponse(ctx, nodes, copts);
  await Promise.all(waits);
  check(fetches === 2 * N, "after 60s the cache is stale -> re-checked");

  // concurrency: simultaneous requests share one check
  core._resetMemory();
  nowMs += 120000;
  const before = fetches;
  await Promise.all([1, 2, 3, 4, 5].map(() => core.statusResponse(ctx, nodes, { ...copts, caches: null })));
  check(fetches - before === N, `5 concurrent cold requests share one round of ${N} checks`);

  // Cache API missing / throwing
  core._resetMemory();
  const broken = { default: { match: async () => { throw new Error("no cache"); }, put: async () => { throw new Error("no cache"); } } };
  res = await core.statusResponse(ctx, nodes, { ...copts, caches: broken });
  check(res.status === 200, "a throwing Cache API doesn't break the endpoint");

  // the route file only exports GET
  const route = fs.readFileSync(path.join(ROOT, "functions/api/status.js"), "utf8");
  check(/export function onRequestGet/.test(route) && !/onRequestPost|export function onRequest\(/.test(route), "functions/api/status.js is GET only");

  console.log(fails ? `\n${fails} FAILED` : "\nall status tests passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
