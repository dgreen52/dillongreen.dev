// Cumulative Layout Shift on a throttled phone profile (Chromium: WebKit has no layout-shift API).
//   node tools/test-cls.js [baseUrl] [--max 0.05]
// Each page loads in a fresh, cache-less context at 390x844 (touch, DPR 3) with 4x CPU slowdown
// and a slow-4G-ish network (SLOWFONT=ms delays the fonts further), then scrolls to the bottom the way a thumb would. Reports the
// largest session window (how Chrome scores CLS) plus which elements moved.
const { launch } = require("./pw");
const args = process.argv.slice(2);
const BASE = args.find((a) => /^https?:/.test(a)) || "http://127.0.0.1:8787/";
const MAX = args.includes("--max") ? Number(args[args.indexOf("--max") + 1]) : 0.05;
const PAGES = (process.env.PAGES || ",par.html,projects/,studio/,guestbook/,now/,privacy.html").split(",");

const OBSERVER = () => {
  window.__shifts = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__shifts.push({
          t: e.startTime, v: e.value,
          src: (e.sources || []).map((s) => s.node ? (s.node.nodeName + (s.node.className && typeof s.node.className === "string" ? "." + s.node.className.trim().split(/\s+/).join(".") : "")) : "?").slice(0, 3)
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) { /* not supported */ }
};

function sessionMax(shifts) { // 1 s gap, 5 s cap, like web-vitals
  let best = 0, cur = 0, start = 0, last = -1e9;
  for (const s of shifts) {
    if (s.t - last > 1000 || s.t - start > 5000) { cur = 0; start = s.t; }
    cur += s.v; last = s.t; best = Math.max(best, cur);
  }
  return best;
}

(async () => {
  const browser = await launch();
  let worst = 0;
  for (const pg of PAGES) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "dark" });
    await ctx.addInitScript(OBSERVER);
    // SLOWFONT=1500 holds the web fonts back that many ms, to see what a late font swap moves
    if (process.env.SLOWFONT) await ctx.route("**/*.woff2", async (r) => { await new Promise((ok) => setTimeout(ok, Number(process.env.SLOWFONT))); r.continue(); });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.goto(BASE + pg, { waitUntil: "load", timeout: 90000 });
    await page.waitForTimeout(1500);
    const loadCls = sessionMax(await page.evaluate(() => window.__shifts));
    // scroll like a thumb: 500px steps, so lazy images and late content get their chance to shift
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += 500) { await page.mouse.wheel(0, 500); await page.waitForTimeout(220); }
    await page.waitForTimeout(800);
    const shifts = await page.evaluate(() => window.__shifts);
    const cls = sessionMax(shifts);
    worst = Math.max(worst, cls);
    const top = shifts.slice().sort((a, b) => b.v - a.v).slice(0, 3).map((s) => `${s.v.toFixed(3)}@${Math.round(s.t)}ms ${s.src.join(" ")}`);
    console.log(`${cls <= MAX ? "ok " : "!! "}${(pg || "index").padEnd(30)} CLS ${cls.toFixed(3)} (load ${loadCls.toFixed(3)})${top.length ? "  " + top.join(" | ") : ""}`);
    await ctx.close();
  }
  await browser.close();
  console.log(`worst CLS ${worst.toFixed(3)} (budget ${MAX})`);
  process.exitCode = worst <= MAX ? 0 : 1;
})();
