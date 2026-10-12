// Records short, muted gameplay loops for the game cards: site/assets/clips/<slug>.mp4 + .webm.
//   node tools/capture_clips.js                 # every game
//   node tools/capture_clips.js mixtape butter  # just these
//   KEEP=1 node tools/capture_clips.js ...      # keep the raw frames in verify/clips-raw/<slug>/
//   node tools/capture_clips.js --reencode ...  # re-encode from those kept frames, no browser
//
// Each game is served read-only from its own folder (../<game>/dist) by a tiny static server on
// localhost; nothing is written into the game folders and every request that leaves localhost is
// refused. The games are driven the way their own tools/browser-check.js / shots.js drive them
// (keyboard, taps and the test hooks they expose), so the clips are real gameplay, not mock-ups.
//
// Capture: Chrome's screencast (CDP Page.startScreencast) streams JPEG frames with timestamps while
// the game runs in real time; frames are resampled to a fixed rate, and ffmpeg makes the loop
// seamless-ish (the last CROSS seconds fade into the first) and encodes H.264 (.mp4, for Safari) and
// VP9 (.webm). If a file comes out over BUDGET it is re-encoded at a higher CRF until it fits.
// ffmpeg: $FFMPEG, then ffmpeg on PATH, then the binary bundled with Python's imageio-ffmpeg.
//
// The cards keep their still screenshot as the poster; assets/js/clips.js swaps the video in only
// while a card is on screen (and never under reduced motion or Save-Data).
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const { launch } = require("./pw");

const EXTE = path.resolve(__dirname, "..", "..");
const OUT = path.resolve(__dirname, "..", "site", "assets", "clips");
const RAW = path.resolve(__dirname, "..", "verify", "clips-raw");
const FPS = 24;          // output frame rate
const SECONDS = 7;       // loop length
const CROSS = 0.6;       // seconds of crossfade from the end back into the start
const BUDGET = 700 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ games
   root: folder served at /. view: CSS viewport. crop: [x, y, w, h] in device pixels of the captured
   frame (optional). size: output [w, h]. warm: async (page) => runs before recording.
   drive: async (page, t0) => runs while recording (scripted input). context: browser-context overrides (optional). */
