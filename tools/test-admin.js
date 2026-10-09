// End-to-end check of the /admin/ console against `wrangler pages dev` with a LOCAL D1 and the
// local-only dev bypass (it can't work in production: needs DEV_ADMIN_BYPASS=1 AND a 127.0.0.1/localhost host).
//   npx wrangler d1 execute dillongreen-db --local --file db/schema.sql
//   npx wrangler pages dev site --port 8791 --binding DEV_ADMIN_BYPASS=1 --binding IP_SALT=local-test-salt
//   node tools/test-admin.js [baseUrl]
// Seeds entries through the public form APIs (fresh CF-Connecting-IP per post), then drives the UI.
// Screenshots: verify/admin-*.png
const path = require("path");
const fs = require("fs");
const { launch } = require("./pw");

const BASE = (process.argv[2] || "http://127.0.0.1:8791/").replace(/\/$/, "");
const OUT = path.join(path.resolve(__dirname, ".."), "verify");
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };
let ipN = 0;
async function post(endpoint, body) {
  const r = await fetch(BASE + endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": `10.77.${Math.floor(++ipN / 250)}.${ipN % 250}` }, body: JSON.stringify(body) });
  return r.status;
}
const admin = async (route, body) => {
  const r = await fetch(BASE + "/api/admin/" + route, body ? { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) } : {});
  return { status: r.status, data: await r.json().catch(() => null) };
};

