// Browser checks for the network status widget (assets/js/status.js + assets/css/status.css).
// Serves a tiny demo page through Playwright routing (with the site's real CSP from site/_headers) on top of
// a running `wrangler pages dev` (for site.css/fonts), and mocks /api/status. No real network checks.
//   node tools/test-status-ui.js [baseUrl]        screenshots: verify/status-*.png
const path = require("path");
const fs = require("fs");
const { launch } = require("./pw");

const BASE = (process.argv[2] || "http://127.0.0.1:8791/").replace(/\/$/, "");
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "verify");
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };
const CSP = fs.readFileSync(path.join(ROOT, "site/_headers"), "utf8").match(/Content-Security-Policy: (.*)/)[1].trim();

const DEMO = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>status demo</title>
<link rel="stylesheet" href="/assets/css/site.css"><link rel="stylesheet" href="/assets/css/status.css">
<script src="/assets/js/theme.js"></script></head>
<body><main class="wrap" id="main"><p class="mono">above the panel</p>
<div data-status-panel></div>
<p class="mono" id="below">below the panel</p>
<p>card lamps: <span data-status-slug="pocket429"></span> <span data-status-slug="little-airfield"></span> <span data-status-slug="beepbeach" id="custom">beepbeach</span></p>
</main><script src="/assets/js/status.js" defer></script></body></html>`;

const NODES = [
  ["pocket429", "pocket429", "up", 182, "https://pocket429.dillongreen.dev"],
  ["linework", "Linework", "up", 64, "https://linework-c4u.pages.dev"],
  ["fernwood", "Fernwood", "up", 131, "https://fernwood.dillon-eu-green.workers.dev/"],
  ["airfield", "Little Airfield", "up", 96, "https://little-airfield.dillon-eu-green.workers.dev/"],
  ["mixtape", "Mixtape Drift", "up", 141, "https://mixtape-drift.dillon-eu-green.workers.dev/"],
  ["crumb", "Crumb", "up", 88, "https://crumb.dillon-eu-green.workers.dev"],
  ["dragonrealm", "Dragon Realm Online", "slow", 1873, "https://dragonrealm.dillon-eu-green.workers.dev/"],
  ["surprisepass", "surprisepass", "up", 203, "https://surprisepass.pages.dev"],
  ["butter", "butter", "up", 77, "https://butter.dillon-eu-green.workers.dev"],
  ["beepbeach", "beepbeach", "down", 4001, "https://beepbeach.dillon-eu-green.workers.dev"],
  ["halfsies", "halfsies", "up", 120, "https://halfsies.dillon-eu-green.workers.dev"],
].map(([slug, name, status, ms, url]) => ({ slug, name, status, ms, url }));
const payload = (nodes = NODES) => JSON.stringify({ checked_at: new Date(Date.now() - 5000).toISOString(), up: nodes.filter((n) => n.status !== "down").length, total: nodes.length, nodes });

(async () => {
  const browser = await launch();
  const errors = [];

  async function open(width, opts = {}) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, reducedMotion: opts.reduced ? "reduce" : "no-preference", hasTouch: width < 600, isMobile: width < 600 });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" && !/status of 500/.test(m.text())) errors.push(`${width}: ${m.text()}`); });
    page.on("pageerror", (e) => errors.push(`${width}: ${e.message}`));
    const api = { calls: 0 };
    if (opts.clock) await page.clock.install();
    if (opts.light) await page.addInitScript(() => { try { localStorage.setItem("theme", "light"); } catch (e) {} });
    await page.route("**/__status-demo/", (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": CSP }, body: DEMO }));
    await page.route("**/api/status", async (r) => {
      api.calls++;
      if (opts.delay) await new Promise((res) => setTimeout(res, opts.delay));
      if (opts.fail) return r.fulfill({ status: 500, contentType: "application/json", body: "{}" });
      r.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "public, max-age=30" }, body: opts.allUp ? payload(NODES.map((n) => ({ ...n, status: "up", ms: 90 }))) : payload() });
    });
    await page.goto(BASE + "/__status-demo/", { waitUntil: "domcontentloaded" });
    return { ctx, page, api };
  }
  const box = (page) => page.$eval("[data-status-panel]", (p) => Math.round(p.getBoundingClientRect().height));
  const belowY = (page) => page.$eval("#below", (p) => Math.round(p.getBoundingClientRect().top));

  for (const width of [320, 390, 1440]) {
    const { ctx, page } = await open(width, { delay: 800 });
    const h0 = await box(page), y0 = await belowY(page);
    await page.waitForSelector(".ns-node:not(.is-skel)", { timeout: 8000 });
    const h1 = await box(page), y1 = await belowY(page);
    check(h0 === h1 && y0 === y1 && h0 > 100, `${width}px: reserved height ${h0}px, no layout shift after data (${h1}px)`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px: no sideways scroll`);
    const count = await page.textContent(".ns-count");
    check(width < 360 ? /10\/11\s+(NODES )?ONLINE/.test(count) : /10\/11\s+NODES ONLINE/.test(count), `${width}px: header says 10/11 NODES ONLINE (10/11 ONLINE under 360px)`);
    check(await page.$eval(".ns-head", (h) => h.scrollWidth <= h.clientWidth + 1), `${width}px: header text fits`);
    check(await page.textContent(".ns-title") === "// NETWORK STATUS", `${width}px: // NETWORK STATUS title`);
    await page.screenshot({ path: path.join(OUT, `status-${width}.png`), clip: await page.$eval("[data-status-panel]", (p) => { const r = p.getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: r.y - 8, width: Math.min(window.innerWidth - Math.max(0, r.x - 8), r.width + 16), height: r.height + 16 }; }) });
    if (width === 390) {
      const states = await page.$$eval(".ns-node", (ns) => ns.map((n) => [n.dataset.state, n.querySelector(".ns-state").textContent, n.getAttribute("aria-label")]));
      check(states.length === 11 && states.every(([s, label]) => label.toLowerCase() === s), "every node shows its state as text (Up/Slow/Down), not colour alone");
      check(states.find(([s]) => s === "down")[2] === "beepbeach: Down" && /Dragon Realm Online: Slow, 1\.9 s/.test(states.find(([s]) => s === "slow")[2]), "aria-labels: 'beepbeach: Down', 'Dragon Realm Online: Slow, 1.9 s'");
      check(/checked \d+s ago/.test(await page.textContent(".ns-foot")), "footer: checked Xs ago");
      check(await page.$eval('[data-status-slug="pocket429"]', (e) => e.dataset.state) === "up" && await page.$eval('[data-status-slug="little-airfield"]', (e) => e.dataset.state) === "up" && await page.$eval("#custom", (e) => e.dataset.state === "down" && e.textContent === "beepbeach"), "card lamps get data-state (slug or host alias); non-empty elements keep their text");
      check(await page.$eval('[data-status-slug="pocket429"] .ns-sr', (e) => e.textContent) === "Status: Up", "empty lamp gets screen-reader text");
      const small = await page.$$eval(".ns-node", (ns) => ns.filter((n) => n.getBoundingClientRect().height < 44).length);
      check(small === 0, "node tiles are >= 44px tall (tap targets)");
      const minFont = await page.$$eval(".ns *", (els) => Math.min(...els.filter((e) => e.textContent.trim()).map((e) => parseFloat(getComputedStyle(e).fontSize))));
      check(minFont >= 12, `text >= 12px (min ${minFont}px)`);
    }
    await ctx.close();
  }

  // all nodes up: header lamp pulses (only when motion is allowed)
  {
    const { ctx, page } = await open(390, { allUp: true });
    await page.waitForSelector(".ns-node:not(.is-skel)", { timeout: 8000 });
    check(/11\/11/.test(await page.textContent(".ns-count")) && await page.$eval(".ns-lamp", (e) => getComputedStyle(e).animationName) !== "none", "11/11 up + motion allowed: header lamp pulses");
    await ctx.close();
  }
  // reduced motion: nothing animates
  {
    const { ctx, page } = await open(390, { reduced: true, allUp: true });
    await page.waitForSelector(".ns-node:not(.is-skel)", { timeout: 8000 });
    check(await page.$$eval(".ns, .ns *", (els) => els.every((e) => getComputedStyle(e).animationName === "none")), "reduced motion: no animations");
    await ctx.close();
  }

  // daylight
  {
    const { ctx, page } = await open(390, { light: true });
    await page.waitForSelector(".ns-node:not(.is-skel)", { timeout: 8000 });
    await page.screenshot({ path: path.join(OUT, "status-390-light.png"), clip: await page.$eval("[data-status-panel]", (p) => { const r = p.getBoundingClientRect(); return { x: 0, y: r.y - 8, width: window.innerWidth, height: r.height + 16 }; }) });
    await ctx.close();
  }

  // failure: soft "status unavailable", same height
  {
    const { ctx, page } = await open(390, { fail: true });
    const h0 = await box(page);
    await page.waitForSelector(".ns-msg", { timeout: 8000 });
    check(/status unavailable/i.test(await page.textContent(".ns-msg")) && await box(page) === h0, "API error -> 'status unavailable', no height change");
    await page.screenshot({ path: path.join(OUT, "status-390-unavailable.png"), clip: await page.$eval("[data-status-panel]", (p) => { const r = p.getBoundingClientRect(); return { x: 0, y: r.y - 8, width: window.innerWidth, height: r.height + 16 }; }) });
    await ctx.close();
  }

  // refresh cadence: every 60 s while visible, paused while hidden
  {
    const { ctx, page, api } = await open(390, { clock: true });
    await page.clock.runFor(5000); // idle callback timeout + load
    await page.waitForSelector(".ns-node:not(.is-skel)", { timeout: 8000 });
    const first = api.calls;
    check(first === 1, `one fetch on load (${first})`);
    await page.clock.runFor(61000);
    await page.waitForTimeout(200);
    check(api.calls === 2, `refetched after 60 s while visible (${api.calls})`);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.runFor(180000);
    await page.waitForTimeout(200);
    check(api.calls === 2, `no fetches while the tab is hidden (${api.calls})`);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(300);
    check(api.calls === 3, `refetched right away when visible again with stale data (${api.calls})`);
    await ctx.close();
  }

  await browser.close();
  check(errors.length === 0, "no console / CSP / page errors" + (errors.length ? ":\n   " + errors.join("\n   ") : ""));
  console.log(fails ? `\n${fails} FAILED` : "\nall status widget tests passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
