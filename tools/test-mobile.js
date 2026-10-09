// Phone-sized checks: layout, type floor, tap targets, contrast, the menu sheet, "More"
// disclosures, card rails and the bit-flipper. Screenshots go to verify/m-*.png.
//   node tools/test-mobile.js [baseUrl]
// Uses touch + mobile emulation (coarse pointer, like a real phone).
const path = require("path");
const { launch } = require("./pw");
const BASE = process.argv[2] || "http://127.0.0.1:8787/";
const OUT = path.resolve(__dirname, "..", "verify");
const PAGES = ["", "projects/", "arcade/", "par.html", "studio/", "guestbook/", "now/", "privacy.html", "404.html"];
const WIDTHS = (process.env.WIDTHS || "320,360,390,430").split(",").map(Number);
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };

// Runs in the page: lists text below the type floor, small tap targets and low-contrast text.
function audit() {
  const vis = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[aria-hidden='true'], dialog:not([open]), .sr-only, .hp");
  };
  const parse = (c) => {
    const m = (c.replace(/^color\(srgb/, "").match(/[\d.]+/g) || [0, 0, 0, 0]).map(Number);
    const k = /^color\(srgb/.test(c) ? 255 : 1; // color-mix() computes to color(srgb r g b / a), 0..1
    return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m[3] === undefined ? 1 : m[3] };
  };
  const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== "none" && !/gradient/.test(cs.backgroundImage)) return null; // image: can't judge
      const c = parse(cs.backgroundColor);
      if (c.a > 0.5) return c;
    }
    return parse(getComputedStyle(document.body).backgroundColor);
  };
  const small = [], lowc = [], taps = [];
  const textEls = [...document.querySelectorAll("body *")].filter((el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && vis(el) && !el.closest("svg, .badges, .boot, .term, .odometer, .gb-titlebar .ctl"));
  for (const el of textEls) {
    const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize);
    const name = el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").join(".") : "");
    if (fs < 11.95) small.push(`${name} ${fs}px "${el.textContent.trim().slice(0, 30)}"`);
    const bg = bgOf(el);
    if (bg) {
      const fg = parse(cs.color);
      const L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const large = fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700);
      if (ratio < (large ? 3 : 4.5)) lowc.push(`${name} ${ratio.toFixed(2)}:1 "${el.textContent.trim().slice(0, 30)}"`);
    }
  }
  for (const el of document.querySelectorAll("a[href], button, input:not([type=checkbox]):not([type=hidden]), select, textarea, [tabindex='0']")) {
    if (!vis(el) || el.closest(".hp")) continue;
    const cs = getComputedStyle(el);
    // inline links inside running text are exempt (WCAG 2.5.8)
    if (el.tagName === "A" && cs.display === "inline" && el.parentElement && /^(P|LI|SPAN|SMALL|TD|DD|FIGCAPTION|EM|STRONG)$/.test(el.parentElement.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (el.classList.contains("bit")) { if (r.width < (innerWidth >= 360 ? 40 : 34) || r.height < 44) taps.push(`bit ${r.width.toFixed(0)}x${r.height.toFixed(0)}`); continue; }
    if (r.height < 43.5 || r.width < 24) taps.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${r.width.toFixed(0)}x${r.height.toFixed(0)} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}"`);
  }
  const inputs = [...document.querySelectorAll("input, select, textarea")].filter((i) => i.type !== "checkbox" && i.type !== "hidden" && !i.closest(".hp"))
    .filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16).map((i) => (i.id || i.name || i.className) + " " + getComputedStyle(i).fontSize);
  const de = document.documentElement;
  return { small, lowc, taps, inputs, overflow: de.scrollWidth - de.clientWidth, height: de.scrollHeight };
}