const GAMES = {
  mixtape: {
    root: "mixtape/dist", view: [960, 540], dpr: 1, size: [640, 360],
    args: ["--autoplay-policy=no-user-gesture-required"],
    async warm(page) {
      await page.evaluate(() => { window.__mx.save.seen.tutorial = true; });
      await page.click('[data-go="cruise"]');
      await page.waitForFunction(() => window.__mx.st.beat > 0.5, null, { timeout: 10000 });
      await page.evaluate(() => { const st = window.__mx.st; st.groove = 99; st.playerX = 0; st.meter = 100; });
      await sleep(1800);
    },
    async drive(page) {
      const mx = (fn, arg) => page.evaluate(fn, arg);
      const onBeat = () => page.waitForFunction(() => { const b = window.__mx.st.beat; return b - Math.floor(b) > 0.95; }, null, { timeout: 3000 }).catch(() => {});
      // a row of notes to collect, a boost on the beat, a drift through a bend, a lane change
      await mx(() => { const st = window.__mx.st, pz = st.position + 840; for (let k = 0; k < 5; k++) st.pickups.push({ kind: "note", z: (pz + 900 + k * 260) % st.track.length, x: -0.45, i: k }); });
      await page.keyboard.down("ArrowLeft"); await sleep(420); await page.keyboard.up("ArrowLeft");
      await sleep(700);
      await mx(() => { window.__mx.st.meter = 100; });
      await onBeat(); await page.keyboard.press("ArrowUp");
      await sleep(1300);
      await page.keyboard.down("ArrowRight"); await sleep(380);
      await page.keyboard.down("Space"); await sleep(1500);
      await onBeat(); await page.keyboard.up("Space"); await page.keyboard.up("ArrowRight");
      await sleep(600);
      await page.keyboard.down("ArrowLeft"); await sleep(300); await page.keyboard.up("ArrowLeft");
      await mx(() => { window.__mx.st.meter = 100; });
      await onBeat(); await page.keyboard.press("ArrowUp");
    },
  },

  airfield: {
    root: "airfield/dist", view: [960, 540], dpr: 1, size: [640, 360], query: "?hour=11",
    init: () => { const RealDate = Date; const d = new RealDate(); d.setHours(11, 0, 0, 0); window.__dayOffset = d.getTime() - RealDate.now(); },
    async warm(page) {
      await sleep(1200);
      await page.evaluate(() => {
        const s = window.__af.state, now = Date.now(), AF = window.AF;
        s.debris = []; s.daily.ready = false; s.coins = 2500; s.rep = 300; s.level = 3; s.runway.paved = true;
        [["diner", 3, 3], ["tree", 14, 3], ["tree", 15, 2], ["flowers", 12, 6], ["flowers", 13, 6], ["hangar", 17, 14], ["beacon", 21, 5], ["bench", 13, 3], ["tiedown", 19, 13], ["fuel", 8, 12]]
          .forEach(([t, x, y]) => { try { AF.place(s, t, x, y, now, true); } catch (e) {} });
        for (let i = 0; i < 3; i++) AF.spawnPlane(s, now, ["tourer", "twin", "biplane"][i]);
        s.buildings.forEach((b) => { b.buildEnds = null; });
      });
      await sleep(600);
      await page.click("#pattern [data-land]").catch(() => {});
      await sleep(2600);
    },
    async drive(page) {
      await sleep(2200);
      await page.click("#pattern [data-land]").catch(() => {});
      await sleep(2500);
    },
  },

  butter: { // the pixel-art rework (Oct 2026) plays in landscape too: St. Maarten's beach approach, autopilot to touchdown
    root: "butter/dist", view: [960, 540], dpr: 1, size: [640, 360],
    init: () => {
      window.__BUTTER_TEST__ = (api) => { window.__T = api; };
      try { // as butter/tools/probe-scene.js: past the tutorial, every career airport open
        localStorage.clear(); localStorage.setItem("butter_stats", JSON.stringify({ flights: 9, landings: 3 }));
        localStorage.setItem("butter_career", JSON.stringify(Object.fromEntries(["sea", "sfo", "lhr", "jfk", "san", "lga", "lcy", "eyw", "sxm", "jnu", "fnc", "gib", "ase", "zqn", "hkg", "pbh", "sbh", "cvf", "sab", "lua"].map((k) => [k, 3]))));
      } catch (e) {}
    },
    async warm(page) {
      await page.waitForFunction(() => !!window.__T && !!window.ButterCareer); await sleep(600);
      await page.evaluate(() => {
        const S = window.ButterSim, C = window.ButterCareer, T = window.__T;
        T.careerFlight(Math.max(0, C.LEVELS.findIndex((l) => l.id === "sxm")));
        T.setPilot((f) => { // the autopilot from butter/tools/shots.js: 3-degree glide, flare, crab into the wind
          const st = f.st, flareH = Math.max(3, f.ac.span * 0.22);
          const vsT = st.h > flareH ? -st.V * Math.sin(3 * S.DEG) + 0.25 * ((-st.s * Math.tan(3 * S.DEG)) - st.h) : -(0.09 * st.h + 0.2);
          const pitch = Math.max(-1, Math.min(1, 0.55 * (vsT - st.vs) - 6 * st.q));
          const psiT = Math.asin(Math.max(-0.4, Math.min(0.4, (f.comp.cross * S.KT) / st.V))) - Math.max(-0.12, Math.min(0.12, st.x * 0.012 + (st.V * Math.sin(st.psi) - f.comp.cross * S.KT) * 0.04));
          return { pitch, roll: Math.max(-1, Math.min(1, (psiT - st.psi) * 8)) };
        });
        T.start();
        const f = T.state().flight; f.st.s = Math.max(f.st.s, -1500); f.st.h = -f.st.s * Math.tan(f.glide) + 4;
        document.querySelectorAll(".overlay").forEach((o) => { o.hidden = true; });
      });
      await page.waitForFunction(() => window.__T.state().flight.st.h < 26, null, { timeout: 120000 }); // ~85 ft (sim units are metres): flare, touchdown, rollout
    },
    async drive() {},
  },

  beepbeach: {
    root: "beepbeach/dist", view: [390, 844], dpr: 2, crop: [0, 300, 390, 244], size: [512, 320],
    api: { "/api/found": '{"n":214}' },
    init: () => { window.__BEEP_TEST__ = (api) => { window.__T = api; }; try { localStorage.clear(); } catch (e) {} },
    async warm(page) {
      await page.waitForFunction(() => !!window.__T); await sleep(800);
      await page.evaluate(() => { const T = window.__T, s = T.s; T.settings.tutorial = 9; s.levels.detector = 3; s.levels.shovel = 3; s.crew = { kid: 1, dog: 1 }; T.newField(); });
      await sleep(1200);
      // a target in the middle of the band the clip shows; the mouse sweeps the coil (pointerType mouse aims without a press)
      const tg = await page.evaluate(() => {
        const T = window.__T, f = T.field().filter((x) => !x.dug && !x.kind && x.depth <= 1.5);
        const pick = f.map((x) => ({ x, p: T.toScr(x.x, x.y) })).filter((o) => o.p[1] > 380 && o.p[1] < 470 && o.p[0] > 120 && o.p[0] < 300)[0] || { x: f[0], p: T.toScr(f[0].x, f[0].y) };
        return pick.p;
      });
      this.tg = tg;
      await page.mouse.move(30, tg[1] - 30); await sleep(500);
    },
    async drive(page) {
      const [tx, ty] = this.tg;
      for (let k = 0; k <= 30; k++) { // sweep left to right in a lazy S that settles on the target
        const f = k / 30, x = 30 + (tx - 30) * f + 40 * Math.sin(f * Math.PI) * (1 - f), y = ty - 30 * (1 - f) + 22 * Math.sin(f * 7) * (1 - f);
        await page.mouse.move(x, y); await sleep(70);
      }
      await page.mouse.move(tx, ty); await sleep(500);
      await page.click("#digBtn", { force: true }); await sleep(250);
      for (let k = 0; k < 40; k++) {
        if (await page.evaluate(() => !window.__T.pit() || window.__T.pit().done)) break;
        await page.mouse.click(195, 500); await sleep(80);
      }
      await sleep(2000);
    },
  },

  fernwood: { // cozy side-scroller: title -> skip intro cards/dialog -> a sunny morning walk with a couple of hops
    root: "fernwood/dist", view: [960, 540], dpr: 1, size: [640, 360], crop: [0, 0, 864, 486], // drop most of the dark underground + touch buttons
    init: () => { try { localStorage.clear(); } catch (e) {} },
    async warm(page) {
      await page.waitForSelector("#tPlay", { timeout: 15000 }); await sleep(600);
      await page.click("#tPlay"); await sleep(900);
      for (let i = 0; i < 30; i++) { // intro cards + first dialogue
        const busy = await page.evaluate(() => { const d = document.getElementById("dialog"); return (d && !d.hidden) || !!document.querySelector(".cards:not([hidden]), #cards:not([hidden])"); }).catch(() => false);
        if (!busy && i > 3) break;
        await page.keyboard.press("Enter"); await sleep(140);
      }
      await page.evaluate(() => { // a sunny mid-morning on the meadow (same placement approach as fernwood/tools/look.js)
        const G = window.FW.G, Gm = window.FW.Game; G.state.time = 10 * 60;
        if (G.area.id !== "over") Gm.enterArea("over", Gm.areaFor("over").spawn);
        const a = G.area, tx = 820; let y = 0;
        while (y < a.H && !(a.solid(tx, y) || a.oneway(tx, y))) y++;
        Gm.enterArea("over", { x: tx * 16 + 8, y: y * 16 });
      });
      await sleep(1400);
    },
    async drive(page) {
      await page.keyboard.down("ArrowRight"); await sleep(900);
      await page.keyboard.press("Space"); await sleep(1100);
      await page.keyboard.press("Space"); await sleep(1300);
      await page.keyboard.up("ArrowRight"); await sleep(500);
      await page.keyboard.down("ArrowLeft"); await sleep(700);
      await page.keyboard.press("Space"); await sleep(900);
      await page.keyboard.up("ArrowLeft"); await sleep(700);
    },
  },

  dragonrealm: {
    root: "jaderealm/dist", view: [960, 540], dpr: 1, size: [640, 360],
    init: () => { window.__JADE_TEST__ = (api) => { window.__T = api; }; try { if (!sessionStorage.getItem("k")) { sessionStorage.setItem("k", 1); localStorage.clear(); } } catch (e) {} },
    async warm(page) {
      await sleep(600);
      await page.click('[data-c="warrior"]'); await page.fill("#nameIn", "Netrunner"); await page.click("#createGo");
      await page.waitForFunction(() => !!window.__T);
      await page.waitForFunction(() => document.getElementById("loading").hidden, null, { timeout: 60000 });
      await sleep(500);
      await page.click("#tut [data-skip]").catch(() => {});
      await page.evaluate(() => { window.__T.settings.auto = true; });
      await sleep(16000); // walk out of the city and start hunting
    },
    async drive() {},
  },

  // Linework (the CAD viewer, not a game): wire tracing across a sheet set. Served from ../linework/dist, which is
  // git-ignored there; build it first with `node tools/make_dist.mjs` in ../linework. The drawings are invented in
  // the page by sheets() below with Linework's own DXF writer (samples/gen/dxf-writer.js) - no real drawing is read.
  // Headless screencasts have no mouse pointer, so init draws one where the real mouse events land.
  linework: {
    root: "linework/dist", view: [960, 540], dpr: 1, size: [640, 360], query: "?nosw", context: { isMobile: false, hasTouch: false },
    init: () => addEventListener("DOMContentLoaded", () => {
      const c = document.body.appendChild(document.createElement("div"));
      c.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-99px,0)";
      c.innerHTML = '<svg width="22" height="24"><path d="M3 2v17l4.3-4 3 6.4 3-1.4-3-6.2h6z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      addEventListener("pointermove", (e) => { c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`; }, true);
      addEventListener("pointerdown", (e) => { // a ring on each click
        const r = document.body.appendChild(document.createElement("div"));
        r.style.cssText = `position:fixed;left:${e.clientX - 13}px;top:${e.clientY - 13}px;width:26px;height:26px;border:2px solid rgba(255,255,255,.85);border-radius:50%;z-index:2147483646;pointer-events:none;transition:transform .5s,opacity .5s`;
        requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = "scale(1.7)"; r.style.opacity = "0"; }));
        setTimeout(() => r.remove(), 700);
      }, true);
    }),
    sheets: async () => { // runs in the page: three invented control-panel sheets (connector, terminal strips, relays, off-page links)
      const { DxfWriter } = await import("/samples/gen/dxf-writer.js");
      const Z = { layer: "0" }, ref = (b, at) => b.attdef("REF", "Ref", "-", at, { h: 6 }, Z), att = (tag, value, at, h) => ({ tag, value, at, h });
      const two = (b, pins, draw) => { b.line([0, 12], [0, 18], Z); b.line([0, 0], [0, -6], Z); b.text(pins[0], [1.6, 14], { h: 3.4 }, Z); b.text(pins[1], [1.6, -4.9], { h: 3.4 }, Z); ref(b, [9, 3.5]); draw(); };
      const sheet = (k, title, draw) => {
        const w = new DxfWriter({ version: "AC1015", insunits: 4 }), pl = (b, pts) => b.lwpolyline(pts, true, Z), D = { layer: "DEVICES" };
        w.layer("BORDER", 8).layer("WIRES", 3).layer("LABELS", 2).layer("DEVICES", 7);
        w.block("CONN", [0, 0], (b) => { pl(b, [[0, 0], [16, 0], [16, 44], [0, 44]]); [37, 27, 17, 7].forEach((y, i) => { b.line([16, y], [20, y], Z); b.text(String(i + 1), [9.5, y - 1.7], { h: 3.4 }, Z); }); ref(b, [0, 47]); });
        w.block("TERM", [0, 0], (b) => { pl(b, [[0, 0], [52, 0], [52, 10], [0, 10]]); [8, 20, 32, 44].forEach((x, i) => { b.circle([x, 10], 1.2, Z); b.text(String(i + 1), [x - 1, 2.5], { h: 3.8 }, Z); }); ref(b, [-15, 2]); });
        w.block("COIL", [0, 0], (b) => two(b, ["A1", "A2"], () => pl(b, [[-6, 0], [6, 0], [6, 12], [-6, 12]])));
        w.block("LAMP", [0, 0], (b) => two(b, ["X1", "X2"], () => { b.circle([0, 6], 6, Z); b.line([-4.2, 1.8], [4.2, 10.2], Z); b.line([-4.2, 10.2], [4.2, 1.8], Z); }));
        w.block("MOTOR", [0, 0], (b) => two(b, ["1", "2"], () => { b.circle([0, 6], 6, Z); b.text("M", [-2.2, 3.7], { h: 4.8 }, Z); }));
        w.block("GND", [0, 0], (b) => { b.line([0, 0], [0, -3], Z); b.line([-5, -3], [5, -3], Z); b.line([-3.2, -4.6], [3.2, -4.6], Z); b.line([-1.4, -6.2], [1.4, -6.2], Z); });
        w.block("OFFPAGE", [0, 0], (b) => { pl(b, [[0, -5], [27, -5], [33, 0], [27, 5], [0, 5]]); b.attdef("TO", "Sheet", "SHEET", [3, -1.9], { h: 3.8 }, Z); });
        w.block("TBLOCK", [0, 0], (b) => { pl(b, [[0, 0], [76, 0], [76, 22], [0, 22]]); b.line([0, 9], [76, 9], Z); b.attdef("TITLE", "Title", "-", [3, 12.5], { h: 5 }, Z); b.attdef("SHEET", "Sheet", "-", [3, 3.2], { h: 3.2 }, Z); b.attdef("DWGNO", "Drawing", "-", [48, 3.2], { h: 3.2 }, Z); });
        w.lwpolyline([[0, 0], [268, 0], [268, 140], [0, 140]], true, { layer: "BORDER" });
        w.insert("TBLOCK", [190, 2], { attribs: [att("TITLE", title, [193, 14.5], 5), att("SHEET", `SHEET ${k} OF 3`, [193, 5.2], 3.2), att("DWGNO", `CTRL-0${k}`, [238, 5.2], 3.2)] }, D);
        draw({
          wire: (...pts) => w.lwpolyline(pts, false, { layer: "WIRES" }),
          dot: (x, y) => w.hatch([[[x - 1.4, y, 1], [x + 1.4, y, 1]]], { solid: true }, { layer: "WIRES" }),
          lab: (s, x, y, h = 4.5) => w.text(s, [x, y], { h }, { layer: "LABELS" }),
          dev: (name, x, y, r) => w.insert(name, [x, y], { attribs: r ? [att("REF", r, name === "CONN" ? [x, y + 47] : name === "TERM" ? [x - 15, y + 2] : [x + 9, y + 3.5], 6)] : [] }, D),
          off: (x, y, to) => w.insert("OFFPAGE", [x, y], { attribs: [att("TO", to, [x + 3, y - 1.9], 3.8)] }, D),
        });
        return { name: `CTRL-0${k}.dxf`, text: w.toString() };
      };
      return [
        sheet(1, "POWER DISTRIBUTION", ({ wire, dot, lab, dev, off }) => {
          dev("CONN", 12, 63, "J1");
          wire([32, 100], [228, 100]); off(228, 100, "SHEET 2"); lab("PWR 28V", 38, 101.2); lab("W101", 205, 101.2); // the net the clip traces
          for (const [x, y] of [[82, 66], [146, 70], [196, 70]]) { dot(x, 100); wire([x, 100], [x, y]); }
          dev("TERM", 74, 56, "TB2"); dev("COIL", 146, 52, "K1"); dev("LAMP", 196, 52, "DS1");
          wire([32, 90], [118, 90], [118, 66]); lab("SIG A", 91, 91.2); lab("W103", 40, 91.2);
          wire([32, 80], [56, 80], [56, 74]); dev("GND", 56, 74); lab("CHASSIS", 35, 81.2, 3.4);
          wire([32, 70], [38, 70], [38, 36], [228, 36]); off(228, 36, "SHEET 2"); lab("RTN", 44, 37.2); lab("W102", 205, 37.2);
          for (const x of [146, 196]) { dot(x, 36); wire([x, 46], [x, 36]); }
        }),
        sheet(2, "MOTOR CONTROL", ({ wire, dot, lab, dev, off }) => {
          off(10, 100, "SHEET 1"); wire([43, 100], [196, 100], [196, 50]); lab("PWR 28V", 49, 101.2); lab("W101", 156, 101.2);
          for (const x of [96, 146]) { dot(x, 100); wire([x, 100], [x, 70]); }
          dev("MOTOR", 96, 52, "M1"); dev("COIL", 146, 52, "K2"); dev("TERM", 188, 40, "TB3"); lab("FAN 1", 105, 49.6, 3.4);
          off(10, 36, "SHEET 1"); wire([43, 36], [146, 36], [146, 46]); dot(96, 36); wire([96, 46], [96, 36]); lab("RTN", 49, 37.2); lab("W102", 106, 37.2);
          wire([220, 50], [220, 80], [228, 80]); off(228, 80, "SHEET 3"); lab("W110", 207.5, 81.2);
        }),
        sheet(3, "INDICATORS", ({ wire, lab, dev, off }) => {
          off(10, 80, "SHEET 2"); wire([43, 80], [120, 80], [120, 70]); lab("W110", 49, 81.2);
          dev("LAMP", 120, 52, "DS3"); wire([120, 46], [120, 36], [160, 36], [160, 30]); dev("GND", 160, 30); lab("FAN ON", 129, 49.6, 3.4);
        }),
      ];
    },
    async warm(page) {
      await page.waitForFunction(() => !!window.__linework && !!window.__linework.files);
      const files = await page.evaluate(this.sheets);
      await page.evaluate(async (files) => { // as Linework's e2e does: a folder in this origin's private storage stands in for the one Open folder asks for
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("control-panel", { create: true });
        for (const f of files) { const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable(); await w.write(f.text); await w.close(); }
        window.showDirectoryPicker = async () => dir;
      }, files);
      const sheet = (n) => page.waitForFunction((n) => { const a = window.__linework; return a.doc && a.doc.name === n && !a.loading && a.edit.ready; }, n, { timeout: 30000 });
      await page.click('.topbar [data-action="open-folder"]');
      await sheet("CTRL-01.dxf");
      await page.waitForFunction(() => { const s = window.__linework.sheets.status(); return s.indexed === 3 && !s.indexing; }, null, { timeout: 60000 });
      // the sheet list closed; each sheet framed left of where the trace panel opens (the set keeps every sheet's view)
      const frame = () => page.evaluate(() => window.__linework.zoomToWorld(-3.6, -5.45, 423.6, 145.45));
      await page.click("#sheets-hide");
      await page.keyboard.press("PageDown"); await sheet("CTRL-02.dxf"); await frame();
      await page.keyboard.press("PageUp"); await sheet("CTRL-01.dxf"); await frame();
      await page.keyboard.press("j"); // View > Trace
      await page.waitForFunction(() => window.__linework.trace && window.__linework.trace.graph);
      // screen points: rest, the PWR 28V wire, its "SHEET 2" off-page link, the same wire on sheet 2 (same frame)
      this.px = await page.evaluate((pts) => pts.map(([x, y]) => { const [sx, sy] = window.__linework.worldToScreen(x, y), r = document.querySelector("#cv-overlay").getBoundingClientRect(); return [r.left + sx, r.top + sy]; }), [[68, 118], [68, 100], [244, 100], [76, 100]]);
      await page.evaluate(() => { document.querySelector("#toasts").innerHTML = ""; document.activeElement.blur(); });
      await page.mouse.move(...this.px[0]); await sleep(800);
    },
    async drive(page) {
      const P = this.px;
      let at = P[0];
      const glide = async (to, ms) => { // eased, in real time
        const from = at, t0 = Date.now();
        for (let f = 0; f < 1;) { f = Math.min(1, (Date.now() - t0) / ms); const e = (1 - Math.cos(Math.PI * f)) / 2; await page.mouse.move(from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e); await sleep(16); }
        at = to;
      };
      await sleep(900);
      await glide(P[1], 600); await sleep(80); await page.mouse.click(...at); // a wire: its whole net lights up, the rest dims
      await sleep(850);
      await page.keyboard.press("h"); await glide(P[2], 900); await sleep(250); // Pan; the net's "SHEET 2" reference is a link
      await page.mouse.click(...at); await sleep(250); // -> sheet 2
      await page.keyboard.press("j"); await glide(P[3], 700); await sleep(80); await page.mouse.click(...at); // the same net, on sheet 2
      await sleep(900); await glide(P[0], 700);
    },
  },

  // Little Airfield on Roblox can't run in a browser: its frames are recorded in Roblox Studio by
  // ../airfield-rbx/tools/art/capture_clip.py (a chase-cam landing, see clip.server.luau there) straight into
  // verify/clips-raw/airfield-roblox, then encoded here with --reencode.
  "airfield-roblox": { studio: true, size: [640, 360] },
};

