// Exercises the fun layer with motion enabled: boot, terminal commands, Konami intrusion,
// typed "rain", and the reduced-motion fallbacks. Screenshots go to verify/fun-*.png.
//   node tools/test-fun.js [baseUrl]
const path = require("path");
const { launch } = require("./pw");
const BASE = process.argv[2] || "http://127.0.0.1:8787/";
const OUT = path.resolve(__dirname, "..", "verify");
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  // boot (forced with ?boot because automation skips it by default)
  await page.goto(BASE + "index.html?boot");
  await page.waitForTimeout(700);
  check(await page.isVisible(".boot"), "boot overlay shows");
  await page.screenshot({ path: path.join(OUT, "fun-boot.png") });
  await page.keyboard.press("Shift");
  await page.waitForTimeout(600);
  check(!(await page.$(".boot")), "any key skips boot");

  // boot never shows without ?boot under automation
  await page.goto(BASE + "index.html");
  await page.waitForTimeout(400);
  check(!(await page.$(".boot")), "boot skipped for automation / repeat visits");

  // terminal
  await page.keyboard.press("Backquote");
  check(await page.isVisible("dialog.term[open]"), "` opens terminal");
  for (const cmd of ["help", "whoami", "decode 6445C0C1", "ls", "sudo rm -rf /", "nope"]) {
    await page.fill("#term-in", cmd); await page.keyboard.press("Enter");
  }
  const termText = await page.textContent(".term-out");
  check(termText.includes("+35,000 ft") && termText.includes("Parity") || termText.includes("OK (odd)"), "decode prints altitude + parity");
  check(termText.includes("not in the sudoers file"), "sudo joke");
  check(termText.includes("command not found: nope"), "unknown command message");
  await page.screenshot({ path: path.join(OUT, "fun-terminal.png") });
  await page.fill("#term-in", "decode 6445C0C0"); await page.keyboard.press("Enter");
  check((await page.textContent("[data-parity]")).includes("error"), "decode loads word into the hero flipper");
  await page.keyboard.press("Escape");
  check(!(await page.isVisible("dialog.term[open]")), "Esc closes terminal");
  await page.click("[data-term]");
  check(await page.isVisible("dialog.term[open]"), "header >_ button opens terminal");
  await page.fill("#term-in", "exit"); await page.keyboard.press("Enter");

  // Konami -> intrusion
  for (const k of ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"]) await page.keyboard.press(k);
  await page.waitForTimeout(1900);
  check(await page.isVisible(".intrusion"), "Konami code triggers intrusion");
  check(await page.isVisible("canvas.rain.front"), "intrusion rain canvas running");
  await page.screenshot({ path: path.join(OUT, "fun-intrusion.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  check(!(await page.$(".intrusion")), "Esc dismisses intrusion");

  // typed "rain"
  await page.mouse.click(5, 300);
  await page.keyboard.type("rain");
  await page.waitForTimeout(1500);
  check(await page.isVisible("canvas.rain"), "typing 'rain' starts katakana rain");
  await page.screenshot({ path: path.join(OUT, "fun-rain.png") });

  // reduced motion: intrusion becomes a static toast, no canvas
  const rctx = await browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
  const rp = await rctx.newPage();
  rp.on("pageerror", (e) => errors.push(e.message));
  await rp.goto(BASE + "index.html?boot");
  await rp.waitForTimeout(300);
  check(!(await rp.$(".boot")), "reduced motion: no boot even when forced");
  await rp.keyboard.type("netrunner");
  await rp.waitForTimeout(300);
  check(await rp.isVisible(".toast") && !(await rp.$("canvas.rain")), "reduced motion: intrusion is a static toast");
  const anim = await rp.evaluate(() => getComputedStyle(document.querySelector(".hero h1 .dot")).animationName);
  check(anim === "none", "reduced motion: cursor blink off (" + anim + ")");
  await rp.screenshot({ path: path.join(OUT, "fun-reduced-390.png") });
  await rp.click("[data-term]");
  check(await rp.isVisible("dialog.term[open]"), "mobile: terminal opens from header button");
  await rp.fill("#term-in", "help"); await rp.keyboard.press("Enter");
  await rp.screenshot({ path: path.join(OUT, "fun-terminal-390.png") });

  // terminal: `now` goes to the now page
  await page.goto(BASE + "index.html");
  await page.keyboard.press("Backquote");
  await page.fill("#term-in", "now");
  await Promise.all([page.waitForURL(/\/now\/$/, { timeout: 5000 }).catch(() => {}), page.keyboard.press("Enter")]);
  check(/\/now\/$/.test(page.url()) && /Last updated October 3, 2026/.test(await page.textContent(".post-meta")), "terminal 'now' opens /now/ (last updated October 3, 2026)");

  // ambient cursor grid: one fixed layer on every page, follows the mouse, stays lit while scrolling
  for (const pg of ["index.html", "par.html"]) {
    await page.goto(BASE + pg);
    await page.mouse.move(400, 300); await page.mouse.move(640, 420, { steps: 4 });
    await page.waitForTimeout(600);
    const a1 = await page.evaluate(() => { const w = document.querySelectorAll(".ambient"), g = document.querySelector(".ambient-glow");
      return { n: w.length, on: w[0] && w[0].classList.contains("on"), op: w[0] && getComputedStyle(w[0]).opacity, pos: w[0] && getComputedStyle(w[0]).position, z: w[0] && getComputedStyle(w[0]).zIndex, t: g && g.style.transform, hero: getComputedStyle(document.querySelector(".hero") || document.body, "::after").content }; });
    check(a1.n === 1 && a1.on && a1.op === "1" && a1.pos === "fixed" && a1.z === "-1" && /translate3d\(340px, 120px/.test(a1.t), `${pg}: ambient grid lit under the cursor (${a1.t})`);
    await page.mouse.wheel(0, 2500); await page.waitForTimeout(500);
    const a2 = await page.evaluate(() => ({ on: document.querySelector(".ambient").classList.contains("on"), y: scrollY, bp: document.querySelector(".ambient-glow").style.backgroundPosition, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    check(a2.on && a2.y > 1000 && a2.over <= 0, `${pg}: still lit after scrolling to ${a2.y}px, grid re-aligned (${a2.bp}), no sideways overflow`);
  }
  await page.goto(BASE + "index.html");
  await page.screenshot({ path: path.join(OUT, "fun-ambient-start.png") });
  await page.mouse.move(900, 520); await page.waitForTimeout(500);
  await page.mouse.wheel(0, 1900); await page.waitForTimeout(500); await page.mouse.move(980, 470); await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "fun-ambient-scrolled.png") });

  // gameplay clips: swap in on screen, pause off screen
  await page.goto(BASE + "projects/");
  await page.locator("#mixtape .thumb").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("#mixtape .thumb").classList.contains("is-live"), null, { timeout: 8000 }).catch(() => {});
  const c1 = await page.evaluate(() => { const v = document.querySelector("#mixtape video.clip-video"); return v && { live: v.parentElement.classList.contains("is-live"), paused: v.paused, muted: v.muted, loop: v.loop, inline: v.playsInline, src: v.currentSrc.replace(/^.*\/assets/, "/assets"), h: document.querySelector("#mixtape .thumb").getBoundingClientRect().height, imgH: document.querySelector("#mixtape .thumb img").getBoundingClientRect().height }; });
  check(c1 && c1.live && !c1.paused && c1.muted && c1.loop && c1.inline && /\/assets\/clips\/mixtape\.(webm|mp4)\?v=/.test(c1.src), "projects: Mixtape clip plays muted+looped in view " + JSON.stringify(c1));
  await page.locator("#mixtape .thumb").screenshot({ path: path.join(OUT, "fun-clip-mixtape-card.png") });
  check(!(await page.$("#halfsies video")) && !(await page.$("#par video")), "no clip on non-game cards");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(500);
  check(await page.evaluate(() => document.querySelector("#mixtape video").paused), "clip pauses when its card scrolls away");
  // card pictures link to the card's primary action: same href/rel, one tab stop (the button), hover chip
  const m = await page.evaluate(() => [...document.querySelectorAll(".pcard")].map((c) => {
    const media = c.querySelector(".pcard-media"), btn = c.querySelector(".pcard-act a");
    return { id: c.id, media: !!media, same: !media || (btn && media.getAttribute("href") === btn.getAttribute("href") && (media.rel || "") === (btn.rel || "")),
      tab: media ? media.tabIndex : null, label: media ? media.getAttribute("aria-label") : null };
  }));
  // which cards get a picture link, from tools/projects.json: those with an action that has a target
  // (same rule as primary() in tools/build_projects.py)
  const withTarget = require("./projects.json").projects
    .filter((p) => (p.actions || []).some((a) => (a.href === "@url" ? p.url : a.href)))
    .map((p) => p.slug);
  const linked = m.filter((x) => x.media).map((x) => x.id);
  check(linked.join() === withTarget.join() && m.every((x) => x.same && (!x.media || (x.tab === -1 && x.label))), `projects: ${linked.length} card pictures link to their primary action (tabindex -1, labelled), matching tools/projects.json`);
  check(!m.find((x) => x.id === "retros").media && m.find((x) => x.id === "mixtape").label === "Play Mixtape Drift", "no link without a target; Mixtape's picture is 'Play Mixtape Drift'");
  await page.goto(BASE + "projects/");
  await page.locator("#mixtape .thumb").scrollIntoViewIfNeeded(); await page.hover("#mixtape .thumb"); await page.waitForTimeout(400);
  check(await page.evaluate(() => getComputedStyle(document.querySelector("#mixtape .media-go")).opacity === "1"), "hovering a card picture shows the '▶ Play' chip");
  await page.locator("#mixtape .thumb").screenshot({ path: path.join(OUT, "fun-media-hover.png") });
  await page.goto(BASE);
  const hm = await page.$$eval(".project .pcard-media", (as) => as.map((a) => [a.getAttribute("href"), a.tabIndex, a.getAttribute("aria-label")]));
  check(hm.length === 4 && hm.every((x) => x[1] === -1 && x[2]), "home: all four featured pictures are links (" + hm.map((x) => x[2]).join(", ") + ")");
  const rq = await rp.goto(BASE + "projects/"); await rp.locator("#mixtape .thumb").scrollIntoViewIfNeeded(); await rp.waitForTimeout(1200);
  check(!(await rp.$("video")) && !(await rp.$(".ambient.on")), "reduced motion: no clips load, no ambient grid");

  check(errors.length === 0, "no JS/console errors " + (errors.length ? JSON.stringify(errors) : ""));
  console.log(fails ? fails + " failure(s)" : "all fun checks pass");
  await browser.close();
  process.exitCode = fails ? 1 : 0;
})();
