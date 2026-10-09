// Browser checks for /arcade/ (assets/js/arcade.js + arcade.css, cabinets from tools/build_projects.py).
// The games themselves are never contacted: every *.dillon-eu-green.workers.dev request is answered by a
// local stub page, so this only tests the site's side (click-to-load, sandbox attributes, one at a time,
// phones open a new tab, CSP). Run against `wrangler pages dev` so _headers (the real CSP) applies.
//   node tools/test-arcade.js [baseUrl]          screenshots: verify/arcade-*.png
const path = require("path");
const fs = require("fs");
const { launch } = require("./pw");

const BASE = (process.argv[2] || "http://127.0.0.1:8788/").replace(/\/$/, "");
const OUT = path.resolve(__dirname, "..", "verify");
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };

const GAMES = require("./projects.json").projects.filter((p) => p.arcade).sort((a, b) => a.arcade.order - b.arcade.order);
const SANDBOX = ["allow-scripts", "allow-same-origin", "allow-pointer-lock", "allow-popups"];
const GAME_HOST = /^https:\/\/[a-z0-9-]+\.dillon-eu-green\.workers\.dev\//;

(async () => {
  const browser = await launch();
  const errors = [];

  async function open(viewport, opts = {}) {
    const ctx = await browser.newContext({
      viewport, deviceScaleFactor: 1, isMobile: !!opts.touch, hasTouch: !!opts.touch,
      reducedMotion: opts.reduced ? "reduce" : "no-preference", javaScriptEnabled: opts.js !== false, colorScheme: "dark",
    });
    const game = { requests: [] };
    await ctx.route(GAME_HOST, (route) => {
      const req = route.request();
      game.requests.push({ url: req.url(), referer: req.headers()["referer"] || null, dest: req.headers()["sec-fetch-dest"] || "" });
      const name = new URL(req.url()).hostname.split(".")[0];
      route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>${name}</title><body><h1 id="stub">GAME ${name}</h1></body>` });
    });
    const page = await ctx.newPage();
    const tag = `${viewport.width}x${viewport.height}`;
    page.on("pageerror", (e) => errors.push(`${tag} JS ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${tag} console ${m.text()}`); });
    await page.goto(BASE + "/arcade/", { waitUntil: "networkidle" });
    return { ctx, page, game };
  }
  // Scroll the target to the middle first, then click. With a cross-origin game frame on the page, Playwright's
  // own scroll-into-view inside click() sometimes leaves the target under the frame in headless Edge.
  const press = async (page, sel) => { await page.$eval(sel, (e) => e.scrollIntoView({ block: "center" })); await page.click(sel); };
  const visible = (page, sel) => page.$$eval(sel, (els) => els.filter((e) => e.offsetParent !== null && getComputedStyle(e).visibility !== "hidden").length);
  const frames = (page) => page.$$eval("iframe", (fs) => fs.map((f) => ({ cab: f.closest("[data-cab]").id, src: f.getAttribute("src") })));

  /* ---------- desktop: click-to-load, attributes, one at a time ---------- */
  {
    // reduced motion here only so scrolling is instant (html has scroll-behavior: smooth): Playwright scrolls a
    // button into view and clicks, and a smooth scroll still in flight would move the target under it
    const { ctx, page, game } = await open({ width: 1440, height: 900 }, { reduced: true });
    const ids = await page.$$eval("[data-cab]", (cs) => cs.map((c) => c.id));
    check(ids.join() === GAMES.map((g) => g.slug).join(), `cabinets in arcade.order: ${ids.join(", ")}`);
    check(ids.join() === "butter,beepbeach,mixtape,airfield,fernwood", "butter, beepbeach, Mixtape Drift, Little Airfield, Fernwood");
    const embeds = await page.$$eval("[data-cab]", (cs) => cs.map((c) => c.getAttribute("data-embed")));
    check(embeds.every((u, i) => u === GAMES[i].url), "each cabinet embeds its projects.json URL");
    check((await frames(page)).length === 0 && game.requests.length === 0, "nothing from any game loads before Play (no frame, no request)");
    check(await visible(page, ".cab-play") === GAMES.length && await visible(page, "[data-stop]") === 0 && await visible(page, "[data-fullscreen]") === 0, "every cabinet shows Play here; Stop/Fullscreen hidden");
    const links = await page.$$eval(".cab-open", (as) => as.map((a) => ({ href: a.getAttribute("href"), target: a.target, rel: a.rel, text: a.innerText.trim() })));
    check(links.length === GAMES.length && links.every((l, i) => l.href === GAMES[i].url && l.target === "_blank" && /noopener/.test(l.rel) && /Open in new tab/.test(l.text)), "each has 'Open in new tab' (target=_blank, rel=noopener)");
    await page.screenshot({ path: path.join(OUT, "arcade-1440-dark.png") });

    // play butter
    const h0 = await page.$eval("#butter .cab-screen", (s) => s.getBoundingClientRect().height);
    await press(page, "#butter .cab-play");
    await page.waitForSelector("#butter iframe");
    const attrs = await page.$eval("#butter iframe", (f) => ({
      sandbox: [...f.sandbox], allow: f.getAttribute("allow"), ref: f.getAttribute("referrerpolicy"), loading: f.getAttribute("loading"), src: f.getAttribute("src"), title: f.title,
    }));
    check(attrs.sandbox.length === SANDBOX.length && SANDBOX.every((t) => attrs.sandbox.includes(t)), "sandbox = " + attrs.sandbox.join(" "));
    check(attrs.allow === "fullscreen; autoplay; gamepad" && attrs.ref === "no-referrer" && attrs.loading === "lazy", `allow="${attrs.allow}", referrerpolicy="${attrs.ref}", loading="${attrs.loading}"`);
    check(attrs.src === GAMES[0].url && /butter/.test(attrs.title), "frame src is the game URL, titled for screen readers");
    await page.waitForFunction(() => document.querySelector("#butter [data-stage]").classList.contains("is-loaded"), null, { timeout: 8000 });
    const fr = page.frames().find((f) => f.url().startsWith(GAMES[0].url.replace(/\/$/, "")));
    check(fr && /GAME butter/.test(await fr.textContent("#stub")), "the game page loads inside the frame (CSP frame-src allows it)");
    const req = game.requests.find((r) => r.url.startsWith("https://butter."));
    check(req && req.referer === null, "the game gets no Referer");
    check(await page.$eval("#butter", (c) => c.classList.contains("is-playing")) && await visible(page, "#butter [data-stop]") === 1 && await visible(page, "#butter .cab-play") === 0 && await visible(page, "#butter .cab-poster") === 0,
      "playing: Stop shown, Play here and the poster hidden");
    check(await visible(page, "#butter [data-fullscreen]") === 1, "Fullscreen control shown while playing");
    const h1 = await page.$eval("#butter .cab-screen", (s) => s.getBoundingClientRect());
    check(h1.width > 1000 && Math.abs(h1.width / h1.height - 16 / 9) < 0.02 && h1.height > h0, `playing cabinet grows to the full width at 16:9 (${Math.round(h1.width)}x${Math.round(h1.height)})`);
    check(/Playing butter/.test(await page.textContent("[data-arcade-live]")), "screen-reader status: 'Playing butter…'");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, "arcade-playing-1440-dark.png") });

    // another game: the first one is unloaded
    await press(page, "#beepbeach .cab-play");
    await page.waitForSelector("#beepbeach iframe");
    let f = await frames(page);
    check(f.length === 1 && f[0].cab === "beepbeach" && !(await page.$eval("#butter", (c) => c.classList.contains("is-playing"))) && await visible(page, "#butter .cab-play") === 1,
      "starting beepbeach unloads butter: one frame on the page, butter back to its poster");
    // the picture is a play button too (pointer)
    await press(page, "#mixtape .cab-poster");
    await page.waitForSelector("#mixtape iframe");
    f = await frames(page);
    check(f.length === 1 && f[0].cab === "mixtape", "clicking a cabinet's picture plays it (still one frame)");
    await press(page, "#mixtape [data-stop]");
    f = await frames(page);
    check(f.length === 0 && await page.evaluate(() => document.activeElement && document.activeElement.matches("#mixtape .cab-play")), "Stop removes the frame and returns focus to Play here");
    check(/Stopped Mixtape Drift/.test(await page.textContent("[data-arcade-live]")), "screen-reader status: 'Stopped Mixtape Drift.'");

    // keyboard
    await page.focus("#fernwood .cab-play");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#fernwood iframe");
    check((await frames(page)).length === 1, "keyboard: Enter on Play here starts the game");
    // fullscreen goes to the game frame (last: after leaving full screen, Playwright's own scroll-into-view in
    // click() can misplace the next click in headless Edge; a real click after Esc is fine)
    await press(page, "#fernwood [data-fullscreen]");
    await page.waitForTimeout(300);
    const fsEl = await page.evaluate(() => document.fullscreenElement && document.fullscreenElement.tagName);
    check(fsEl === "IFRAME", "Fullscreen puts the game frame full screen (" + fsEl + ")");
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
    await page.waitForTimeout(600);
    await ctx.close();
  }

  /* ---------- tablets embed; phones (portrait and landscape) open a new tab ---------- */
  {
    const { ctx, page } = await open({ width: 1024, height: 768 }, { touch: true });
    check(await visible(page, ".cab-play") === GAMES.length, "tablet 1024x768 (touch): Play here offered");
    await ctx.close();
  }
  for (const vp of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 640 }]) {
    const { ctx, page, game } = await open(vp, { touch: true });
    const tag = `${vp.width}x${vp.height} phone`;
    check(await visible(page, ".cab-play") === 0 && await visible(page, ".cab-insert") === 0, `${tag}: no Play here`);
    const open1 = await page.$eval("#butter .cab-open", (a) => ({ text: a.innerText.trim(), primary: getComputedStyle(a).backgroundColor, target: a.target }));
    check(/Play in a new tab/.test(open1.text) && open1.target === "_blank", `${tag}: the link reads 'Play in a new tab' and opens one`);
    check(await visible(page, ".arcade-phone-note") === 1, `${tag}: note explains games open in their own tab`);
    await page.tap("#butter .cab-poster");
    await page.waitForTimeout(300);
    check((await frames(page)).length === 0 && game.requests.length === 0, `${tag}: tapping the picture loads nothing`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${tag}: no sideways scroll`);
    if (vp.width === 390) await page.screenshot({ path: path.join(OUT, "arcade-390-dark.png"), fullPage: true });
    await ctx.close();
  }

  /* ---------- without JS: new-tab links only ---------- */
  {
    const { ctx, page } = await open({ width: 1440, height: 900 }, { js: false });
    check(await visible(page, ".cab-play") === 0 && await visible(page, ".cab-open") === GAMES.length && (await frames(page)).length === 0, "no JS: no Play here, every game still opens in a new tab");
    await ctx.close();
  }

  /* ---------- reduced motion: posters stay still ---------- */
  {
    const { ctx, page } = await open({ width: 1440, height: 900 }, { reduced: true });
    await page.waitForTimeout(800);
    check(await page.$$eval("video", (v) => v.length) === 0, "reduced motion: no gameplay clips start");
    await ctx.close();
  }

  /* ---------- the terminal knows the arcade ---------- */
  {
    const { ctx, page } = await open({ width: 1280, height: 800 });
    await page.keyboard.press("Backquote");
    await page.fill("#term-in", "arcade"); await page.keyboard.press("Enter");
    check((await page.textContent(".term-out")).includes("already on the arcade"), "terminal 'arcade' on /arcade/: already there");
    await page.goto(BASE + "/now/", { waitUntil: "domcontentloaded" });
    await page.keyboard.press("Backquote");
    await page.fill("#term-in", "help"); await page.keyboard.press("Enter");
    check((await page.textContent(".term-out")).includes("arcade"), "terminal help lists 'arcade'");
    await page.fill("#term-in", "arcade"); await page.keyboard.press("Enter");
    await page.waitForURL(/\/arcade\/$/, { timeout: 5000 }).catch(() => {});
    check(/\/arcade\/$/.test(page.url()), "terminal 'arcade' goes to /arcade/");
    await ctx.close();
  }

  await browser.close();
  check(errors.length === 0, "no JS errors, console errors or CSP violations" + (errors.length ? ":\n   " + errors.join("\n   ") : ""));
  console.log(fails ? `\n${fails} FAILED` : "\nall arcade tests passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
