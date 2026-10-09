// iPhone checks in WebKit (the engine iOS Safari runs).
//   node tools/test-webkit.js [baseUrl]
// One-time local setup: node ../pocket429/node_modules/playwright/cli.js install webkit
//
// Local-only quirk: the CSP's upgrade-insecure-requests makes WebKit rewrite http://127.0.0.1
// subresources to https (Chromium exempts localhost), so this script strips that one directive
// from responses. Everything else in the CSP stays enforced, and violations still fail the run.
const path = require("path");
const { launchWebKit, devices } = require("./pw");
const BASE = process.argv[2] || "http://127.0.0.1:8787/";
const OUT = path.resolve(__dirname, "..", "verify");
const PAGES = ["", "projects/", "par.html", "studio/", "guestbook/", "now/", "privacy.html", "404.html"];
const IPHONE = devices["iPhone 13"];
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };

(async () => {
  const browser = await launchWebKit();
  const errors = [];
  // Playwright's WebKit screenshots inject a <style> (caret/scrollbar hiding) that the strict CSP
  // refuses, logging "Refused to apply a stylesheet". Pages that take screenshots ignore exactly
  // that message; section 1 loads every page without screenshots, so a real violation still fails.
  const newPage = async (width, theme, height, shots) => {
    const ctx = await browser.newContext({ ...IPHONE, viewport: { width, height: height || IPHONE.viewport.height }, colorScheme: theme, reducedMotion: "no-preference" });
    await ctx.route("**/*", async (route) => {
      let r; try { r = await route.fetch(); } catch (e) { return; } // context closed mid-request
      const h = r.headers();
      if (h["content-security-policy"]) h["content-security-policy"] = h["content-security-policy"].replace(/;\s*upgrade-insecure-requests/, "");
      await route.fulfill({ response: r, headers: h }).catch(() => {});
    });
    await ctx.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch (e) {} }, theme);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${page.url()} JS ${e.message}`));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      if (shots && /^Refused to apply a stylesheet/.test(m.text())) return;
      errors.push(`${page.url()} console ${m.text()}`);
    });
    return { ctx, page };
  };

  // 1. every page at 320/360/390/430: not even 1px of sideways overflow, no boot overlay, no sticky pointer effects
  for (const pg of PAGES) for (const w of [320, 360, 390, 430]) {
    const { ctx, page } = await newPage(w, w === 390 ? "dark" : "light");
    await page.goto(BASE + pg, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const r = await page.evaluate(() => {
      const de = document.documentElement, W = de.clientWidth;
      const clipped = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o !== "visible") return true; } return false; };
      const wide = [...document.querySelectorAll("body *")].filter((el) => {
        const b = el.getBoundingClientRect(); return b.width && b.right > W + 0.5 && getComputedStyle(el).position !== "fixed" && !clipped(el);
      }).slice(0, 4).map((el) => el.tagName + "." + String(el.className).split(" ")[0] + " right=" + el.getBoundingClientRect().right.toFixed(1));
      const proj = document.querySelector(".project");
      return {
        overflow: de.scrollWidth - W, bodyOverflow: document.body.scrollWidth - W, wide,
        boot: !!document.querySelector(".boot"),
        coarse: matchMedia("(pointer: coarse)").matches,
        tilt: proj ? getComputedStyle(proj).transform : "none",
        heroFx: document.querySelector(".ambient") ? getComputedStyle(document.querySelector(".ambient")).display : "none", // cursor grid: never on touch
        blur: getComputedStyle(document.querySelector(".top") || document.body).backdropFilter || getComputedStyle(document.querySelector(".top") || document.body).webkitBackdropFilter || "none",
        smallInputs: [...document.querySelectorAll("input:not([type=checkbox]):not([type=hidden]), select, textarea")].filter((i) => !i.closest(".hp") && parseFloat(getComputedStyle(i).fontSize) < 16).length,
      };
    });
    const tag = `${pg || "index"} @${w}`;
    check(r.overflow <= 0 && r.bodyOverflow <= 0 && r.wide.length === 0, `${tag}: no sideways overflow (${r.overflow}px${r.wide.length ? "; " + r.wide.join(", ") : ""})`);
    if (w === 390) {
      check(r.coarse && !r.boot, `${tag}: coarse pointer, no boot overlay`);
      check(r.tilt === "none" && r.heroFx === "none", `${tag}: no card tilt transform / cursor grid on touch`);
      check(r.blur === "none", `${tag}: no backdrop blur on the sticky header`);
      check(r.smallInputs === 0, `${tag}: form fields are 16px+ (no zoom on focus)`);
    }
    await ctx.close();
  }

  // 2. home on an iPhone 13: scroll through and keep a screenshot every ~800px
  {
    const { ctx, page } = await newPage(390, "dark", 0, true);
    await page.goto(BASE, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    let i = 0;
    for (let y = 0; y < H; y += 800, i++) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(350);
      const hdr = await page.evaluate(() => { const r = document.querySelector(".top").getBoundingClientRect(); return { top: r.top, h: r.height }; });
      if (y > 0) check(Math.abs(hdr.top) < 1, `scroll ${y}: sticky header stays pinned (top ${hdr.top})`);
      await page.screenshot({ path: path.join(OUT, `wk-home-${String(i).padStart(2, "0")}.png`) });
    }
    console.log(`   ${i} scroll frames -> verify/wk-home-*.png (page ${H}px)`);
    await page.screenshot({ path: path.join(OUT, "wk-index-390-dark.png"), fullPage: true, caret: "initial" });

    // tapping things on touch must not leave hover/glitch states behind
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.tap('.bit[data-bit="12"]');
    check((await page.textContent("[data-value]")).includes("+35,001"), "tap flips a bit in WebKit");
    const glitch = await page.evaluate(() => { const g = document.querySelector(".project .glitch"); return getComputedStyle(g).animationName; });
    check(glitch === "none", `no hover glitch animation on touch (${glitch})`);

    // menu
    await page.tap(".top [data-menu]");
    check(await page.isVisible("dialog.menu[open]"), "menu opens in WebKit");
    check(await page.evaluate(() => getComputedStyle(document.documentElement).overflow === "hidden"), "scroll locked under the menu");
    await page.screenshot({ path: path.join(OUT, "wk-menu-390-dark.png"), caret: "initial" });
    await page.tap(".menu-x");
    check(!(await page.isVisible("dialog.menu[open]")), "menu closes in WebKit");
    // a More button and a rail
    await page.locator('.project .more-btn[aria-controls^="x-par"]').scrollIntoViewIfNeeded();
    await page.tap('.project .more-btn[aria-controls^="x-par"]');
    check(await page.isVisible("#x-par"), "More expands in WebKit");
    const rail = await page.$eval("#practice .rail", (e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).scrollSnapType.includes("x"));
    check(rail, "card rail scrolls sideways with snap in WebKit");
    await ctx.close();
  }

  // 3. full-page WebKit captures of the other pages
  for (const pg of PAGES.slice(1)) {
    const { ctx, page } = await newPage(390, "light", 0, true);
    await page.goto(BASE + pg, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const name = pg.replace(/\.html$/, "").replace(/\/$/, "").replace(/\//g, "-");
    await page.screenshot({ path: path.join(OUT, `wk-${name}-390-light.png`), fullPage: true, caret: "initial" });
    await ctx.close();
  }
  { // projects: tap a filter chip in WebKit
    const { ctx, page } = await newPage(390, "dark", 0, true);
    await page.goto(BASE + "projects/", { waitUntil: "load" });
    await page.tap('[data-filter="aviation"]');
    const ids = await page.$$eval(".pcard", (cs) => cs.filter((c) => !c.hidden).map((c) => c.id));
    check(ids.join() === "par,pocket429,airfield,butter", "WebKit: Aviation filter -> " + ids.join(", "));
    await page.screenshot({ path: path.join(OUT, "wk-projects-aviation-390-dark.png"), caret: "initial" });
    await ctx.close();
  }
  { // studio form, focused field (iOS would zoom here if the font were under 16px)
    const { ctx, page } = await newPage(390, "dark", 0, true);
    await page.goto(BASE + "studio/#waitlist", { waitUntil: "load" });
    await page.tap("#waitlist input[type=email]");
    await page.locator("#waitlist").screenshot({ path: path.join(OUT, "wk-studio-form-390-dark.png"), caret: "initial" });
    await ctx.close();
  }

  check(errors.length === 0, "no JS/console/CSP errors in WebKit " + (errors.length ? JSON.stringify(errors.slice(0, 5)) : ""));
  console.log(fails ? fails + " failure(s)" : "all WebKit checks pass");
  await browser.close();
  process.exitCode = fails ? 1 : 0;
})();