(async () => {
  // clean slate (through the admin API itself, so nothing here can touch a remote DB)
  for (const list of ["pending", "approved"]) for (const it of (await admin(list)).data.items) await admin("delete-guestbook", { id: it.id });
  for (const it of (await admin("waitlist")).data.items) await admin("delete-waitlist", { id: it.id });

  const seeds = [
    { name: "Ada", url: "example.com", message: "Hello from the hangar. Loved the ARINC 429 bit-flipper." },
    { name: "<img src=x onerror=alert(1)>", message: "<script>window.__xss = 1</script> should show as text" },
    { name: "Zoë ✈️", url: "zoe.example.org/blog", message: "Line one\nLine two\n\nA much longer line that keeps going so the card has to wrap on a phone screen without pushing anything sideways at all." },
    { name: "Marcus", message: "Sim tech here. Same pain with paper squawk sheets." },
  ];
  for (const s of seeds) check(await post("/api/guestbook", s) === 201, `seed guestbook: ${s.name.slice(0, 12)}`);
  const wl = [
    { email: "pilot@example.com", role: "sim", org_size: "11-50", notify: true, workflow: "We log squawks on paper, then retype them into a spreadsheet every night. Would love a phone-first flow." },
    { email: "tech@example.net", role: "amp-avionics", org_size: "1", notify: false, workflow: "" },
  ];
  for (const w of wl) check(await post("/api/waitlist", w) === 201, `seed waitlist: ${w.role}`);
  const marcus = (await admin("pending")).data.items.find((i) => i.name === "Marcus");
  await admin("approve", { id: marcus.id });

  const browser = await launch();
  const errors = [];
  async function open(width, height, scheme = "dark") {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, hasTouch: width < 600, isMobile: width < 600 });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" && !/status of (403|404)/.test(m.text())) errors.push(`${width}: ${m.text()}`); });
    page.on("pageerror", (e) => errors.push(`${width}: ${e.message}`));
    await page.goto(BASE + "/admin/", { waitUntil: "networkidle" });
    await page.waitForSelector(".adm-card, .adm-empty b");
    return { ctx, page };
  }

  /* ---- phone ---- */
  let { ctx, page } = await open(390, 844);
  check(await page.$eval('meta[name="robots"]', (m) => m.content.includes("noindex")), "meta robots noindex");
  check((await page.$$(".adm-card")).length === 3, "3 pending cards");
  check(await page.$eval('[data-count="pending"]', (n) => n.textContent) === "3" && await page.$eval('[data-count="approved"]', (n) => n.textContent) === "1" && await page.$eval('[data-count="waitlist"]', (n) => n.textContent) === "2", "tab counts 3 / 1 / 2");
  check(await page.evaluate(() => window.__xss === undefined && !document.querySelector(".adm-card img, .adm-card script")), "hostile name/message rendered as text (no img/script elements, nothing ran)");
  check(await page.locator(".adm-name", { hasText: "<img src=x onerror=alert(1)>" }).count() === 1, "the literal markup is visible as text");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll at 390");
  const small = await page.evaluate(() => Array.from(document.querySelectorAll("button, a.adm-btn")).filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent));
  check(small.length === 0, "tap targets >= 44px" + (small.length ? ": " + small.join(", ") : ""));
  await page.screenshot({ path: path.join(OUT, "admin-390-pending.png"), fullPage: true });

  // approve (optimistic): card disappears at once, server agrees
  const ada = page.locator(".adm-card", { hasText: "Hello from the hangar" });
  await ada.getByRole("button", { name: "Approve" }).click();
  check(await page.locator(".adm-card", { hasText: "Hello from the hangar" }).count() === 0, "approve: card removed immediately");
  check(await page.$eval('[data-count="pending"]', (n) => n.textContent) === "2", "approve: pending count 3 -> 2");
  await page.waitForTimeout(400);
  const pub = await (await fetch(BASE + "/api/guestbook")).json();
  check(pub.entries.some((e) => e.name === "Ada"), "approve: entry is public on /api/guestbook");

  // delete with undo
  const xss = page.locator(".adm-card", { hasText: "should show as text" });
  await xss.getByRole("button", { name: "Delete" }).click();
  check(await page.locator(".adm-card", { hasText: "should show as text" }).count() === 0, "delete: card removed immediately");
  await page.getByRole("button", { name: "Undo" }).click();
  check(await page.locator(".adm-card", { hasText: "should show as text" }).count() === 1, "undo: card is back");
  await page.waitForTimeout(4500);
  check((await admin("pending")).data.items.some((i) => /should show as text/.test(i.message)), "undo: nothing was deleted on the server");
  await page.locator(".adm-card", { hasText: "should show as text" }).getByRole("button", { name: "Delete" }).click();
  await page.waitForTimeout(4600);
  check(!(await admin("pending")).data.items.some((i) => /should show as text/.test(i.message)), "delete: sent after the undo window");

  // waitlist tab
  await page.getByRole("tab", { name: /Waitlist/ }).click();
  await page.waitForSelector(".adm-email");
  check(await page.$$eval("a.adm-email", (as) => as.some((a) => a.href.startsWith("mailto:pilot@example.com?subject="))), "waitlist: mailto reply link");
  check(await page.locator(".adm-tags li.on", { hasText: "notify: yes" }).count() === 1, "waitlist: notify flag shown");
  check(await page.locator(".adm-msg", { hasText: "retype them into a spreadsheet" }).count() === 1, "waitlist: workflow text shown");
  await page.screenshot({ path: path.join(OUT, "admin-390-waitlist.png"), fullPage: true });
  await page.locator(".adm-card", { hasText: "tech@example.net" }).getByRole("button", { name: "Delete" }).click();
  await page.waitForTimeout(4600);
  check((await admin("waitlist")).data.items.length === 1, "waitlist delete reached the server");

  // approved tab
  await page.getByRole("tab", { name: /Approved/ }).click();
  // the waitlist card is still on screen until the approved list arrives: wait for that re-render
  await page.waitForFunction(() => {
    const p = document.getElementById("panel");
    return p.getAttribute("aria-labelledby") === "tab-approved" && p.getAttribute("aria-busy") === "false" &&
      !p.querySelector(".adm-email") && !!p.querySelector(".adm-card");
  });
  check((await page.$$(".adm-card")).length === 2 && (await page.$$(".adm-btn-ok")).length === 0, "approved tab: 2 cards, delete only");
  await page.screenshot({ path: path.join(OUT, "admin-390-approved.png"), fullPage: true });

  // locked view (simulate a 403 the way production answers without Access)
  await page.route("**/api/admin/**", (r) => r.fulfill({ status: 403, contentType: "application/json", body: '{"ok":false,"error":"forbidden"}' }));
  await page.getByRole("button", { name: "Refresh the current list" }).click();
  await page.waitForSelector(".adm-empty b");
  check(/locked/i.test(await page.textContent(".adm-empty b")), "403 -> locked message");
  await page.screenshot({ path: path.join(OUT, "admin-390-locked.png") });
  // wrong host (simulate the 404 that *.pages.dev / preview URLs get)
  await page.unroute("**/api/admin/**");
  await page.route("**/api/admin/**", (r) => r.fulfill({ status: 404, contentType: "application/json", body: '{"ok":false,"error":"not found"}' }));
  await page.getByRole("button", { name: "Refresh the current list" }).click();
  await page.waitForFunction(() => /wrong address/i.test((document.querySelector(".adm-empty b") || {}).textContent || ""));
  check((await page.textContent(".adm-empty")).includes("dillongreen.dev/admin/"), "404 (not an admin host) -> 'wrong address' message");
  await ctx.close();

  /* ---- desktop ---- */
  ({ ctx, page } = await open(1440, 900));
  await page.screenshot({ path: path.join(OUT, "admin-1440-pending.png"), fullPage: true });
  await page.getByRole("tab", { name: /Waitlist/ }).click();
  await page.waitForSelector(".adm-email");
  await page.screenshot({ path: path.join(OUT, "admin-1440-waitlist.png"), fullPage: true });
  // keyboard tabs
  await page.focus("#tab-waitlist");
  await page.keyboard.press("ArrowLeft");
  check(await page.$eval("#tab-approved", (t) => t.getAttribute("aria-selected")) === "true" && await page.evaluate(() => document.activeElement.id) === "tab-approved", "arrow keys move between tabs");
  await ctx.close();

  /* ---- daylight ---- */
  ({ ctx, page } = await open(390, 844, "light"));
  await page.evaluate(() => { localStorage.setItem("theme", "light"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".adm-card");
  await page.screenshot({ path: path.join(OUT, "admin-390-light.png"), fullPage: true });
  await ctx.close();

  await browser.close();
  check(errors.length === 0, "no console / CSP / page errors" + (errors.length ? ":\n   " + errors.join("\n   ") : ""));
  console.log(fails ? `\n${fails} FAILED` : "\nall admin UI tests passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
