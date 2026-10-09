// Screenshots + sanity checks against a locally served copy of site/.
//   python -m http.server 8787 --directory site     (in another shell; static pages only)
//   npx wrangler pages dev site --port 8788          (or this, to include /api and _headers/CSP)
//   node tools/verify.js [baseUrl]
// Writes verify/<page>-<width>-<theme>.png and prints any problems found. Mobile-specific
// checks (menu, tap targets, type floor, contrast) live in tools/test-mobile.js.
const path = require("path");
const { launch, launchWebKit, devices } = require("./pw");

const BASE = process.argv[2] || "http://127.0.0.1:8787/";
const OUT = path.resolve(__dirname, "..", "verify");
const PAGES = (process.env.PAGES || "index.html,par.html,projects/,arcade/,studio/,guestbook/,now/,privacy.html,404.html").split(",");
const WIDTHS = (process.env.WIDTHS || "1440,430,390,360").split(",").map(Number);
const THEMES = (process.env.THEMES || "light,dark").split(",");

(async () => {
  const browser = await launch();
  let problems = 0;
  for (const pg of PAGES) for (const w of WIDTHS) for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: theme, deviceScaleFactor: 1, reducedMotion: "reduce" });
    await ctx.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch (e) {} }, theme); // night is the default; "light" = daylight mode
    const page = await ctx.newPage();
    const bad = [];
    // the live-status widget's files are built separately; tolerate exactly those two being absent locally
    const OPTIONAL = /\/assets\/(js\/status\.js|css\/status\.css)(\?|$)/;
    page.on("response", (r) => { if (r.status() >= 400 && !(r.status() === 404 && OPTIONAL.test(r.url()))) bad.push(`${r.status()} ${r.url()}`); });
    page.on("requestfailed", (r) => bad.push(`FAILED ${r.url()}`));
    page.on("pageerror", (e) => bad.push(`JS ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !(/404/.test(m.text()) && OPTIONAL.test(m.location().url || ""))) bad.push(`console ${m.text()}`); });
    await page.goto(BASE + pg, { waitUntil: "networkidle" });
    // force lazy images to load before the full-page capture
    await page.evaluate(() => document.querySelectorAll('img[loading="lazy"]').forEach((i) => (i.loading = "eager")));
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    // Chromium only rasterizes images near the viewport; walk the page first.
    await page.evaluate(async () => {
      await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
      for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
      window.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 150));
    });
    const info = await page.evaluate(() => {
      const de = document.documentElement;
      const wide = [...document.querySelectorAll("body *")].filter((el) => {
        const r = el.getBoundingClientRect(); return r.right > de.clientWidth + 1 && getComputedStyle(el).position !== "fixed";
      }).slice(0, 5).map((el) => el.tagName + "." + el.className);
      return {
        overflow: de.scrollWidth - de.clientWidth,
        wide,
        brokenImgs: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src),
      };
    });
    if (info.overflow > 0) bad.push(`horizontal overflow ${info.overflow}px: ${info.wide.join(", ")}`);
    info.brokenImgs.forEach((s) => bad.push(`broken img ${s}`));
    const name = pg.replace(/\.html$/, "").replace(/\/$/, "").replace(/\//g, "-") || "index";
    const file = path.join(OUT, `${name}-${w}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log((bad.length ? "!! " : "ok ") + path.basename(file) + (bad.length ? "\n   " + bad.join("\n   ") : ""));
    problems += bad.length;
    await ctx.close();
  }
  await browser.close();

  // ---- zero sideways scroll on phones, Chromium + WebKit (iPhone) ----
  // The html/body overflow-x:clip guard is switched off first (inline CSSOM style, which the CSP
  // allows), so this measures real overflow, not the guard. Any element whose box pokes past the
  // viewport and isn't inside a scroll/clip container (rails, code blocks, tables) is listed.
  const PHONE_WIDTHS = (process.env.PHONE_WIDTHS || "320,360,375,390,414,430").split(",").map(Number);
  const sweep = async (engine) => {
    const b = engine === "webkit" ? await launchWebKit() : await launch();
    let bad = 0;
    for (const pg of PAGES) for (const w of PHONE_WIDTHS) {
      const ctx = await b.newContext({ ...(engine === "webkit" ? devices["iPhone 13"] : { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }), viewport: { width: w, height: 800 }, reducedMotion: "reduce" });
      if (engine === "webkit") await ctx.route("**/*", async (route) => { // WebKit upgrades 127.0.0.1 to https under upgrade-insecure-requests; local only
        let r; try { r = await route.fetch(); } catch (e) { return; } // context closed mid-request
        const h = r.headers();
        if (h["content-security-policy"]) h["content-security-policy"] = h["content-security-policy"].replace(/;\s*upgrade-insecure-requests/, "");
        await route.fulfill({ response: r, headers: h }).catch(() => {});
      });
      const page = await ctx.newPage();
      await page.goto(BASE + pg, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const r = await page.evaluate(() => {
        const de = document.documentElement, W = de.clientWidth;
        const guarded = de.scrollWidth - W;
        de.style.setProperty("overflow-x", "visible", "important");
        document.body.style.setProperty("overflow-x", "visible", "important");
        const raw = Math.max(de.scrollWidth, document.body.scrollWidth) - W;
        const contained = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { if (getComputedStyle(n).overflowX !== "visible") return true; } return false; };
        const offenders = [...document.querySelectorAll("body *")].filter((el) => {
          const bx = el.getBoundingClientRect(), cs = getComputedStyle(el);
          return bx.width > 0 && bx.right > W + 0.5 && cs.position !== "fixed" && !el.closest("dialog:not([open])") && !contained(el);
        }).slice(0, 6).map((el) => {
          const id = el.id ? "#" + el.id : "", cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "";
          return `${el.tagName.toLowerCase()}${id}${cls} w=${el.getBoundingClientRect().width.toFixed(0)} right=${el.getBoundingClientRect().right.toFixed(1)}`;
        });
        de.style.removeProperty("overflow-x"); document.body.style.removeProperty("overflow-x");
        return { guarded, raw, W, offenders };
      });
      const ok = r.guarded <= 0 && r.raw <= 0 && r.offenders.length === 0;
      if (!ok) { bad++; console.log(`!! ${engine} ${pg} @${w}: scrollWidth-clientWidth ${r.raw}px (with guard ${r.guarded}px)\n   ${r.offenders.join("\n   ")}`); }
      await ctx.close();
    }
    await b.close();
    console.log(`${bad ? "!!" : "ok"} ${engine}: no sideways scroll on ${PAGES.length} pages x ${PHONE_WIDTHS.join("/")}`);
    return bad;
  };
  problems += await sweep("chromium");
  problems += await sweep("webkit");

  console.log(problems ? `${problems} problem(s)` : "all clean");
  process.exitCode = problems ? 1 : 0;
})();
