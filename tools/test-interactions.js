// Functional checks for the page's JavaScript: bit flipper, keyboard, theme toggle.
//   node tools/test-interactions.js [baseUrl]
const { launch } = require("./pw");
const BASE = process.argv[2] || "http://127.0.0.1:8787/";

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "index.html");
  const txt = (sel) => page.textContent(sel).then((s) => s.trim().replace(/\s+/g, " "));
  let fails = 0;
  const expect = async (label, sel, want) => {
    const got = await txt(sel);
    const ok = got.includes(want);
    if (!ok) fails++;
    console.log(`${ok ? "ok " : "!! "}${label}: ${got}`);
  };

  await expect("initial value", "[data-value]", "+35,000");
  await expect("initial parity", "[data-parity]", "Parity OK");
  await page.click('.bit[data-bit="12"]');            // +1 ft, parity now wrong
  await expect("bit 12 -> value", "[data-value]", "+35,001");
  await expect("bit 12 -> parity", "[data-parity]", "Parity error");
  await page.click('.bit[data-bit="32"]');            // fix parity
  await expect("bit 32 -> parity", "[data-parity]", "Parity OK");
  await page.click('[data-reset]');
  await expect("reset", "[data-value]", "+35,000");
  await page.click('.bit[data-bit="29"]');            // sign bit -> two's complement
  // sign set: raw = 2^17 + 35000 over 18 bits -> 166072 - 262144 = -96072
  await expect("sign bit", "[data-value]", "−96,072");
  await page.click('.bit[data-bit="30"]');            // SSM 11 -> 10
  await expect("ssm", "[data-ssm]", "Functional test");
  await page.click('.bit[data-bit="1"]');             // label changes
  await expect("label", "[data-label-name]", "not in this demo");
  await page.click('[data-reset]');
  await expect("hex after reset", "[data-hex]", "0x6445C0C1");

  // keyboard: one tab stop, arrows move, space toggles
  await page.focus('.bit[data-bit="32"]');
  await page.keyboard.press("ArrowRight");
  const focused = await page.evaluate(() => document.activeElement.dataset.bit);
  console.log(`${focused === "31" ? "ok " : "!! "}arrow moves focus to bit ${focused}`); if (focused !== "31") fails++;
  await page.keyboard.press("Space");
  await expect("space toggles bit 31", "[data-ssm]", "SSM 01");

  // theme toggle persists
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click("[data-theme-toggle]");
  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.reload();
  const persisted = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const themeOk = before !== after && !!persisted;
  console.log(`${themeOk ? "ok " : "!! "}theme toggle ${before} -> ${after}, persisted=${persisted}`); if (!themeOk) fails++;

  if (errors.length) { fails += errors.length; console.log("!! JS errors:", errors); }
  console.log(fails ? `${fails} failure(s)` : "all interactions pass");
  await browser.close();
  process.exitCode = fails ? 1 : 0;
})();
