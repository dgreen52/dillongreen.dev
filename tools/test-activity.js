// Unit tests for GET /api/activity (functions/_lib/activity-core.js): the GitHub events reducer, message
// cleaning, link rules, and the caching (memory + caches.default, 30 min, ETag, stale-while-error, backoff,
// one shared refresh) with a mocked fetch, clock and Cache API. No network.   node tools/test-activity.js
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };
const sha = (n) => String(n).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, "a");

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
const H = (o) => new Headers(o || {});
// a scripted GitHub: `events` answers the events URL, `commits[sha]` the git-data commit lookups
function mockGitHub(opts = {}) {
  const calls = [];
  const gh = {
    calls, events: opts.events || [], etag: opts.etag || '"e1"', mode: "ok", commits: opts.commits || {}, remaining: 50,
    fetch: async (url, init) => {
      const u = String(url);
      calls.push({ url: u, headers: init && init.headers });
      if (gh.mode === "throw") throw new TypeError("network down");
      if (gh.mode === "hang") return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
      if (/\/events\/public/.test(u)) {
        if (gh.mode === "500") return new Response("oops", { status: 500 });
        if (gh.mode === "ratelimit") return new Response("{}", { status: 403, headers: H({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor((gh.now() + 20 * 60e3) / 1000)) }) });
        if (gh.mode === "garbage") return new Response("{\"message\":\"not an array\"}", { status: 200 });
        const inm = init && init.headers && init.headers["If-None-Match"];
        if (inm && inm === gh.etag) return new Response(null, { status: 304, headers: H({ ETag: gh.etag }) });
        return new Response(JSON.stringify(gh.events), { status: 200, headers: H({ ETag: gh.etag, "X-RateLimit-Remaining": String(gh.remaining), "Content-Type": "application/json" }) });
      }
      const m = u.match(/\/repos\/([^/]+\/[^/]+)\/git\/commits\/([0-9a-f]{40})$/);
      if (m && gh.commits[m[2]] !== undefined) {
        const c = gh.commits[m[2]];
        return c === 404 ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ sha: m[2], message: c, author: { name: "Secret Name", email: "secret@example.com" } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
    now: () => Date.now(),
  };
  return gh;
}
const ev = (type, repo, payload, created, extra) => ({ id: String(Math.random()), type, actor: { login: "dgreen52", avatar_url: "https://avatars.example/x" }, repo: { name: repo, url: "https://api.github.com/repos/" + repo }, payload, public: true, created_at: created, ...(extra || {}) });

(async () => {
  const A = await import(pathToFileURL(path.join(ROOT, "functions/_lib/activity-core.js")).href);

  /* ---------------- cleanMessage ---------------- */
  const C = A.cleanMessage;
  check(C("Fix the thing\n\nLonger body that must not show") === "Fix the thing", "first line only");
  check(C("Add arcade page\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>") === "Add arcade page", "Co-Authored-By trailer dropped");
  check(C("Co-Authored-By: Someone <a@b.co>\nSigned-off-by: X <x@y.zz>\nReal subject") === "Real subject", "trailer lines skipped even when first");
  check(C("Tidy up Co-Authored-By: Claude <noreply@anthropic.com>") === "Tidy up", "inline Co-Authored-By cut from the line");
  check(C("🤖 Generated with [Claude Code](https://claude.com/claude-code)\nShip it") === "Ship it", "tool footer line skipped");
  check(C("Mail me at someone@example.com or <x@y.org> please") === "Mail me at or please", "email addresses removed: " + JSON.stringify(C("Mail me at someone@example.com or <x@y.org> please")));
  const long = C("x".repeat(200));
  check(Array.from(long).length === 90 && long.endsWith("…"), "capped at 90 characters with an ellipsis");
  const emoji = C("🚀".repeat(95));
  check(Array.from(emoji).length === 90, "cap counts code points, not UTF-16 units");
  check(C("a\u202Eb\u200Bc\u0007d\u2028second line") === "abcd", "bidi / zero-width / control characters stripped, U+2028 ends the line");
  check(C("   \n\t\n") === "" && C(null) === "" && C(42) === "", "empty / non-string -> empty");

  /* ---------------- reduceEvents ---------------- */
  const S1 = sha(1), S2 = sha(2), S3 = sha(3), S4 = sha(4);
  const events = [
    ev("PushEvent", "dgreen52/linework", { repository_id: 1, push_id: 11, ref: "refs/heads/main", head: S1, before: S2 }, "2026-10-08T17:00:00Z"),
    ev("PushEvent", "dgreen52/linework", { repository_id: 1, push_id: 11, ref: "refs/heads/main", head: S1, before: S2 }, "2026-10-08T17:00:00Z"), // duplicate
    ev("WatchEvent", "dgreen52/linework", { action: "started" }, "2026-10-08T16:00:00Z"),
    ev("CreateEvent", "dgreen52/linework", { ref: "feature-x", ref_type: "branch", description: "nope" }, "2026-10-08T15:00:00Z"),
    ev("CreateEvent", "dgreen52/linework", { ref: null, ref_type: "repository", description: "CAD viewer + markup. Mail: dev@example.com" }, "2026-10-07T12:00:00Z"),
    ev("ReleaseEvent", "dgreen52/pocket429", { action: "published", release: { id: 9, name: "v1.2 \u2014 OCR", tag_name: "v1.2", html_url: "https://github.com/dgreen52/pocket429/releases/tag/v1.2", author: { login: "x" }, body: "secret notes" } }, "2026-10-06T09:00:00Z"),
    ev("ReleaseEvent", "dgreen52/pocket429", { action: "published", release: { id: 10, tag_name: "v1.3", html_url: "javascript:alert(1)" } }, "2026-10-06T08:00:00Z"),
    ev("PushEvent", "someone-else/project", { ref: "refs/heads/main", head: S3 }, "2026-10-05T09:00:00Z"),
    ev("PushEvent", "dgreen52/old-style", { ref: "refs/heads/dev", head: S4, commits: [
      { sha: S3, author: { email: "me@example.com", name: "Me" }, message: "older commit" },
      { sha: S4, author: { email: "me@example.com", name: "Me" }, message: "newest commit wins\n\nCo-Authored-By: Claude <noreply@anthropic.com>" }] }, "2026-10-04T09:00:00Z"),
    ev("PushEvent", "dgreen52/bad", { ref: "refs/heads/main", head: "not-a-sha" }, "2026-10-04T08:00:00Z"),
    ev("PushEvent", "dgreen52/private-ish", { ref: "refs/heads/main", head: S2 }, "2026-10-04T07:00:00Z", { public: false }),
    ev("PushEvent", "dgreen52/../evil", { ref: "refs/heads/main", head: S2 }, "2026-10-04T06:00:00Z"),
    ev("PushEvent", "dgreen52/nodate", { ref: "refs/heads/main", head: S2 }, "not a date"),
    null, "junk", 42,
  ];
  const items = A.reduceEvents(events);
  check(items.map((i) => i.type + ":" + i.repo).join() === "push:linework,create:linework,release:pocket429,release:pocket429,push:old-style",
    "keeps push / repo-create / published release from the owner's repos, newest first, one per push: " + items.map((i) => i.type + ":" + i.repo).join());
  const out = A.finalize(items, { [S1]: "Add DGN reader" });
  check(out.every((o) => Object.keys(o).sort().join() === "date,message,repo,type,url"), "every item has exactly {repo, type, message, url, date}");
  check(out.every((o) => /^https:\/\/github\.com\/dgreen52\/[A-Za-z0-9._-]+(\/|$)/.test(o.url)), "every url is https://github.com/dgreen52/...");
  check(out[0].message === "Add DGN reader" && out[0].url === `https://github.com/dgreen52/linework/commit/${S1}` && out[0].date === "2026-10-08T17:00:00Z", "push: looked-up message, commit link, ISO date");
  check(out[1].message === "CAD viewer + markup. Mail" && out[1].url === "https://github.com/dgreen52/linework", "repo created: description (email stripped), repo link");
  check(out[2].message === "Released v1.2 \u2014 OCR" && out[2].url === "https://github.com/dgreen52/pocket429/releases/tag/v1.2", "release: name + its github.com release page");
  check(out[3].message === "Released v1.3" && out[3].url === "https://github.com/dgreen52/pocket429/releases", "release with a bad html_url falls back to the repo's releases page");
  check(out[4].message === "newest commit wins", "old-style payload: the last (newest) commit's first line, trailer gone");
  check(A.finalize([{ repo: "x", type: "push", sha: S2, branch: "main", message: "", url: "https://github.com/dgreen52/x/commit/" + S2, date: "2026-10-01T00:00:00Z" }], {})[0].message === "Pushed to main", "push without a known message: 'Pushed to <branch>'");
  const json = JSON.stringify(out);
  check(!/example\.com|Secret|avatar|api\.github\.com|secret notes|author|payload|actor/i.test(json), "nothing else from GitHub leaks (emails, names, avatars, API URLs, release notes)");
  check(A.reduceEvents(Array.from({ length: 30 }, (_, i) => ev("PushEvent", "dgreen52/r" + i, { ref: "refs/heads/main", head: sha(i % 10).replace(/^./, String.fromCharCode(97 + (i % 6))) + "" }, "2026-10-01T00:00:00Z"))).length <= A.MAX_ITEMS, `at most ${A.MAX_ITEMS} items`);
  check(A.reduceEvents({ not: "an array" }).length === 0 && A.reduceEvents(null).length === 0, "non-array input -> no items");

  /* ---------------- activityResponse: caching ---------------- */
  let clock = Date.parse("2026-10-08T18:00:00Z");
  const now = () => clock;
  const ctx = (env) => ({ request: new Request("https://dillongreen.dev/api/activity"), env: env || {}, waitUntil: (p) => pending.push(p) });
  let pending = [];
  const settle = async () => { await Promise.all(pending); pending = []; };
  const gh = mockGitHub({ events: events.slice(0, 6), commits: { [S1]: "Add DGN reader\n\nCo-Authored-By: Claude <noreply@anthropic.com>" } });
  gh.now = now;
  const caches = mockCaches();
  const run = async (env) => { const r = await A.activityResponse(ctx(env), { fetch: gh.fetch, now, caches }); await settle(); return { status: r.status, cc: r.headers.get("Cache-Control"), type: r.headers.get("Content-Type"), body: await r.json() }; };
  const evCalls = () => gh.calls.filter((c) => /events\/public/.test(c.url)).length;
  const lookups = () => gh.calls.filter((c) => /git\/commits/.test(c.url)).length;

  A._resetMemory();
  let r = await run();
  check(r.status === 200 && r.body.ok && !r.body.stale && r.body.items.length === 3 && r.body.items[0].message === "Add DGN reader", "first request: fetches GitHub, 200 with 3 items, commit message looked up and cleaned");
  check(/application\/json/.test(r.type) && r.cc === `public, max-age=${A.CLIENT_MAX_AGE_S}`, "JSON + browser cache " + r.cc);
  check(Object.keys(r.body).sort().join() === "fetched_at,items,ok,stale", "response has only ok/stale/fetched_at/items (no etag, no internal state)");
  check(evCalls() === 1 && lookups() === 1, `one events call + one commit lookup (${evCalls()}, ${lookups()})`);
  check(!gh.calls[0].headers.Authorization && /dillongreen\.dev/.test(gh.calls[0].headers["User-Agent"]), "no token: no Authorization header; a User-Agent is sent");

  clock += 10 * 60e3;
  r = await run();
  check(evCalls() === 1 && r.body.items.length === 3, "10 min later: served from isolate memory, GitHub not asked");

  A._resetMemory(); // a different isolate, same colo
  r = await run();
  check(evCalls() === 1 && r.body.items[0].message === "Add DGN reader", "new isolate within 30 min: served from caches.default, GitHub not asked");

  clock += 21 * 60e3; // 31 min after the fetch
  r = await run();
  const condCall = gh.calls.filter((c) => /events\/public/.test(c.url)).pop();
  check(evCalls() === 2 && condCall.headers["If-None-Match"] === '"e1"', "after 30 min: refreshes with If-None-Match");
  check(r.body.ok && r.body.items[0].message === "Add DGN reader" && lookups() === 1, "304 Not Modified: same items, no new commit lookups");

  // new activity arrives
  clock += 31 * 60e3;
  const S5 = sha(5);
  gh.events = [ev("PushEvent", "dgreen52/portfolio", { ref: "refs/heads/main", head: S5 }, "2026-10-08T19:30:00Z")].concat(gh.events);
  gh.etag = '"e2"';
  gh.commits[S5] = 404; // lookup fails: falls back, retried next time
  r = await run();
  check(r.body.items[0].repo === "portfolio" && r.body.items[0].message === "Pushed to main" && r.body.items[1].message === "Add DGN reader" && lookups() === 2,
    "new push with a failed lookup: 'Pushed to main' fallback, known messages reused (not re-fetched)");

  // GitHub down: stale-while-error + backoff
  clock += 31 * 60e3;
  const before = evCalls();
  gh.mode = "500";
  const errLog = console.error; console.error = () => {};
  r = await run();
  check(r.status === 200 && r.body.ok && r.body.stale === true && r.body.items[0].repo === "portfolio" && /max-age=60/.test(r.cc), "GitHub 500: last good copy served, stale: true, short browser cache");
  clock += 2 * 60e3;
  r = await run();
  check(evCalls() === before + 1 && r.body.stale, "within the 5-minute backoff: GitHub not asked again");
  A._resetMemory();
  r = await run();
  check(evCalls() === before + 1 && r.body.stale, "backoff survives a new isolate (stored in caches.default)");
  clock += 4 * 60e3;
  gh.mode = "ratelimit";
  r = await run();
  check(evCalls() === before + 2 && r.body.stale && r.body.items.length > 0, "after the backoff it retries; 403 rate limit -> stale copy again");
  clock += 10 * 60e3;
  r = await run();
  check(evCalls() === before + 2, "rate limited: waits for X-RateLimit-Reset (20 min) before asking again");
  clock += 11 * 60e3;
  gh.mode = "throw";
  r = await run();
  check(evCalls() === before + 3 && r.body.stale && r.body.ok, "network error: stale copy");
  clock += 6 * 60e3;
  gh.mode = "garbage";
  r = await run();
  check(r.body.stale && r.body.items.length > 0, "unexpected payload (not an array): stale copy, never a broken list");
  clock += 6 * 60e3;
  gh.mode = "hang";
  r = await A.activityResponse(ctx(), { fetch: gh.fetch, now, caches, timeoutMs: 50 }).then(async (x) => ({ status: x.status, body: await x.json() }));
  await settle();
  check(r.status === 200 && r.body.stale, "GitHub hangs: times out, stale copy");
  console.error = errLog;

  clock += 6 * 60e3;
  gh.mode = "ok"; gh.commits[S5] = "Ship the arcade";
  r = await run();
  check(!r.body.stale && r.body.items[0].message === "Ship the arcade", "GitHub back: fresh, and the missing message is filled in now");

  // never fetched and GitHub down: 503 { ok: false }
  A._resetMemory();
  const gh2 = mockGitHub(); gh2.mode = "500";
  console.error = () => {};
  const r2 = await A.activityResponse(ctx(), { fetch: gh2.fetch, now, caches: mockCaches() });
  console.error = errLog;
  const b2 = await r2.json();
  check(r2.status === 503 && b2.ok === false && Array.isArray(b2.items) && b2.items.length === 0, "no copy at all and GitHub down: 503 { ok: false, items: [] }");

  // concurrency: cold requests share one refresh
  A._resetMemory();
  const gh3 = mockGitHub({ events: events.slice(0, 1), commits: { [S1]: "One" } });
  let release;
  const gate = new Promise((res) => { release = res; });
  const slowFetch = async (u, i) => { await gate; return gh3.fetch(u, i); };
  const c3 = mockCaches();
  const many = Array.from({ length: 6 }, () => A.activityResponse(ctx(), { fetch: slowFetch, now, caches: c3 }));
  release();
  const res3 = await Promise.all(many.map((p) => p.then((x) => x.json())));
  await settle();
  check(gh3.calls.filter((c) => /events\/public/.test(c.url)).length === 1 && res3.every((b) => b.items[0].message === "One"), "6 concurrent cold requests -> one GitHub round trip");

  // optional token
  A._resetMemory();
  const gh4 = mockGitHub({ events: [] });
  const r4 = await A.activityResponse(ctx({ GITHUB_TOKEN: "ghp_test_token" }), { fetch: gh4.fetch, now, caches: mockCaches() });
  const b4 = await r4.json();
  check(gh4.calls[0].headers.Authorization === "Bearer ghp_test_token" && !JSON.stringify(b4).includes("ghp_"), "GITHUB_TOKEN set: sent as a bearer token, never echoed");
  check(r4.status === 200 && b4.ok && b4.items.length === 0, "no public activity: 200 with an empty list (the page shows its quiet-week note)");

  // nearly out of requests: skip the commit lookups, keep the fallback text
  A._resetMemory();
  const gh5 = mockGitHub({ events: [ev("PushEvent", "dgreen52/linework", { ref: "refs/heads/main", head: S2 }, "2026-10-08T17:00:00Z")], commits: { [S2]: "Would cost a request" } });
  gh5.remaining = 2;
  const b5 = await (await A.activityResponse(ctx(), { fetch: gh5.fetch, now, caches: mockCaches() })).json();
  check(b5.items[0].message === "Pushed to main" && !gh5.calls.some((c) => /git\/commits/.test(c.url)), "X-RateLimit-Remaining < 5: no commit lookups, 'Pushed to main'");

  // the route module is GET only
  const route = await import(pathToFileURL(path.join(ROOT, "functions/api/activity.js")).href);
  check(typeof route.onRequestGet === "function" && !route.onRequestPost && !route.onRequest, "functions/api/activity.js is GET only");

  console.log(fails ? `\n${fails} FAILED` : "\nall activity tests passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