/* ------------------------------------------------------------------ helpers */
function findFfmpeg() {
  const tries = [process.env.FFMPEG, "ffmpeg"].filter(Boolean);
  for (const t of tries) { try { execFileSync(t, ["-version"], { stdio: "ignore" }); return t; } catch (e) {} }
  for (const py of ["python", "python3", "py"]) {
    try { const p = execFileSync(py, ["-c", "import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())"], { encoding: "utf8" }).trim(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  }
  throw new Error("ffmpeg not found: set FFMPEG, put ffmpeg on PATH, or pip install imageio-ffmpeg");
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".glb": "model/gltf-binary", ".bin": "application/octet-stream" };
function serve(root, api = {}) {
  const server = http.createServer((q, s) => {
    let p = decodeURIComponent(q.url.split("?")[0]);
    if (api[p]) { s.writeHead(200, { "content-type": "application/json" }); return s.end(api[p]); }
    if (p.startsWith("/api/")) { s.writeHead(404); return s.end(); }
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); }
    s.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(s); // read-only
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function encode(ff, frameDir, n, g, slug) {
  const L = n / FPS;                          // seconds of raw frames
  const crossN = Math.round(CROSS * FPS);
  const outLen = L - CROSS;
  const [W, H] = g.size;
  const crop = g.crop ? `crop=${g.crop[2]}:${g.crop[3]}:${g.crop[0]}:${g.crop[1]},` : "";
  // body = frames from CROSS to the end; head = the first CROSS seconds. The body's last CROSS seconds
  // fade into the head, so the final frame flows into frame 0 of the output (= raw frame CROSS).
  const vf = `[0:v]${crop}scale=${W}:${H}:flags=lanczos:in_range=pc:out_range=tv:out_color_matrix=bt709,setsar=1,split[a][b];` +
    `[a]trim=start_frame=${crossN},setpts=PTS-STARTPTS,fps=${FPS}[body];[b]trim=end_frame=${crossN},setpts=PTS-STARTPTS,fps=${FPS}[head];` +
    `[body][head]xfade=transition=fade:duration=${CROSS}:offset=${(outLen - CROSS).toFixed(3)},format=yuv420p[v]`;
  // limited-range BT.709, tagged, so Safari, Chrome and Firefox all decode the same colours
  const input = ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(frameDir, "f_%04d.jpg"), "-filter_complex", vf, "-map", "[v]", "-an", "-r", String(FPS),
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
  const out = {};
  const run = (ext, codec, crf0, step) => {
    const file = path.join(OUT, `${slug}.${ext}`);
    for (let crf = crf0; crf < crf0 + step * 6; crf += step) {
      execFileSync(ff, [...input, ...codec(crf), file]);
      const size = fs.statSync(file).size;
      if (size <= BUDGET) { out[ext] = { size, crf }; return; }
    }
    out[ext] = { size: fs.statSync(file).size, crf: "max", over: true };
  };
  run("mp4", (crf) => ["-c:v", "libx264", "-preset", "veryslow", "-crf", String(crf), "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart"], 27, 2);
  run("webm", (crf) => ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf), "-row-mt", "1", "-deadline", "good", "-cpu-used", "1", "-pix_fmt", "yuv420p"], 38, 3);
  return out;
}

async function capture(browser, slug, g, ff) {
  const root = path.join(EXTE, g.root);
  if (!fs.existsSync(path.join(root, "index.html"))) throw new Error(`${slug}: ${root}/index.html not found`);
  const server = await serve(root, g.api);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const ctx = await browser.newContext({
    viewport: { width: g.view[0], height: g.view[1] }, deviceScaleFactor: g.dpr, isMobile: true, hasTouch: true, reducedMotion: "no-preference", ...g.context,
  });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/i, (route) => route.abort()); // offline: nothing leaves localhost
  if (g.init) await ctx.addInitScript(g.init);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + (g.query || ""), { waitUntil: "load" });
  await g.warm(page);

  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  let recording = true;
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    if (recording) frames.push({ t: metadata.timestamp, data });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: g.view[0] * g.dpr, maxHeight: g.view[1] * g.dpr, everyNthFrame: 1 });
  const total = SECONDS + CROSS;
  const driving = g.drive(page).catch((e) => errors.push("drive: " + e.message));
  await sleep(total * 1000 + 600);
  recording = false;
  await driving;
  await cdp.send("Page.stopScreencast").catch(() => {});
  await ctx.close(); server.close();
  if (frames.length < 10) throw new Error(`${slug}: only ${frames.length} frames captured`);

  // resample to a fixed rate: for each output tick, the newest frame at or before it
  frames.sort((a, b) => a.t - b.t);
  const t0 = frames[0].t + 0.25, n = Math.round(total * FPS);
  const dir = process.env.KEEP ? path.join(RAW, slug) : fs.mkdtempSync(path.join(os.tmpdir(), `dg-clip-${slug}-`));
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  let j = 0;
  for (let k = 0; k < n; k++) {
    const want = t0 + k / FPS;
    while (j + 1 < frames.length && frames[j + 1].t <= want) j++;
    fs.writeFileSync(path.join(dir, `f_${String(k + 1).padStart(4, "0")}.jpg`), Buffer.from(frames[j].data, "base64"));
  }
  const srcFps = (frames.length / (frames[frames.length - 1].t - frames[0].t)).toFixed(1);
  const out = encode(ff, dir, n, g, slug);
  if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true });
  return { srcFps, frames: frames.length, out, errors };
}

