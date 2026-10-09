// Renders site/favicon.svg (with the site's JetBrains Mono webfont) to the PNG icon set.
// Run: NODE_PATH=<node_modules with playwright> node tools/render_icons.js   then: python tools/make_icons_ico.py
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const SITE = path.join(__dirname, "..", "site");
const svg = fs.readFileSync(path.join(SITE, "favicon.svg"), "utf8");
const font = "file:///" + path.join(SITE, "assets", "fonts", "jetbrains-mono.woff2").replace(/\\/g, "/");
const OUT = [
  ["icon-16.png", 16], ["icon-32.png", 32], ["icon-48.png", 48],
  ["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512],
];

(async () => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: "msedge" }); }
  const page = await browser.newPage();
  for (const [name, size] of OUT) {
    // apple-touch icons get a solid background (iOS adds its own rounding)
    const bg = name === "apple-touch-icon.png" ? "#05070a" : "transparent";
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><head><style>
      @font-face{font-family:'JetBrains Mono';src:url('${font}') format('woff2');font-weight:100 900}
      html,body{margin:0;background:${bg}}svg{display:block;width:${size}px;height:${size}px}
    </style></head><body>${svg}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(SITE, name), omitBackground: bg === "transparent" });
    console.log("wrote", name);
  }
  await browser.close();
})();
