// Renders og-image.png (1200x630), apple-touch-icon.png (180), icon-192/512 and
// favicon-32 from tools/brand/*.html, using the site's own fonts.
//   node tools/render-brand.js && python tools/make_ico.py
const path = require("path");
const { launch } = require("./pw");
const SITE = path.resolve(__dirname, "..", "site");
const url = (f) => "file:///" + path.resolve(__dirname, "brand", f).replace(/\\/g, "/");

(async () => {
  const browser = await launch();
  const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await og.goto(url("og.html")); await og.evaluate(() => document.fonts.ready); await og.waitForTimeout(300);
  await og.screenshot({ path: path.join(SITE, "og-image.png") });

  const shots = [["apple-touch-icon.png", 180, "#full"], ["icon-192.png", 192, ""], ["icon-512.png", 512, ""], ["favicon-32.png", 32, ""]];
  for (const [name, size, hash] of shots) {
    const p = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: size / 512 });
    await p.goto(url("icon.html") + hash); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(SITE, name), omitBackground: true });
    await p.close();
  }
  await browser.close();
  console.log("brand assets written to", SITE);
})();