(async () => {
  const want = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const slugs = want.length ? want : Object.keys(GAMES);
  const ff = findFfmpeg();
  fs.mkdirSync(OUT, { recursive: true });
  let bad = 0;
  for (const slug of slugs) {
    const g = GAMES[slug];
    if (!g) { console.log(`!! unknown game ${slug} (have: ${Object.keys(GAMES).join(", ")})`); bad++; continue; }
    if (g.studio && !process.argv.includes("--reencode")) { console.log(`-- ${slug}: recorded in Roblox Studio (../airfield-rbx/tools/art/capture_clip.py), then --reencode`); continue; }
    if (process.argv.includes("--reencode")) {
      const dir = path.join(RAW, slug), n = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^f_\d+\.jpg$/.test(f)).length : 0;
      if (!n) { console.log(`!! ${slug}: no kept frames in ${dir} (capture with KEEP=1 first)`); bad++; continue; }
      const out = encode(ff, dir, n, g, slug);
      console.log(`re ${slug.padEnd(12)} mp4 ${Math.round(out.mp4.size / 1024)} KB (crf ${out.mp4.crf})  webm ${Math.round(out.webm.size / 1024)} KB (crf ${out.webm.crf})`);
      continue;
    }
    const browser = await launch(g.args || []);
    try {
      let timer;
      const r = await Promise.race([capture(browser, slug, g, ff), new Promise((_, no) => { timer = setTimeout(() => no(new Error("timed out after 4 min")), 240000); })]);
      clearTimeout(timer);
      const kb = (b) => Math.round(b / 1024) + " KB";
      const over = Object.values(r.out).some((o) => o.over);
      if (over) bad++;
      console.log(`${over ? "!!" : "ok"} ${slug.padEnd(12)} ${g.size.join("x")} ${FPS}fps ${SECONDS}s loop (screencast ${r.srcFps} fps, ${r.frames} frames)  mp4 ${kb(r.out.mp4.size)} (crf ${r.out.mp4.crf})  webm ${kb(r.out.webm.size)} (crf ${r.out.webm.crf})` +
        (r.errors.length ? `\n   page errors: ${r.errors.slice(0, 3).join(" | ")}` : ""));
    } catch (e) {
      bad++; console.log(`!! ${slug}: ${e.message}`);
    }
    await browser.close().catch(() => {});
  }
  process.exitCode = bad ? 1 : 0;
  process.exit(); // a game left with a timer or socket open must not keep the run alive
})();