(async () => {
  const browser = await launch();
  const errors = [];
  const newPage = async (w, theme, h = 844) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme, reducedMotion: "reduce" });
    await ctx.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch (e) {} }, theme); // night is the default; "light" = daylight mode
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${page.url()} JS ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${page.url()} console ${m.text()}`); });
    return { ctx, page };
  };

  // 1. every page, every width, both themes: overflow, type floor, targets, contrast, input zoom
  const heights = {};
  for (const pg of PAGES) for (const w of WIDTHS) for (const theme of ["light", "dark"]) {
    const { ctx, page } = await newPage(w, theme);
    await page.goto(BASE + pg, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const a = await page.evaluate(audit);
    if (w === 390 && theme === "dark") heights[pg || "index"] = a.height;
    const tag = `${pg || "index"} @${w} ${theme}`;
    check(a.overflow <= 0, `${tag}: no horizontal scroll (${a.overflow}px)`);
    if (a.small.length) check(false, `${tag}: text under 12px: ${a.small.slice(0, 6).join(" | ")}`);
    if (a.lowc.length) check(false, `${tag}: contrast below AA: ${a.lowc.slice(0, 6).join(" | ")}`);
    if (a.taps.length) check(false, `${tag}: tap targets under 44px: ${a.taps.slice(0, 8).join(" | ")}`);
    if (a.inputs.length) check(false, `${tag}: inputs under 16px (iOS zoom): ${a.inputs.join(", ")}`);
    await ctx.close();
  }
  console.log("page heights at 390 (dark, touch):", JSON.stringify(heights));
  check(heights.index < 7000, `home is under 7,000px at 390 (${heights.index})`);

  // 2. menu sheet
  {
    const { ctx, page } = await newPage(390, "dark");
    await page.goto(BASE + "now/", { waitUntil: "networkidle" });
    const btn = page.locator(".top [data-menu]");
    check(await btn.isVisible(), "menu button visible in the header");
    const box = await btn.boundingBox();
    check(box && box.width >= 44 && box.height >= 44, `menu button is 44px+ (${box && box.width}x${box && box.height})`);
    check((await btn.getAttribute("aria-controls")) === "site-menu", "menu button has aria-controls");
    await btn.click();
    check(await page.isVisible("dialog.menu[open]"), "menu opens");
    check((await btn.getAttribute("aria-expanded")) === "true", "aria-expanded=true while open");
    check(await page.evaluate(() => getComputedStyle(document.documentElement).overflow === "hidden"), "page scroll is locked while open");
    check(await page.evaluate(() => !!document.activeElement.closest("dialog.menu")), "focus moves into the sheet");
    const links = await page.$$eval("dialog.menu .menu-nav a", (as) => as.map((a) => a.textContent));
    check(["Projects", "Arcade", "Studio", "How I work", "Experience", "Guestbook", "Now"].every((t) => links.some((l) => l.includes(t))), "sheet lists the nav links: " + links.join(", "));
    check(await page.isVisible('dialog.menu a[href$="Dillon_Green_Resume.pdf"]') && await page.isVisible('dialog.menu a[href^="mailto:"]'), "sheet has resume + email");
    check((await page.getAttribute('dialog.menu a[aria-current="page"]', "href")) === "/now/", "current page is marked");
    await page.screenshot({ path: path.join(OUT, "m-menu-open-390-dark.png") });
    // focus trap: tab past the end wraps to the start
    const n = await page.$$eval("dialog.menu a[href], dialog.menu button", (e) => e.length);
    for (let i = 0; i < n; i++) await page.keyboard.press("Tab");
    check(await page.evaluate(() => !!document.activeElement.closest("dialog.menu")), "Tab stays inside the sheet");
    await page.keyboard.press("Shift+Tab");
    check(await page.evaluate(() => !!document.activeElement.closest("dialog.menu")), "Shift+Tab stays inside the sheet");
    await page.keyboard.press("Escape");
    check(!(await page.isVisible("dialog.menu[open]")), "Esc closes the sheet");
    await page.waitForFunction(() => document.querySelector(".top [data-menu]").getAttribute("aria-expanded") === "false", null, { timeout: 2000 }).catch(() => {});
    check((await btn.getAttribute("aria-expanded")) === "false", "aria-expanded=false after close");
    check(await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute("data-menu")), "focus returns to the menu button");
    check(await page.evaluate(() => getComputedStyle(document.documentElement).overflow !== "hidden"), "scroll lock released");
    await btn.click(); await page.click(".menu-x");
    check(!(await page.isVisible("dialog.menu[open]")), "close button closes the sheet");
    await btn.click(); await page.mouse.click(12, 400);
    check(!(await page.isVisible("dialog.menu[open]")), "tapping the backdrop closes the sheet");
    await btn.click();
    await Promise.all([page.waitForURL(/\/#experience$/), page.click('dialog.menu a[href="/#experience"]')]);
    await page.waitForTimeout(300);
    check(await page.evaluate(() => { const r = document.getElementById("experience").getBoundingClientRect(); return Math.abs(r.top) < 120; }), "menu link goes to /#experience");
    // light theme + home variant (hash links stay on the page)
    await ctx.close();
    const l = await newPage(390, "light");
    await l.page.goto(BASE, { waitUntil: "networkidle" });
    await l.page.click(".top [data-menu]");
    check((await l.page.getAttribute('dialog.menu .menu-nav a:has-text("Experience")', "href")) === "#experience", "on home, Experience is a same-page link");
    await l.page.screenshot({ path: path.join(OUT, "m-menu-open-390-light.png") });
    await l.ctx.close();
  }

  // 3. hero, bit-flipper, disclosures, rails (home @390)
  for (const theme of ["dark", "light"]) {
    const { ctx, page } = await newPage(390, theme);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, `m-hero-390-${theme}.png`) });
    if (theme === "light") { await ctx.close(); continue; }
    const geo = await page.evaluate(() => {
      const bits = [...document.querySelectorAll(".bit")].map((b) => b.getBoundingClientRect());
      const rows = new Set(bits.map((r) => Math.round(r.top))).size;
      const ro = document.querySelector(".readout").getBoundingClientRect();
      const last = bits[bits.length - 1];
      return { w: Math.min(...bits.map((r) => r.width)), h: Math.min(...bits.map((r) => r.height)), rows, gap: ro.top - last.bottom,
        cta: [...document.querySelectorAll(".hero .cta .btn")].map((b) => Math.round(b.getBoundingClientRect().top)) };
    });
    check(geo.rows === 4 && geo.w >= 40 && geo.h >= 44, `bits: 4 rows, smallest ${geo.w.toFixed(1)}x${geo.h.toFixed(1)}px`);
    check(geo.gap >= 0 && geo.gap < 24, `decoded readout sits right under the bits (${geo.gap.toFixed(0)}px)`);
    check(geo.cta.length === 3 && geo.cta[1] === geo.cta[2] && geo.cta[0] < geo.cta[1], "hero CTAs: full-width primary, GitHub + Email paired");
    await page.locator(".word").scrollIntoViewIfNeeded();
    await page.tap('.bit[data-bit="12"]');
    check((await page.textContent("[data-value]")).includes("+35,001"), "tapping a bit on a phone flips it");
    await page.locator(".word").screenshot({ path: path.join(OUT, "m-flipper-390-dark.png") });
    // disclosures
    const more = page.locator('.project .more-btn[aria-controls^="x-par"]');
    check(!(await page.isVisible("#x-par")), "PAR description starts collapsed on phones");
    await more.click();
    check(await page.isVisible("#x-par") && await page.isVisible("#x-par-t") && (await more.getAttribute("aria-expanded")) === "true", "More opens the description + tags");
    await page.locator("#p-par").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "m-more-open-390-dark.png") });
    await more.click();
    check(!(await page.isVisible("#x-par")) && (await more.getAttribute("aria-expanded")) === "false", "Less closes it again");
    // rails
    for (const sel of ["#practice .rail"]) {
      const r = await page.evaluate((s) => { const el = document.querySelector(s); const kids = [...el.children].map((c) => c.getBoundingClientRect());
        return { scroll: el.scrollWidth > el.clientWidth, role: el.getAttribute("role"), tab: el.tabIndex, label: el.getAttribute("aria-label"), peek: kids[1].left < innerWidth && kids[1].right > innerWidth }; }, sel);
      check(r.scroll && r.role === "region" && r.tab === 0 && r.label, `${sel}: scrolls sideways, focusable labelled region`);
      check(r.peek, `${sel}: next card peeks in from the right edge`);
    }
    await page.locator("#practice .rail").scrollIntoViewIfNeeded();
    await page.focus("#practice .rail");
    const before = await page.$eval("#practice .rail", (e) => e.scrollLeft);
    await page.keyboard.press("ArrowRight"); await page.waitForTimeout(400);
    const after = await page.$eval("#practice .rail", (e) => e.scrollLeft);
    check(after > before, `arrow keys scroll the rail (${before} -> ${after})`);
    await page.$eval("#practice .rail", (e) => e.scrollLeft = 0);
    await page.locator("#practice").screenshot({ path: path.join(OUT, "m-rail-practice-390-dark.png") });
    check(await page.isVisible('.see-all a[href="/projects/"]'), "home links to all projects");
    await ctx.close();
  }

  // 4. /projects/: filter chips (aria-pressed + #hash), compact cards, and no-JS shows everything.
  //    Expected cards come from tools/projects.json (one card per project, in file order).
  const PROJ = require("./projects.json").projects;
  const ALL = PROJ.length;
  const GAMES = PROJ.filter((p) => p.cats.includes("games")).map((p) => p.slug);
  const EXPERIMENTS = PROJ.filter((p) => p.cats.includes("experiments")).map((p) => p.slug);
  for (const theme of ["dark", "light"]) {
    const { ctx, page } = await newPage(390, theme);
    await page.goto(BASE + "projects/", { waitUntil: "networkidle" });
    const vis = () => page.$$eval(".pcard", (cs) => cs.filter((c) => !c.hidden).map((c) => c.id));
    check((await vis()).join() === PROJ.map((p) => p.slug).join(), `${theme}: all ${ALL} projects listed`);
    await page.tap('[data-filter="games"]');
    const games = await vis();
    check(games.join() === GAMES.join() && games.includes("fernwood") && (await page.getAttribute('[data-filter="games"]', "aria-pressed")) === "true" && page.url().endsWith("#games"), `${theme}: Games filter -> ${games.join(", ")} and #games`);
    check((await page.textContent("[data-filter-count]")).includes(`${GAMES.length} of ${ALL}`), `${theme}: count is announced (${GAMES.length} of ${ALL})`);
    await page.screenshot({ path: path.join(OUT, `m-projects-games-390-${theme}.png`) });
    await page.tap('[data-filter="all"]');
    check((await vis()).length === ALL && !page.url().includes("#"), `${theme}: All resets the list and the hash`);
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage(390, "dark");
    await page.goto(BASE + "projects/#experiments", { waitUntil: "networkidle" });
    const ids = await page.$$eval(".pcard", (cs) => cs.filter((c) => !c.hidden).map((c) => c.id));
    check(ids.join() === EXPERIMENTS.join(), `deep link #experiments opens filtered (${ids.join(", ")})`);
    const links = await page.$$eval('[data-cats="experiments"] a[href^="http"]', (a) => a.length);
    check(links === 0, "experiments have no store/external links");
    const data = require("./projects.json").projects;
    const live = await page.$$eval(".live-web a", (as) => as.map((a) => a.href.replace(/\/$/, "")));
    const want = data.filter((p) => p.url).map((p) => p.url.replace(/\/$/, ""));
    check(live.join() === want.join(), `Live on the web lists every live URL from projects.json (${live.length})`);
    const cardLinks = await page.$$eval(".pcard a[data-project]", (as) => as.map((a) => a.href.replace(/\/$/, "")));
    check(want.every((u) => cardLinks.includes(u)), "every live project's card links to it");
    check(!/jaderealm\.dillon-eu-green|>jaderealm</i.test(await page.content()), "old jaderealm name/URL gone");
    await page.goto(BASE + "projects/#this-site", { waitUntil: "networkidle" });
    await page.tap("#this-site [data-recurse]");
    await page.waitForTimeout(400);
    check(page.url().includes("/projects/") && (await page.isVisible(".toast")) && (await page.textContent(".toast")).includes("recursion depth exceeded"), "this-site Visit: stays put, recursion toast");
    await ctx.close();
    const nojs = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
    const np = await nojs.newPage();
    await np.goto(BASE + "projects/#games", { waitUntil: "load" });
    const shown = await np.$$eval(".pcard", (cs) => cs.filter((c) => c.getBoundingClientRect().height > 0).length);
    check(shown === ALL && !(await np.isVisible(".filters")), `without JS: all ${ALL} shown, filter buttons hidden`);
    await nojs.close();
  }

  // the now page's date line reads naturally (real separators) and carries a machine-readable date
  {
    const { ctx, page } = await newPage(390, "dark");
    await page.goto(BASE + "now/", { waitUntil: "load" });
    const got = (await page.innerText(".post-meta")).trim();
    check(got === "Last updated October 8, 2026 · Seattle, WA" && (await page.getAttribute(".post-meta time", "datetime")) === "2026-10-08", `now/ date line: "${got}"`);
    await ctx.close();
  }

  // 5. studio form + guestbook form on a phone
  for (const [pg, sel, name] of [["studio/", "#waitlist", "m-studio-form-390"], ["guestbook/", ".gb-window", "m-guestbook-form-390"]]) {
    for (const theme of ["light", "dark"]) {
      const { ctx, page } = await newPage(390, theme);
      await page.goto(BASE + pg, { waitUntil: "networkidle" });
      await page.locator(sel).screenshot({ path: path.join(OUT, `${name}-${theme}.png`) });
      await ctx.close();
    }
  }

  check(errors.length === 0, "no JS/console errors " + (errors.length ? JSON.stringify(errors.slice(0, 5)) : ""));
  console.log(fails ? fails + " failure(s)" : "all mobile checks pass");
  await browser.close();
  process.exitCode = fails ? 1 : 0;
})();
