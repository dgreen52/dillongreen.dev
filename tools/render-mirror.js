// Renders demo screenshots of the Smart Mirror UI (../../Mirror/static, read-only).
// Privacy: the real config.json / notes.json are never read. Every /api/* call is
// answered here with an invented demo config and fake weather/news/calendar/notes,
// and the static files are served straight from disk through request routing,
// so no server runs and nothing is copied.
//   node tools/render-mirror.js
const fs = require("fs");
const path = require("path");
const { launch } = require("./pw");

const STATIC = path.resolve(__dirname, "..", "..", "Mirror", "static");
const OUT = path.resolve(__dirname, "..", "verify");
const ORIGIN = "http://mirror.demo";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const day = (n) => new Date(now + n * 864e5).toISOString().slice(0, 10);

const DEMO = {
  config: {
    names: ["Dillon"], theme: "cyberpunk", units: "fahrenheit", clock_24h: false, language: "en",
    location: { city: "Seattle", latitude: 47.6062, longitude: -122.3321 },
    news_feeds: [], news_items: 4, calendar_ics_url: "", calendar_days_ahead: 7, calendar_max_events: 4,
    compliments: ["Systems nominal. So are you.", "Looking sharp, choom.", "Ready for takeoff."],
    easter_eggs: { enabled: true, glitch_min_minutes: 600, glitch_max_minutes: 900, hack_min_minutes: 600, hack_max_minutes: 900, matrix_rain: true, japanese_day: false, boot: true },
    notes: { expire_days: 7, max_shown: 3, allow_guests: true },
    chores: [], special_days: [], special_days_countdown: 7,
    presence: { enabled: false, devices: [] },
    refresh_minutes: { weather: 15, news: 30, calendar: 15, compliment: 1, notes: 5 },
    lan_url: "http://mirror.local:8080",
  },
  weather: {
    current_units: { temperature_2m: "°F", wind_speed_10m: "mph" },
    current: { temperature_2m: 54, apparent_temperature: 52, relative_humidity_2m: 86, weather_code: 63, wind_speed_10m: 7 },
    daily: {
      time: [0, 1, 2, 3, 4].map(day), weather_code: [63, 61, 3, 2, 0],
      temperature_2m_max: [57, 59, 62, 64, 66], temperature_2m_min: [48, 47, 49, 50, 51],
      precipitation_probability_max: [90, 60, 20, 10, 5],
    },
  },
  news: { headlines: [
    { title: "MIRROR-OS 2.0.77 rolls out to one (1) hallway", source: "Demo Feed" },
    { title: "Two-way acrylic still reflecting, sources confirm", source: "Demo Feed" },
    { title: "Local Pi passes first cold boot with no smoke", source: "Demo Feed" },
    { title: "Forecast: katakana rain expected through Tuesday", source: "Demo Feed" },
  ], count: 4 },
  calendar: { events: [
    { title: "Bike tune-up", start: new Date(now + 26 * 36e5).toISOString(), all_day: false },
    { title: "Game night", start: new Date(now + 3 * 864e5).toISOString(), all_day: false },
    { title: "Recycling day", start: day(4), all_day: true },
  ] },
  notes: { notes: [
    { id: 2, from: "Dillon", to: "Dillon", text: "Order the second PIR sensor", guest: false, at: iso(40 * 6e4) },
    { id: 1, from: "Sam", to: "Dillon", text: "The mirror said hi to me. Creepy. Love it.", guest: true, at: iso(3 * 36e5) },
  ] },
  presence: { enabled: false, people: {} },
};

async function open(browser, w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 / 3 });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  page.on("console", (m) => { if (m.type() !== "log") console.log("console", m.type(), m.text()); });
  await page.route(ORIGIN + "/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/api/notes/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": demo\n\n" });
    if (p.startsWith("/api/")) {
      const key = p.slice(5);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DEMO[key] ?? {}) });
    }
    const file = path.join(STATIC, p === "/" ? "index.html" : decodeURIComponent(p));
    if (!file.startsWith(STATIC) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
  });
  // Block anything else (no outbound traffic from the demo).
  await page.route(/^(?!http:\/\/mirror\.demo).*/, (r) => r.abort());
  await page.goto(ORIGIN + "/");
  return page;
}

(async () => {
  const browser = await launch();
  const W = 1080, H = 1920; // portrait 1080p mirror, captured at 720x1280

  let page = await open(browser, W, H);
  await page.waitForTimeout(1300);
  await page.screenshot({ path: path.join(OUT, "mirror-boot.png") });
  await page.waitForTimeout(7500);
  await page.screenshot({ path: path.join(OUT, "mirror-rain.png") });
  await page.evaluate(() => { runHack(); });
  await page.waitForTimeout(3800);
  await page.screenshot({ path: path.join(OUT, "mirror-hack.png") });
  await page.close();

  await browser.close();
  console.log("mirror demo renders written to", OUT);
})();
