// Renders a browser-extension page (new-tab page, popup, library) as a plain
// file:// page with the chrome.* APIs stubbed out. Read-only on the source.
// usage: node tools/render-newtab.js <html path> <out.png> [width] [height] [storageJSON] [waitMs]
const path = require("path");
const { launch } = require("./pw");

const [src, out, w = "1280", h = "800", storage = "{}", wait = "1500"] = process.argv.slice(2);

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log("pageerror:", e.message.split("\n")[0]));
  await page.addInitScript((seed) => {
    const store = JSON.parse(seed);
    const pick = (keys) => {
      if (keys == null) return { ...store };
      if (typeof keys === "string") keys = [keys];
      if (Array.isArray(keys)) { const o = {}; keys.forEach((k) => { if (k in store) o[k] = store[k]; }); return o; }
      const o = {}; for (const k in keys) o[k] = k in store ? store[k] : keys[k]; return o;
    };
    const area = {
      get: (keys, cb) => { const r = pick(keys); if (cb) { cb(r); return; } return Promise.resolve(r); },
      set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); },
      remove: (k, cb) => { [].concat(k).forEach((x) => delete store[x]); if (cb) cb(); return Promise.resolve(); },
      clear: (cb) => { if (cb) cb(); return Promise.resolve(); },
    };
    const ev = { addListener() {}, removeListener() {} };
    const cbOrPromise = (val) => (...a) => { const cb = a.find((x) => typeof x === "function"); if (cb) { cb(val); return; } return Promise.resolve(val); };
    window.chrome = {
      storage: { local: area, sync: area, onChanged: ev },
      runtime: { lastError: undefined, getURL: (p) => p, sendMessage: cbOrPromise({}), onMessage: ev, id: "demo", getManifest: () => ({ version: "1.0.0" }) },
      tabs: { query: cbOrPromise([]), create: cbOrPromise({}) },
      topSites: { get: cbOrPromise([]) },
      search: { query: () => {} },
      permissions: { contains: cbOrPromise(false), request: cbOrPromise(false) },
      scripting: { getRegisteredContentScripts: cbOrPromise([]), registerContentScripts: cbOrPromise(), unregisterContentScripts: cbOrPromise(), executeScript: cbOrPromise([]) },
      management: { getSelf: cbOrPromise({ installType: "normal" }) },
    };
  }, storage);
  await page.goto("file:///" + path.resolve(src).replace(/\\/g, "/"));
  await page.waitForTimeout(+wait);
  await page.screenshot({ path: out });
  console.log("->", out);
  await browser.close();
})();
