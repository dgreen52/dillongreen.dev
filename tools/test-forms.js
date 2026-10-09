// End-to-end checks for the guestbook + waitlist (Pages Functions + local D1) and the new pages.
// Runs against `wrangler pages dev` with a LOCAL D1 only; it wipes the local guestbook/waitlist tables.
//   npx wrangler d1 execute dillongreen-db --local --file db/schema.sql
//   npx wrangler pages dev site --port 8788 --binding IP_SALT=local-test-salt
//   node tools/test-forms.js [baseUrl]
// Set WRANGLER to a wrangler binary if `npx wrangler` isn't usable offline, and IP_SALT if the server
// was started with a different salt (the ip_hash check recomputes the HMAC).
const path = require("path");
const nodeCrypto = require("crypto");
const { pathToFileURL } = require("url");
const { execSync } = require("child_process");
const { launch } = require("./pw");

const BASE = (process.argv[2] || "http://127.0.0.1:8788/").replace(/\/$/, "");
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "verify");
const WRANGLER = process.env.WRANGLER || "npx wrangler";
const SALT = process.env.IP_SALT || "local-test-salt";
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };

function sql(command) {
  // LOCAL ONLY. Never add --remote here.
  const out = execSync(`${WRANGLER} d1 execute dillongreen-db --local --json --command "${command.replace(/"/g, '\\"')}"`,
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[parsed.length - 1].results;
}
// Node's fetch reuses keep-alive sockets that the local dev server may already have closed; retry once.
async function http(url, init) {
  try { return await fetch(url, init); }
  catch (e) { await new Promise((r) => setTimeout(r, 200)); return fetch(url, { ...init, headers: { ...(init && init.headers), Connection: "close" } }); }
}
let ipN = 0;
const freshIp = () => `10.42.${Math.floor(++ipN / 250)}.${ipN % 250}`;
async function post(endpoint, body, opts = {}) {
  const headers = { "Content-Type": opts.type || "application/json", "CF-Connecting-IP": opts.ip || freshIp() };
  if (opts.origin) headers.Origin = opts.origin;
  if (opts.country !== undefined) headers["CF-IPCountry"] = opts.country;
  const res = await http(BASE + endpoint, { method: opts.method || "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}
const getEntries = async () => (await (await http(BASE + "/api/guestbook")).json());
// POST with a streamed body: Node sends it chunked, with no Content-Length header. When the server
// stops reading at the cap it may answer (400) and close the socket before Node has written the
// rest; that refusal surfaces as a write error here and is reported as status "aborted".
async function postChunked(endpoint, text, ip) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 1024) c.enqueue(bytes.slice(i, i + 1024)); c.close(); } });
  let res;
  try {
    res = await fetch(BASE + endpoint, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip || freshIp(), Connection: "close" }, body, duplex: "half" });
  } catch (e) {
    const code = e && e.cause && e.cause.code;
    if (["ECONNABORTED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) return { status: "aborted", data: null };
    throw e;
  }
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}
const hmac = (bucket) => nodeCrypto.createHmac("sha256", SALT).update(bucket).digest("hex");
// Push every row two hours into the past (order kept), so the hourly limits start fresh.
const age = () => sql("UPDATE guestbook SET created_at = datetime(created_at, '-2 hours'); UPDATE waitlist SET created_at = datetime(created_at, '-2 hours');");

(async () => {
  /* ---------------- handlers without IP_SALT (no server needed) ---------------- */
  {
    const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
    const untouchable = { prepare() { throw new Error("DB must not be touched without IP_SALT"); }, batch() { throw new Error("DB must not be touched"); } };
    const req = (url, body) => new Request("https://dillongreen.dev" + url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://dillongreen.dev", "CF-Connecting-IP": "203.0.113.7" }, body: JSON.stringify(body) });
    const origError = console.error; console.error = () => {};
    for (const [mod, url, body] of [["functions/api/guestbook.js", "/api/guestbook", { name: "Salty", message: "no salt" }], ["functions/api/waitlist.js", "/api/waitlist", { email: "s@x.co", role: "sim" }]]) {
      const m = await imp(mod);
      for (const IP_SALT of [undefined, ""]) {
        const res = await m.onRequestPost({ request: req(url, body), env: { DB: untouchable, IP_SALT }, waitUntil: () => { throw new Error("nothing may be scheduled"); } });
        const d = await res.json();
        check(res.status === 503 && d.ok === false && /try again in a minute/.test(d.error), `${url}: IP_SALT ${JSON.stringify(IP_SALT)} -> refused with the generic offline reply, DB untouched`);
      }
    }
    console.error = origError;
    const F = await imp("functions/_lib/forms.js");
    check(F.rateKey("2001:db8:aa:1::1") === "2001:db8:aa:1::/64" && F.rateKey("2001:0DB8:00aa:0001:ffff:ffff:ffff:ffff") === "2001:db8:aa:1::/64" && F.rateKey("::1") === "0:0:0:0::/64", "rateKey: IPv6 -> its /64 (compressed, padded and upper-case forms agree)");
    check(F.rateKey("203.0.113.7") === "203.0.113.7" && F.rateKey("::ffff:203.0.113.7") === "::ffff:203.0.113.7" && F.rateKey("") === "unknown" && F.rateKey("2001:db8::1::2") === "2001:db8::1::2", "rateKey: IPv4 / IPv4-mapped kept whole, junk left as-is");
    const h = await F.ipHash(new Request("https://x/", { headers: { "CF-Connecting-IP": "2001:db8:aa:1::5" } }), { IP_SALT: SALT });
    check(h === hmac("2001:db8:aa:1::/64"), "ipHash = HMAC-SHA-256(key IP_SALT, /64 bucket), hex");
    const cc = [["US", "US"], ["nz", "NZ"], [" gb ", "GB"], ["XX", null], ["T1", null], ["USA", null], ["U", null], ["", null], [null, null], [undefined, null], ["<b", null], ["ÜS", null], ["U1", null], [42, null]];
    const ccBad = cc.filter(([v, want]) => F.countryCode(v) !== want);
    check(ccBad.length === 0, "countryCode: two letters (upper-cased) or null; XX (unknown) and T1 (Tor) dropped" + (ccBad.length ? " FAILED for " + JSON.stringify(ccBad) : ""));
    check(F.requestCountry(new Request("https://x/", { headers: { "CF-IPCountry": "JP" } })) === "JP" && F.requestCountry(new Request("https://x/")) === null, "requestCountry reads CF-IPCountry (absent -> null)");
  }

  sql("DELETE FROM guestbook; DELETE FROM waitlist;");

  /* ---------------- guestbook API ---------------- */
  let g = await getEntries();
  check(g.ok && g.total === 0 && g.entries.length === 0, "GET /api/guestbook starts empty");

  let r = await post("/api/guestbook", { name: "Ada", url: "https://example.com", message: "Hello from the hangar." });
  check(r.status === 201 && r.data.ok, "valid POST accepted (201)");
  let rows = sql("SELECT id, name, status, length(ip_hash) AS hl FROM guestbook");
  check(rows.length === 1 && rows[0].status === "pending" && rows[0].hl === 64, "stored as pending with a 64-char ip_hash");
  g = await getEntries();
  check(g.total === 0 && g.entries.length === 0, "pending entry is NOT visible");
  sql(`UPDATE guestbook SET status = 'approved' WHERE id = ${Number(rows[0].id)}`);
  g = await getEntries();
  check(g.total === 1 && g.entries[0].name === "Ada" && !("ip_hash" in g.entries[0]) && !("id" in g.entries[0]), "approved entry visible, no ip_hash/id exposed");

  /* country: from CF-IPCountry, validated, kept per entry, shown only as an aggregate of approved entries */
  {
    const sent = [["Geo NZ", "NZ"], ["Geo nz", "nz"], ["Geo CA", "CA"], ["Geo XX", "XX"], ["Geo T1", "T1"], ["Geo USA", "USA"], ["Geo html", "<b>"], ["Geo none", undefined]];
    for (const [name, country] of sent) {
      r = await post("/api/guestbook", { name, message: "Signed with a country header" }, { country });
      if (r.status !== 201) check(false, `country post ${name} -> ${r.status}`);
    }
    const geo = Object.fromEntries(sql("SELECT name, country FROM guestbook WHERE name LIKE 'Geo %'").map((x) => [x.name, x.country]));
    check(geo["Geo NZ"] === "NZ" && geo["Geo nz"] === "NZ" && geo["Geo CA"] === "CA", "CF-IPCountry stored as two capital letters (NZ, nz -> NZ, CA)");
    check(["Geo XX", "Geo T1", "Geo USA", "Geo html", "Geo none"].every((n) => geo[n] === null), "XX, T1, USA, <b> and a missing header are stored as NULL");
    g = await getEntries();
    check(Array.isArray(g.countries) && g.countries.length === 0, "pending entries' countries are not shown");
    sql("UPDATE guestbook SET status = 'approved' WHERE name IN ('Geo NZ', 'Geo nz', 'Geo CA', 'Geo XX')");
    g = await (await http(BASE + "/api/guestbook?fresh=" + Date.now())).json();
    check(JSON.stringify(g.countries) === '["NZ","CA"]', "GET countries: distinct codes of approved entries, most signatures first: " + JSON.stringify(g.countries));
    check(g.entries.every((e) => !("country" in e)), "no entry carries its country (only the aggregate list)");
    sql("DELETE FROM guestbook WHERE name LIKE 'Geo %'");
  }

  r = await post("/api/guestbook", { name: "Bot", message: "buy things", fax: "555" });
  check(r.status === 200 && r.data.ok && sql("SELECT COUNT(*) AS n FROM guestbook WHERE name = 'Bot'")[0].n === 0, "honeypot: friendly reply, nothing stored");

  const ip = freshIp();
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post("/api/guestbook", { name: "Rate " + i, message: "msg " + i }, { ip })).status);
  check(codes.join() === "201,201,201,429", "rate limit: 3 per hour per ip_hash, 4th is 429 (" + codes.join() + ")");
  r = await post("/api/guestbook", { name: "Other", message: "different ip" });
  check(r.status === 201, "a different ip_hash is not affected by the limit");

  const bad = [
    [{ name: "x".repeat(41), message: "hi" }, "name > 40 chars"],
    [{ name: "ok", message: "x".repeat(281) }, "message > 280 chars"],
    [{ name: "", message: "hi" }, "empty name"],
    [{ name: "ok", message: "   " }, "whitespace-only message"],
    [{ name: "ok", message: "see https://a.com and https://b.com" }, "> 1 URL in message"],
    [{ name: "ok", message: "see a.com and www.b.net" }, "> 1 bare domain in message"],
    [{ name: "ok", url: "javascript:alert(1)", message: "hi" }, "javascript: url"],
    [{ name: "ok", url: "not a url", message: "hi" }, "url with spaces"],
  ];
  for (const [body, label] of bad) {
    r = await post("/api/guestbook", body);
    check(r.status === 400 && r.data && r.data.ok === false && typeof r.data.error === "string" && !/error:|exception|sqlite|stack/i.test(r.data.error), "rejects " + label + " with a friendly 400");
  }
  r = await post("/api/guestbook", "{not json", {});
  check(r.status === 400, "rejects malformed JSON");
  r = await post("/api/guestbook", "name=a&message=b", { type: "application/x-www-form-urlencoded" });
  check(r.status === 400, "rejects non-JSON content type");
  r = await post("/api/guestbook", { name: "x", message: "y" }, { origin: "https://evil.example" });
  check(r.status === 403, "rejects cross-origin POST");
  r = await post("/api/guestbook", JSON.stringify({ name: "y", message: "z".repeat(9000) }));
  check(r.status === 400, "rejects oversized body");

  r = await post("/api/guestbook", { name: "Ctl\u0000\u0007Name‮", message: "line1\r\n\r\n\r\n\r\nline2\u0000" });
  const ctl = sql("SELECT name, message FROM guestbook WHERE name LIKE 'Ctl%'")[0];
  check(r.status === 201 && ctl && ctl.name === "CtlName" && ctl.message === "line1\n\nline2", "control chars + bidi overrides stripped, blank lines collapsed");
  {
    const cp = (...c) => String.fromCodePoint(...c);
    // stripped: zero-width space, word joiner, BOM, Arabic letter mark, the deprecated LANGUAGE TAG; U+2028 -> newline
    r = await post("/api/guestbook", { name: "Ze" + cp(0x200B) + "ro" + cp(0x2060) + "Width" + cp(0xFEFF), message: "a" + cp(0x061C) + "b" + cp(0xE0001) + "c" + cp(0x2028) + "d" });
    const zw = sql("SELECT name, message FROM guestbook WHERE name LIKE 'Zero%'")[0];
    check(r.status === 201 && zw && zw.name === "ZeroWidth" && zw.message === "abc\nd", "zero-width space, word joiner, BOM, U+061C and U+E0001 stripped; U+2028 -> newline (" + JSON.stringify(zw) + ")");
    // kept: ZWJ/ZWNJ and the tag characters, so emoji sequences and scripts like Persian survive intact
    const family = cp(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467), rainbow = cp(0x1F3F3, 0xFE0F, 0x200D, 0x1F308);
    const england = cp(0x1F3F4, 0xE0067, 0xE0062, 0xE0065, 0xE006E, 0xE0067, 0xE007F);
    const scotland = cp(0x1F3F4, 0xE0067, 0xE0062, 0xE0073, 0xE0063, 0xE0074, 0xE007F);
    const persian = cp(0x0645, 0x06CC, 0x200C, 0x062E, 0x0648, 0x0627, 0x0647, 0x0645); // needs its ZWNJ
    const emojiName = family + " " + rainbow + " " + england, emojiMsg = "Greetings " + scotland + " " + persian;
    r = await post("/api/guestbook", { name: emojiName, message: emojiMsg });
    const em = sql("SELECT name, message FROM guestbook WHERE message LIKE 'Greetings %'")[0];
    check(r.status === 201 && em && em.name === emojiName && em.message === emojiMsg, "family + rainbow-flag ZWJ sequences, England/Scotland tag flags and Persian ZWNJ survive intact");
  }

  // XSS payloads: stored verbatim, rendered as text
  const XSS = { name: "<img src=x onerror=alert(1)>", url: "example.com/<svg/onload=alert(2)>", message: "<script>alert(3)</script><b>bold?</b> \"quotes\" & 'apos'" };
  r = await post("/api/guestbook", XSS);
  check(r.status === 201, "XSS-looking entry accepted as text");
  sql("UPDATE guestbook SET status = 'approved' WHERE name LIKE '<img%' OR name IN ('Other', 'CtlName')");

  /* ---------------- waitlist API ---------------- */
  r = await post("/api/waitlist", { email: "Tech@Example.com", role: "sim", org_size: "11-50", workflow: "Copying fault codes by hand.", notify: true });
  check(r.status === 201 && r.data.ok, "waitlist POST accepted");
  let w = sql("SELECT email, role, org_size, workflow, notify, length(ip_hash) AS hl FROM waitlist");
  check(w.length === 1 && w[0].email === "tech@example.com" && w[0].role === "sim" && w[0].org_size === "11-50" && w[0].notify === 1 && w[0].hl === 64, "waitlist row stored (email lowercased, notify=1)");
  r = await post("/api/waitlist", { email: "a@b.co", role: "student" });
  check(r.status === 201 && sql("SELECT notify FROM waitlist WHERE email = 'a@b.co'")[0].notify === 0, "notify defaults to 0, optional fields optional");
  for (const m of ["GET", "PUT", "DELETE"]) {
    const res = await http(BASE + "/api/waitlist", { method: m });
    const text = await res.text();
    check([404, 405].includes(res.status) && !text.includes("a@b.co") && !text.includes("tech@example.com"), `waitlist ${m} is ${res.status}, no data exposed`);
  }
  for (const [body, label] of [
    [{ email: "nope", role: "sim" }, "bad email"],
    [{ email: "a@b.co", role: "pilot-in-command" }, "unknown role"],
    [{ email: "a@b.co", role: "sim", org_size: "9000" }, "unknown org size"],
    [{ email: "a@b.co", role: "sim", workflow: "x".repeat(1001) }, "workflow > 1000 chars"],
  ]) { r = await post("/api/waitlist", body); check(r.status === 400 && r.data.ok === false, "waitlist rejects " + label); }
  r = await post("/api/waitlist", { email: "bot@spam.co", role: "other", fax: "1" });
  check(r.status === 200 && sql("SELECT COUNT(*) AS n FROM waitlist WHERE email = 'bot@spam.co'")[0].n === 0, "waitlist honeypot: nothing stored");
  const wip = freshIp(), wcodes = [];
  for (let i = 0; i < 4; i++) wcodes.push((await post("/api/waitlist", { email: `r${i}@x.co`, role: "mro" }, { ip: wip })).status);
  check(wcodes.join() === "201,201,201,429", "waitlist rate limit (" + wcodes.join() + ")");

  /* ---------------- rate limit: atomic under parallel posts, IPv6 /64, global cap, purge ---------------- */
  age();
  {
    const rip = freshIp();
    const race = await Promise.all(Array.from({ length: 20 }, (_, i) => post("/api/guestbook", { name: "Race " + i, message: "parallel " + i }, { ip: rip })));
    const stored = sql("SELECT COUNT(*) AS n FROM guestbook WHERE name LIKE 'Race %'")[0].n;
    const ok201 = race.filter((x) => x.status === 201).length, n429 = race.filter((x) => x.status === 429).length;
    check(stored >= 1 && stored <= 3 && ok201 === stored && ok201 + n429 === 20, `guestbook: 20 parallel posts from one IP -> ${stored} stored (<= 3), ${n429} x 429`);
    const wrip = freshIp();
    const wrace = await Promise.all(Array.from({ length: 20 }, (_, i) => post("/api/waitlist", { email: `race${i}@x.co`, role: "sim" }, { ip: wrip })));
    const wstored = sql("SELECT COUNT(*) AS n FROM waitlist WHERE email LIKE 'race%'")[0].n;
    check(wstored >= 1 && wstored <= 3 && wrace.filter((x) => x.status === 201).length === wstored, `waitlist: 20 parallel posts from one IP -> ${wstored} stored (<= 3)`);
  }
  {
    const v6 = ["2001:db8:aa:1::1", "2001:db8:aa:1::2", "2001:0DB8:00AA:0001:ffff:ffff:ffff:ffff", "2001:db8:aa:1:1:2:3:4"];
    const v6codes = [];
    for (const a of v6) v6codes.push((await post("/api/guestbook", { name: "V6 same", message: "from " + a }, { ip: a })).status);
    check(v6codes.join() === "201,201,201,429", "IPv6: four addresses in one /64 share a bucket (" + v6codes.join() + ")");
    r = await post("/api/guestbook", { name: "V6 next", message: "neighbouring /64" }, { ip: "2001:db8:aa:2::1" });
    check(r.status === 201, "IPv6: the next /64 is a separate bucket");
    const hashes = sql("SELECT DISTINCT ip_hash FROM guestbook WHERE name = 'V6 same'").map((x) => x.ip_hash);
    check(hashes.length === 1 && hashes[0] === hmac("2001:db8:aa:1::/64"), "stored ip_hash = HMAC-SHA-256(IP_SALT, '2001:db8:aa:1::/64'), one hash for the whole /64");
    const v4 = "198.51.100.23";
    r = await post("/api/guestbook", { name: "V4 hash", message: "ipv4" }, { ip: v4 });
    check(r.status === 201 && sql("SELECT ip_hash FROM guestbook WHERE name = 'V4 hash'")[0].ip_hash === hmac(v4), "IPv4 ip_hash = HMAC-SHA-256(IP_SALT, ip)");
  }
  age();
  {
    const codes = [];
    for (let i = 0; i < 20; i++) codes.push((await post("/api/guestbook", { name: "Crowd " + i, message: "hello " + i })).status);
    const over = await post("/api/guestbook", { name: "Crowd 20", message: "one too many" });
    check(codes.every((c) => c === 201) && over.status === 429 && /Lots of people/.test(over.data.error) && sql("SELECT COUNT(*) AS n FROM guestbook WHERE name = 'Crowd 20'")[0].n === 0,
      `guestbook global cap: 20 posts/hour from 20 IPs go in, the 21st (fresh IP) is 429 "${over.data && over.data.error}"`);
    const wcodes2 = [];
    for (let i = 0; i < 30; i++) wcodes2.push((await post("/api/waitlist", { email: `crowd${i}@x.co`, role: "other" })).status);
    const wover = await post("/api/waitlist", { email: "crowd30@x.co", role: "other" });
    check(wcodes2.every((c) => c === 201) && wover.status === 429 && /Lots of people/.test(wover.data.error), "waitlist global cap: 30 posts/hour go in, the 31st is 429");
  }
  age();
  {
    sql("UPDATE guestbook SET created_at = datetime('now', '-3 days') WHERE name = 'Crowd 0'; UPDATE guestbook SET created_at = datetime('now', '-1 days') WHERE name = 'Crowd 1'; UPDATE waitlist SET created_at = datetime('now', '-3 days') WHERE email = 'crowd0@x.co';");
    r = await post("/api/guestbook", { name: "Purger", message: "triggers the purge" });
    const p = sql("SELECT name, ip_hash FROM guestbook WHERE name IN ('Crowd 0', 'Crowd 1', 'Purger') ORDER BY name");
    const by = Object.fromEntries(p.map((x) => [x.name, x.ip_hash]));
    check(r.status === 201 && by["Crowd 0"] === "" && /^[0-9a-f]{64}$/.test(by["Crowd 1"]) && /^[0-9a-f]{64}$/.test(by["Purger"]), "a successful post blanks ip_hash on rows older than 2 days, keeps newer ones");
    r = await post("/api/waitlist", { email: "purger@x.co", role: "sim" });
    check(r.status === 201 && sql("SELECT ip_hash FROM waitlist WHERE email = 'crowd0@x.co'")[0].ip_hash === "", "waitlist: same purge");
  }
  {
    r = await postChunked("/api/guestbook", JSON.stringify({ name: "Chunky", message: "x".repeat(64 * 1024) }));
    check((r.status === 400 || r.status === "aborted") && sql("SELECT COUNT(*) AS n FROM guestbook WHERE name = 'Chunky'")[0].n === 0, `64 KB chunked body without Content-Length -> refused (${r.status}), nothing stored`);
    r = await postChunked("/api/waitlist", JSON.stringify({ email: "chunky@x.co", role: "sim", workflow: "y".repeat(9000) }));
    check((r.status === 400 || r.status === "aborted") && sql("SELECT COUNT(*) AS n FROM waitlist WHERE email = 'chunky@x.co'")[0].n === 0, `waitlist: oversized chunked body -> refused (${r.status}), nothing stored`);
    r = await postChunked("/api/guestbook", JSON.stringify({ name: "Small chunks", message: "a normal entry, sent chunked" }));
    check(r.status === 201, "a normal-sized chunked body still works");
    r = await post("/api/guestbook", JSON.stringify({ name: "Multi", message: "é".repeat(270) + "x".repeat(10) }));
    check(r.status === 201, "multi-byte text near the length limits still fits the 8 KB byte cap");
  }
  age();

  /* ---------------- browser ---------------- */
  const browser = await launch();
  const errors = [];
  const ctxFor = (opts) => browser.newContext({ deviceScaleFactor: 1, extraHTTPHeaders: { "CF-Connecting-IP": freshIp() }, ...opts });
  const watch = (page, tag) => {
    page.on("pageerror", (e) => errors.push(`${tag} JS ${e.message}`));
    // 400/429 replies are provoked on purpose below; the browser logs them, the checks cover them
    page.on("console", (m) => { if (m.type() === "error" && !/status of (400|429) /.test(m.text())) errors.push(`${tag} console ${m.text()}`); });
    page.on("dialog", (d) => { errors.push(`${tag} DIALOG ${d.message()}`); d.dismiss(); });
  };

  // guestbook render: approved entries newest first, XSS as text, site never a link
  for (const [w, theme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]]) {
    const ctx = await ctxFor({ viewport: { width: w, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
    const page = await ctx.newPage(); watch(page, `guestbook ${w} ${theme}`);
    await page.goto(BASE + "/guestbook/", { waitUntil: "networkidle" });
    await page.waitForSelector(".gb-entry");
    if (w === 1440 && theme === "light") {
      const names = await page.$$eval(".gb-entry .who", (els) => els.map((e) => e.textContent));
      check(names[0] === XSS.name && names.includes("Ada") && names.length === 4, "approved entries render newest first: " + JSON.stringify(names));
      const inside = await page.$$eval(".gb-list", (l) => l[0].querySelectorAll("img, script, svg, b, a").length);
      check(inside === 0, "no HTML elements created from user data (img/script/svg/b/a)");
      const msg = await page.textContent(".gb-entry .msg");
      check(msg === XSS.message, "message shown verbatim as text");
      const site = await page.textContent(".gb-entry .site");
      check(site === XSS.url, "site shown as plain text");
      const odo = await page.$$eval("[data-odometer] span", (s) => s.map((x) => x.textContent).join(""));
      check(odo === "000004", "odometer shows approved count (" + odo + ")");
      // UI: client-side validation, then a real post that stays hidden
      await page.click('form[data-form="guestbook"] button[type="submit"]');
      check((await page.textContent("[data-status]")).includes("name") && (await page.getAttribute("#gb-name", "aria-invalid")) === "true", "empty submit: friendly client-side error");
      await page.fill("#gb-name", "Playwright Pilot");
      await page.fill("#gb-url", "pilot.example");
      await page.fill("#gb-msg", "Signed from a headless browser.");
      check((await page.textContent("#gb-msg-count")).trim() === "31 / 280", "character counter updates");
      // slow the POST down so the busy state is observable, and count how many go out
      let posts = 0;
      await page.route("**/api/guestbook", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts++; await new Promise((r) => setTimeout(r, 700)); return route.continue();
      });
      const submit = 'form[data-form="guestbook"] button[type="submit"]';
      await page.click(submit);
      await page.waitForTimeout(150);
      check(await page.$eval(submit, (b) => b.disabled && b.getAttribute("aria-busy") === "true" && b.textContent.includes("Signing")), "submit shows a busy state while sending");
      await page.$eval('form[data-form="guestbook"]', (f) => f.requestSubmit()); // a second submit while busy
      await page.waitForFunction(() => document.querySelector("[data-status]").classList.contains("ok"));
      check(posts === 1, `no double submit (${posts} POST)`);
      await page.unroute("**/api/guestbook");
      const said = await page.textContent("[data-status]");
      check(said.includes("Signed!") && said.includes("once I've seen it"), "UI post: clear 'Signed!' panel");
      check((await page.inputValue("#gb-name")) === "" && (await page.inputValue("#gb-msg")) === "", "form clears after success");
      check(await page.$eval(submit, (b) => !b.disabled && b.textContent === "Sign the guestbook"), "button back to normal");
      const top = async () => page.$eval(".gb-list .gb-entry", (li) => ({ pending: li.classList.contains("pending"), who: li.querySelector(".who").textContent, badge: (li.querySelector(".gb-pending") || {}).textContent || "", site: (li.querySelector(".site") || {}).textContent || "" }));
      let t1 = await top();
      check(t1.pending && t1.who === "Playwright Pilot" && t1.badge.includes("Awaiting approval") && t1.badge.includes("only you") && t1.site === "pilot.example", "own entry shows at the top, marked awaiting approval");
      await page.reload({ waitUntil: "networkidle" }); await page.waitForSelector(".gb-entry");
      t1 = await top();
      check(t1.pending && t1.who === "Playwright Pilot", "pending entry survives a reload in the same browser");
      const odo2 = await page.$$eval("[data-odometer] span", (s) => s.map((x) => x.textContent).join(""));
      check(odo2 === "000004", "pending entry isn't counted (" + odo2 + ")");
      {
        const other = await ctxFor({ viewport: { width: 1280, height: 900 } });
        const op = await other.newPage(); watch(op, "guestbook other visitor");
        await op.goto(BASE + "/guestbook/", { waitUntil: "networkidle" }); await op.waitForSelector(".gb-entry");
        check(!(await op.textContent(".gb-list")).includes("Playwright Pilot"), "another visitor doesn't see the pending entry");
        await other.close();
      }
      check(sql("SELECT status FROM guestbook WHERE name = 'Playwright Pilot'")[0].status === "pending", "UI post stored as pending");
      // a server-side validation error names and highlights the field
      await page.fill("#gb-name", "Linky");
      await page.fill("#gb-msg", "see https://a.example and https://b.example");
      await page.click(submit);
      await page.waitForFunction(() => document.querySelector("[data-status]").classList.contains("err"));
      check((await page.getAttribute("#gb-msg", "aria-invalid")) === "true" && (await page.textContent("[data-status]")).includes("One link"), "server validation error marks the message field");
      // once approved, the private copy is dropped and the real entry shows instead
      sql("UPDATE guestbook SET status = 'approved' WHERE name = 'Playwright Pilot'");
      await (await page.context().newCDPSession(page)).send("Network.clearBrowserCache"); // GET is cacheable for 60 s
      await page.reload({ waitUntil: "networkidle" }); await page.waitForSelector(".gb-entry");
      t1 = await top();
      const left = await page.evaluate(() => localStorage.getItem("dg-gb-pending"));
      check(!t1.pending && t1.who === "Playwright Pilot" && left === null && !(await page.$(".gb-entry.pending")), "after approval: normal entry, local pending copy cleared");
      sql("UPDATE guestbook SET status = 'pending' WHERE name = 'Playwright Pilot'");
    }
    await page.screenshot({ path: path.join(OUT, `guestbook-entries-${w}-${theme}.png`), fullPage: true });
    await ctx.close();
  }
  // rate-limited visitor gets a specific message (this ip uses up its 3 posts first; older posts were aged out)
  {
    const rlIp = freshIp();
    for (let i = 0; i < 3; i++) await post("/api/guestbook", { name: "Limit " + i, message: "using up the hour" }, { ip: rlIp });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 860 }, extraHTTPHeaders: { "CF-Connecting-IP": rlIp } });
    const page = await ctx.newPage(); watch(page, "guestbook rate-limited");
    await page.goto(BASE + "/guestbook/", { waitUntil: "networkidle" });
    await page.fill("#gb-name", "Again"); await page.fill("#gb-msg", "One more?");
    await page.click('form[data-form="guestbook"] button[type="submit"]');
    await page.waitForFunction(() => document.querySelector("[data-status]").classList.contains("err"));
    check((await page.textContent("[data-status]")).includes("signed a few times already") && (await page.inputValue("#gb-msg")) === "One more?", "429: clear rate-limit message, text kept");
    await ctx.close();
  }

  // guestbook flags: built from the codes with textContent; anything that isn't two capital letters is ignored
  for (const w of [1440, 390]) {
    const ctx = await ctxFor({ viewport: { width: w, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
    const page = await ctx.newPage(); watch(page, `guestbook flags ${w}`);
    const countries = ["NZ", "<img src=x onerror=alert(1)>", "XX", "us", "T1", "CA", "NZ", "JP", 7, null];
    await page.route("**/api/guestbook", (route) => route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, total: 1, entries: [{ name: "Flag Tester", url: "", message: "hi", date: "2026-10-08" }], countries }) })
      : route.continue());
    await page.goto(BASE + "/guestbook/", { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Signed from/.test(document.querySelector("[data-gb-geo-text]").textContent));
    const f = await page.$eval("[data-gb-flags]", (row) => ({
      kids: [...row.children].map((c) => ({ tag: c.tagName, cls: c.className, text: c.textContent, title: c.title })),
      label: row.getAttribute("aria-label"), html: row.innerHTML,
    }));
    const text = await page.textContent("[data-gb-geo-text]");
    check(text === "Signed from 3 countries", `${w}: "${text}" (NZ, CA, JP; junk, XX, T1, lower-case and repeats ignored)`);
    const isFlag = (k) => (k.cls === "gb-flag" && [...k.text].length === 2 && [...k.text].every((ch) => ch.codePointAt(0) >= 0x1F1E6 && ch.codePointAt(0) <= 0x1F1FF)) || (k.cls === "gb-flag is-code" && /^[A-Z]{2}$/.test(k.text));
    check(f.kids.length === 3 && f.kids.every((k) => k.tag === "SPAN" && isFlag(k)), `${w}: three flags, each a regional-indicator pair (or a code chip where the system has no flag emoji): ` + f.kids.map((k) => k.cls + ":" + k.text).join(" "));
    check(f.kids.map((k) => k.title).join() === "New Zealand,Canada,Japan" && /New Zealand, Canada, Japan/.test(f.label), `${w}: country names in title + the row's aria-label`);
    check(!/<img|onerror/.test(f.html) && (await page.$$("[data-gb-flags] img, [data-gb-flags] script")).length === 0, `${w}: no markup from the data`);
    await page.locator(".counter-box").screenshot({ path: path.join(OUT, `guestbook-flags-${w}-dark.png`) });
    await ctx.close();
  }

  // studio waitlist UI
  {
    const ctx = await ctxFor({ viewport: { width: 390, height: 860 } });
    const page = await ctx.newPage(); watch(page, "studio");
    await page.goto(BASE + "/studio/#waitlist", { waitUntil: "networkidle" });
    await page.click('form[data-form="waitlist"] button[type="submit"]');
    check((await page.textContent('form[data-form="waitlist"] [data-status]')).includes("email"), "waitlist empty submit: asks for email");
    await page.fill("#wl-email", "ui@test.dev");
    await page.click('form[data-form="waitlist"] button[type="submit"]');
    check((await page.textContent('form[data-form="waitlist"] [data-status]')).includes("role"), "waitlist asks for a role");
    await page.selectOption("#wl-role", "flight-school");
    await page.selectOption("#wl-size", "2-10");
    await page.fill("#wl-flow", "Scheduling checkrides across three spreadsheets.");
    check(!(await page.isChecked('input[name="notify"]')), "notify checkbox unchecked by default");
    await page.check('input[name="notify"]');
    await page.click('form[data-form="waitlist"] button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('form[data-form="waitlist"] [data-status]').classList.contains("ok"));
    const sent = await page.textContent('form[data-form="waitlist"] [data-status]');
    check(sent.includes("Sent") && sent.includes("ui@test.dev") && sent.includes("when something ships"), "waitlist success panel says what happens next");
    const row = sql("SELECT role, org_size, notify, workflow FROM waitlist WHERE email = 'ui@test.dev'")[0];
    check(row && row.role === "flight-school" && row.org_size === "2-10" && row.notify === 1 && row.workflow.startsWith("Scheduling"), "waitlist UI submission stored");
    await page.screenshot({ path: path.join(OUT, "studio-waitlist-sent-390.png") });
    await ctx.close();
  }

  // the unpublished writing section redirects home (site/_redirects), so old shared links don't 404
  {
    const ctx = await ctxFor({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage(); watch(page, "redirects");
    for (const p of ["/writing/", "/writing/arinc-429-decoded/", "/writing/directing-ai-agents/"]) {
      const r = await page.goto(BASE + p, { waitUntil: "domcontentloaded" });
      check(new URL(page.url()).pathname === "/" && r.ok() && (await page.$("#hero-title")), `${p} -> / (301)`);
    }
    await ctx.close();
  }

  // terminal additions (motion on), from a subpage
  {
    const ctx = await ctxFor({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
    await ctx.route(/pocket429\.dillongreen\.dev/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>pocket429</title>" }));
    await ctx.route(/butter\.dillon-eu-green\.workers\.dev/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>butter</title>" }));
    await ctx.route(/(dragonrealm|mixtape-drift)\.dillon-eu-green\.workers\.dev/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>game</title>" }));
    await ctx.route(/little-airfield\.dillon-eu-green\.workers\.dev/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>airfield</title>" }));
    const page = await ctx.newPage(); watch(page, "terminal");
    await page.goto(BASE + "/now/", { waitUntil: "networkidle" });
    await page.keyboard.press("Backquote");
    const run = async (cmd) => { await page.fill("#term-in", cmd); await page.keyboard.press("Enter"); };
    await run("help");
    const help = await page.textContent(".term-out");
    check(["play", "butter", "airfield", "open <name>", "fly", "guestbook", "studio", "now", "arcade"].every((c) => help.includes(c)), "help lists the new commands");
    const popup = page.waitForEvent("popup", { timeout: 4000 }).catch(() => null);
    await run("play butter");
    const pop = await popup;
    check(pop && pop.url().includes("butter.dillon-eu-green.workers.dev"), "play butter opens butter in a new tab");
    if (pop) await pop.close();
    const t = await page.textContent(".term-out");
    check(t.includes("Preflight checklist") && t.includes("cleared for takeoff"), "play butter prints the preflight line");
    for (const cmd of ["pocket429", "open pocket429"]) {
      const p429 = page.waitForEvent("popup", { timeout: 4000 }).catch(() => null);
      await run(cmd);
      const pp = await p429;
      check(pp && pp.url().startsWith("https://pocket429.dillongreen.dev"), `'${cmd}' opens the live pocket429 in a new tab`);
      if (pp) await pp.close();
    }
    for (const cmd of ["play dragonrealm", "play jaderealm"]) {
      const pd = page.waitForEvent("popup", { timeout: 4000 }).catch(() => null);
      await run(cmd);
      const pp = await pd;
      check(pp && pp.url().startsWith("https://dragonrealm.dillon-eu-green.workers.dev"), `'${cmd}' opens Dragon Realm Online in a new tab`);
      if (pp) await pp.close();
    }
    await run("play pong");
    // the playable games, in order, from tools/projects.json (what build_projects.py feeds the terminal)
    const games = require("./projects.json").projects.filter((p) => p.play && p.url).map((p) => (p.aliases || [p.slug])[0]);
    check(games.includes("fernwood") && (await page.textContent(".term-out")).includes("try " + games.join(", ")), "unknown game lists the valid games (try " + games.join(", ") + ")");
    await run("open site");
    check((await page.textContent(".term-out")).includes("you are already here"), "open site: you are already here");
    await run("ls");
    check((await page.textContent(".term-out")).includes("live: pocket429.dillongreen.dev") && (await page.textContent(".term-out")).includes("play airfield"), "ls lists projects (live pocket429, Little Airfield)");
    {
      const pa = page.waitForEvent("popup", { timeout: 4000 }).catch(() => null);
      await run("play airfield");
      const pp = await pa;
      check(pp && pp.url().startsWith("https://little-airfield.dillon-eu-green.workers.dev"), "play airfield opens Little Airfield in a new tab");
      if (pp) await pp.close();
      check((await page.textContent(".term-out")).includes("Cleared to land"), "play airfield prints the preflight line");
    }
    await run("fly");
    await page.waitForTimeout(1400);
    check(await page.isVisible(".t-fly svg"), "fly: plane crosses the terminal");
    await page.screenshot({ path: path.join(OUT, "fun-fly.png") });
    await page.waitForTimeout(1200);
    check((await page.textContent(".term-out")).includes("radar contact"), "fly: ATC reply");
    await run("now");
    check((await page.textContent(".term-out")).includes("already on"), "now: knows it's already there");
    await run("guestbook");
    await page.waitForURL(/\/guestbook\/$/, { timeout: 5000 });
    check(true, "guestbook command navigates to /guestbook/");
    await page.keyboard.press("Backquote");
    await run("waitlist");
    await page.waitForURL(/\/studio\/#waitlist$/, { timeout: 5000 });
    check(true, "waitlist command navigates to /studio/#waitlist");
    await page.keyboard.press("Backquote");
    await run("projects");
    await page.waitForURL(/\/projects\/$/, { timeout: 5000 });
    check(true, "projects command navigates to /projects/");
    await page.keyboard.press("Backquote");
    await run("resume");
    await ctx.close();
  }
  // fly under reduced motion: parked plane, no animation
  {
    const ctx = await ctxFor({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
    const page = await ctx.newPage(); watch(page, "fly-calm");
    await page.goto(BASE + "/studio/", { waitUntil: "networkidle" });
    await page.click("[data-term]");
    await page.fill("#term-in", "fly"); await page.keyboard.press("Enter");
    const anim = await page.$eval(".t-fly svg", (s) => getComputedStyle(s).animationName);
    check((await page.$(".t-fly.calm")) && anim === "none" && (await page.textContent(".term-out")).includes("radar contact"), "fly respects reduced motion (" + anim + ")");
    await page.fill("#term-in", "studio"); await page.keyboard.press("Enter");
    check((await page.textContent(".term-out")).includes("already on the studio"), "studio: already there");
    await page.screenshot({ path: path.join(OUT, "fun-fly-reduced-390.png") });
    await ctx.close();
  }

  // pocket429 live links: home card, hero caption, studio, now page (same-tab navigation, rel=noopener)
  {
    const ctx = await ctxFor({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage(); watch(page, "p429-links");
    const LIVE = 'a[href="https://pocket429.dillongreen.dev"]';
    for (const [p, where] of [["/", ".project .links"], ["/", ".word-bar .hint"], ["/studio/", ".project .links"], ["/now/", ".now-items"]]) {
      await page.goto(BASE + p, { waitUntil: "domcontentloaded" });
      const links = await page.$$eval(`${where} ${LIVE}`, (as) => as.map((a) => ({ rel: a.rel, target: a.target, vis: !!a.offsetParent })));
      check(links.length > 0 && links.every((l) => l.rel.includes("noopener") && !l.target && l.vis), `${p} ${where}: live pocket429 link (same tab, noopener)`);
    }
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    check(await page.$('.word-bar .hint a[href="#p-429"]'), "hero caption keeps the in-page 'see the project' anchor");
    await ctx.close();
  }

  // every page: no console errors / CSP violations, all requests succeed
  for (const p of ["/", "/projects/", "/arcade/", "/par.html", "/now/", "/studio/", "/guestbook/", "/privacy.html"]) {
    const ctx = await ctxFor({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage(); watch(page, p);
    const failed = [];
    page.on("response", (res) => { if (res.status() >= 400) failed.push(res.status() + " " + res.url()); });
    page.on("requestfailed", (req) => failed.push("FAILED " + req.url()));
    await page.goto(BASE + p, { waitUntil: "networkidle" });
    check(failed.length === 0, `${p}: all requests OK ${failed.length ? JSON.stringify(failed) : ""}`);
    await ctx.close();
  }
  check(errors.length === 0, "no JS errors, console errors, CSP violations or dialogs " + (errors.length ? JSON.stringify(errors) : ""));

  await browser.close();
  console.log(fails ? fails + " failure(s)" : "all form + page checks pass");
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
