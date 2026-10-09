// Per-page Open Graph share cards (1200x630 PNG) and the meta tags that point at them.
//   node tools/render_og.js && python tools/stamp_assets.py
//   node tools/render_og.js arcade now      # only these cards (by "out" name; "og-image" = the generic card)
// Renders tools/brand/og-page.html once per page below with the site's own fonts into
// site/assets/og/<name>.png, squeezes each PNG through a 256-colour palette (Pillow) to stay well
// under 200 KB, and refreshes site/og-image.png (the generic card, tools/brand/og.html) for pages
// without their own. Then rewrites each page's og:image / og:image:alt / og:image:width/height /
// twitter:card / twitter:image to the absolute https://dillongreen.dev URL (stamp_assets.py adds ?v=).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { launch } = require("./pw");

const SITE = path.resolve(__dirname, "..", "site");
const OUT = path.join(SITE, "assets", "og");
const ORIGIN = "https://dillongreen.dev";
const fileUrl = (f) => "file:///" + path.resolve(__dirname, "brand", f).replace(/\\/g, "/");
const WORD = "01100100010001011100000011000001"; // 0x6445C0C1, label 203, +35,000 ft

const PAGES = [
  { file: "index.html", out: "home", alt: "Dillon Green, flight simulator engineer · software & automation, with an ARINC 429 data word",
    d: { kicker: "Flight simulator engineer · Software & automation", title: "Dillon Green", dot: ".", size: 128,
      subStrong: "10 years in aviation.", sub: "Tools, apps and games built on the side.", art: { bits: WORD, readout: ["LBL 203 · ALT", "+35,000 ft"] } } },
  { file: "projects/index.html", out: "projects", alt: "Projects by Dillon Green: aviation tools, apps, games, hardware and experiments",
    d: { kicker: "Projects · Index", title: "Everything I've shipped", dot: ".", sub: "Aviation tools, apps and games on the web, a smart mirror and browser experiments.",
      art: { chips: [["Aviation", "c"], ["Apps", "c"], ["Games", "p"], ["Hardware", "a"], ["Experiments", ""], ["● Live on the web", "on"]] } } },
  { file: "par.html", out: "par", alt: "PAR case study: a parts and requisitions platform for an airline simulator department",
    d: { kicker: "Case study", title: "PAR", dot: ".", size: 150, sub: "A parts, procurement, work-order and budget platform for an airline flight simulator department.",
      art: { stats: [["~72k", "lines"], ["231", "routes"], ["340+", "checks", "g"], ["40", "people"]] } } },
  { file: "studio/index.html", out: "studio", alt: "Dillon Green · Studio: small, reliable software for aviation people",
    d: { kicker: "Dillon Green · Studio", title: "Small, reliable software for aviation people", size: 100, sub: "Built by someone who's worked the floor. First up: pocket429.",
      art: { chips: [["Technicians", "c"], ["Sim engineers", "c"], ["Flight schools", "p"], ["Repair stations", "a"]] } } },
  { file: "guestbook/index.html", out: "guestbook", alt: "Dillon Green's guestbook, Web 1.0 style",
    d: { kicker: "Guestbook · est. 2026", title: "Sign the guestbook", dot: "!", sub: "Like it's 1999. Every entry is read and approved by hand.",
      art: { chips: [["★ Best viewed in any browser", "p"], ["No cookies", "on"], ["Hit counter", "a"]] } } },
  { file: "now/index.html", out: "now", alt: "What Dillon Green is doing now, updated October 8, 2026",
    d: { kicker: "Now · Updated Oct 8, 2026", title: "What I'm doing now", sub: "Simulator engineering by day. Shipping Crumb, pocket429 and Linework, building a few games.",
      art: { chips: [["Crumb · in review", "a"], ["pocket429 · live", "on"], ["Linework · live", "on"]] } } },
  { file: "arcade/index.html", out: "arcade", alt: "The arcade: Dillon Green's web games, playable on the page",
    d: { kicker: "Arcade · Insert coin", title: "Play them right here", dot: ".", sub: "butter, beepbeach, Mixtape Drift, Little Airfield and Fernwood, one cabinet at a time.",
      art: { chips: [["▶ Play here", "c"], ["Click to load", "p"], ["Sandboxed", "a"], ["5 cabinets", "on"]] } } },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// one meta tag: replace its content, or add it after og:image if it isn't there yet
function setMeta(html, attr, name, value, file) {
  const re = new RegExp(`(<meta ${attr}="${name.replace(/:/g, "\\:")}" content=")[^"]*(">)`);
  if (re.test(html)) return html.replace(re, (m, a, b) => a + esc(value) + b);
  const anchor = /<meta property="og:image" content="[^"]*">\n/;
  if (!anchor.test(html)) throw new Error(`${file}: no og:image tag to anchor ${name}`);
  return html.replace(anchor, (m) => m + `<meta ${attr}="${name}" content="${esc(value)}">\n`);
}

const ONLY = process.argv.slice(2);
const TODO = ONLY.length ? PAGES.filter((p) => ONLY.includes(p.out)) : PAGES;
const GENERIC = !ONLY.length || ONLY.includes("og-image");
const UNKNOWN = ONLY.filter((o) => o !== "og-image" && !PAGES.some((p) => p.out === o));
if (UNKNOWN.length) { console.error("unknown card(s): " + UNKNOWN.join(", ")); process.exit(1); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  const written = [];
  for (const p of TODO) {
    await page.goto(fileUrl("og-page.html"));
    await page.evaluate(() => document.fonts.ready);
    const size = await page.evaluate((d) => window.fill(d), p.d);
    await page.waitForTimeout(80);
    const png = path.join(OUT, p.out + ".png");
    await page.screenshot({ path: png });
    written.push(png);
    console.log(`card ${p.out.padEnd(20)} title ${size}px`);
  }
  // the generic card (og-image.png) for pages without their own (privacy, 404)
  if (GENERIC) {
    await page.goto(fileUrl("og.html"));
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SITE, "og-image.png") });
    written.push(path.join(SITE, "og-image.png"));
  }
  await browser.close();

  // palette-quantize: flat colours and big type survive 256 colours fine, and the files shrink a lot
  const py = `import sys
from PIL import Image
for f in sys.argv[1:]:
    im = Image.open(f).convert("RGB")
    im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f, optimize=True)
    print("  %-28s %4d KB" % (f.replace("\\\\", "/").split("/site/")[-1], (__import__("os").path.getsize(f) + 512) // 1024))`;
  execFileSync(process.env.PYTHON || "python", ["-c", py, ...written], { stdio: "inherit" });

  // meta tags
  for (const p of TODO) {
    const f = path.join(SITE, p.file);
    let html = fs.readFileSync(f, "utf8");
    const before = html;
    const img = `${ORIGIN}/assets/og/${p.out}.png`;
    html = setMeta(html, "property", "og:image", img, p.file);
    html = setMeta(html, "property", "og:image:width", "1200", p.file);
    html = setMeta(html, "property", "og:image:height", "630", p.file);
    html = setMeta(html, "property", "og:image:alt", p.alt, p.file);
    html = setMeta(html, "name", "twitter:card", "summary_large_image", p.file);
    html = setMeta(html, "name", "twitter:image", img, p.file);
    html = setMeta(html, "name", "twitter:image:alt", p.alt, p.file);
    if (html !== before) { fs.writeFileSync(f, html); console.log("meta  " + p.file); }
  }
  console.log("now run: python tools/stamp_assets.py");
})();
