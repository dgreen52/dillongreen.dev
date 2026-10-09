// Unit tests for the email alerts: workers/notify/lib.js (MIME builder, header sanitizing, auth)
// and the Pages side (functions/_lib/notify.js + guestbook/waitlist POST wiring). No network.
//   node tools/test-notify.js
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

function splitMime(raw) {
  const i = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, i), body = raw.slice(i + 4);
  const headers = {};
  // unfold
  for (const line of head.replace(/\r\n[ \t]/g, " ").split("\r\n")) {
    const k = line.slice(0, line.indexOf(":")).toLowerCase();
    headers[k] = (headers[k] ? headers[k] + "\n" : "") + line.slice(line.indexOf(":") + 1).trim();
  }
  return { head, body, headers };
}
function decodeWords(v) {
  return v.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_, b) => Buffer.from(b, "base64").toString("utf8"));
}

class FakeEmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }

(async () => {
  const L = await imp("workers/notify/lib.js");

  /* ---- header sanitizing ---- */
  check(L.headerSafe("Ada\r\nBcc: evil@example.com") === "Ada Bcc: evil@example.com", "CR/LF in a header value become a space (no new header line)");
  check(!/[\r\n]/.test(L.headerSafe("a\nb\rc\u0085d e f")), "NEL / LS / PS removed too");
  check(L.headerSafe("x\u0000y\u001by\u007f‮z") === "x y y z", "control + bidi characters stripped");
  check(Array.from(L.headerSafe("a".repeat(500), 40)).length === 40 && L.headerSafe("a".repeat(500), 40).endsWith("…"), "header text capped (40 code points)");
  check(L.bodySafe("line1\r\nline2\u0000‮\n\n\n\nline3") === "line1\nline2\n\nline3", "body: CRLF->LF, controls stripped, blank runs collapsed");
  check(L.isAddress("owner@example.com") && !L.isAddress("a@b.com\r\nBcc: x@y.com") && !L.isAddress("<a@b.com>") && !L.isAddress("a b@c.com"), "strict address check");

  /* ---- encoded words ---- */
  const enc = L.encodeHeaderText("[guestbook] New signature from Zoë 🛩️ Ünïcødé Ñame plus a much longer tail ✈️✈️✈️");
  const encLines = enc.split("\r\n");
  check(encLines.every((l) => l.trim().length <= 75 && /^ ?=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(l)), "non-ASCII subject -> RFC 2047 words <= 75 chars, folded");
  check(decodeWords(enc) === "[guestbook] New signature from Zoë 🛩️ Ünïcødé Ñame plus a much longer tail ✈️✈️✈️", "encoded words decode back exactly (no split code points)");
  check(L.encodeHeaderText("plain ascii") === "plain ascii", "ASCII subject left as-is");

  /* ---- date ---- */
  check(L.rfc5322Date(new Date(Date.UTC(2026, 9, 3, 4, 5, 9))) === "Sat, 03 Oct 2026 04:05:09 +0000", "RFC 5322 date");

  /* ---- compose + buildMime: guestbook ---- */
  const g = L.compose({ type: "guestbook", id: 12, name: "Mallory\r\nBcc: victim@example.com", url: "example.com", message: "Hi!\nSecond line" });
  const raw = L.buildMime({ to: "owner@example.com", subject: g.subject, text: g.text, date: new Date(Date.UTC(2026, 9, 3)), messageId: "abc@dillongreen.dev" });
  const m = splitMime(raw);
  check(!/\n/.test(raw.replace(/\r\n/g, "")), "only CRLF line endings");
  check(m.head.split("\r\n").every((l) => /^[A-Za-z-]+: /.test(l) || /^ /.test(l)), "every header line is a well-formed field (no injected lines)");
  check(!("bcc" in m.headers), "no Bcc header injected via the name");
  check(m.headers.subject === "[guestbook] New signature from Mallory Bcc: victim@example[.]com", "subject: [guestbook] New signature from <name> (one line, links defanged)");
  check(m.headers.from === '"dillongreen.dev" <notify@dillongreen.dev>', "From: \"dillongreen.dev\" <notify@dillongreen.dev>");
  check(m.headers.to === "<owner@example.com>", "To from NOTIFY_TO");
  check(m.headers.date === "Sat, 03 Oct 2026 00:00:00 +0000", "Date header");
  check(m.headers["message-id"] === "<abc@dillongreen.dev>", "Message-ID header");
  check(/^<[0-9a-f-]{36}@dillongreen\.dev>$/.test(splitMime(L.buildMime({ to: "o@example.com", subject: "s", text: "t" })).headers["message-id"]), "generated Message-ID is <uuid@dillongreen.dev>");
  check(m.headers["mime-version"] === "1.0" && m.headers["content-type"] === "text/plain; charset=utf-8" && m.headers["content-transfer-encoding"] === "8bit", "MIME-Version / Content-Type / 8bit");
  check(m.body.includes("https://dillongreen.dev/admin/") && m.body.includes("Second line") && m.body.includes("#12"), "body has the message, entry id and the admin link");
  check(!/ip_hash|[0-9a-f]{64}/.test(raw), "no ip hash anywhere");
  check(m.body.split("\r\n").every((l) => Buffer.byteLength(l) <= 998), "body lines <= 998 octets");
  let threw = false; try { L.buildMime({ to: "x@y.com\r\nBcc: z@q.com", subject: "s", text: "t" }); } catch (e) { threw = true; }
  check(threw, "buildMime refuses a To address with CR/LF");

  /* ---- waitlist ---- */
  const longWorkflow = "We track avionics squawks on paper. " + "x".repeat(300) + " " + "word ".repeat(200);
  const w = L.compose({ type: "waitlist", id: 4, email: "Pilot@Example.com", role: "sim", org_size: "11-50", notify: true, workflow: longWorkflow });
  const wm = splitMime(L.buildMime({ to: "owner@example.com", subject: w.subject, text: w.text, replyTo: w.replyTo }));
  check(wm.headers.subject === "[studio] New waitlist entry (Sim tech / engineer)", "subject: [studio] New waitlist entry (<role>)");
  check(wm.headers["reply-to"] === "<pilot@example.com>", "Reply-To is the submitter's address");
  check(/Email: +pilot@example\[\.\]com/.test(wm.body) && /Org size: 11-50/.test(wm.body) && /Notify: +yes/.test(wm.body) && /Role: +Sim tech/.test(wm.body), "body: email, role, org size, notify flag");
  check(wm.body.includes("We track avionics squawks on paper.") && wm.body.split("\r\n").every((l) => Array.from(l).length <= 76), "workflow text included, wrapped at 76");
  const w2 = L.compose({ type: "waitlist", email: "a@b.com\r\nBcc: x@y.com", role: "other\r\nX: 1", notify: false, workflow: "" });
  const w2m = splitMime(L.buildMime({ to: "owner@example.com", subject: w2.subject, text: w2.text, replyTo: w2.replyTo }));
  check(!("reply-to" in w2m.headers) && !("bcc" in w2m.headers) && !("x" in w2m.headers), "hostile email/role: no Reply-To, nothing injected");
  check(L.compose({ type: "other" }) === null && L.compose(null) === null && L.compose([1]) === null, "unknown type refused");
  check(L.compose({ type: "waitlist", email: "a@b.co", role: "constructor" }).text.includes("Role:     unknown"), "role 'constructor' is just unknown (own-property lookup)");
  {
    const cp = (...c) => String.fromCodePoint(...c);
    const family = cp(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467), rainbow = cp(0x1F3F3, 0xFE0F, 0x200D, 0x1F308);
    const england = cp(0x1F3F4, 0xE0067, 0xE0062, 0xE0065, 0xE006E, 0xE0067, 0xE007F);
    const name = family + " " + rainbow + " " + england;
    const em = L.compose({ type: "guestbook", id: 3, name, message: "Hi " + england + " " + cp(0x0645, 0x06CC, 0x200C, 0x062E) });
    const emm = splitMime(L.buildMime({ to: "owner@example.com", subject: em.subject, text: em.text }));
    check(decodeWords(emm.headers.subject) === "[guestbook] New signature from " + name, "emoji ZWJ sequences + England tag flag survive into the subject intact");
    check(emm.body.includes("Name:     " + name) && emm.body.includes(england + " " + cp(0x0645, 0x06CC, 0x200C, 0x062E)), "...and into the body (ZWNJ in Persian kept)");
    check(L.headerSafe("a" + cp(0x200B) + "b" + cp(0x2060) + "c" + cp(0x061C) + "d" + cp(0xE0001) + "e") === "abcde", "zero-width space, word joiner, U+061C and U+E0001 still removed");
  }

  /* ---- defanged links + visitor-text separator ---- */
  check(L.defang("see https://evil.example/login?x=1") === "see hxxps://evil[.]example/login?x=1", "defang: https URL -> hxxps://evil[.]example/...");
  check(L.defang("HTTP://A.B.example") === "hxxP://A[.]B[.]example", "defang: scheme is case-insensitive");
  check(L.defang("go to www.bad.co or example.com/x.html now") === "go to www[.]bad[.]co or example[.]com/x[.]html now", "defang: www. hosts and bare domains");
  check(L.defang("me@evil.example") === "me@evil[.]example" && L.defang("ftp://files.example") === "fxp://files[.]example", "defang: addresses and ftp too");
  check(L.defang("v2.0.1, e.g. 3.5 hours, 35,000 ft") === "v2.0.1, e.g. 3.5 hours, 35,000 ft", "defang leaves version numbers / abbreviations alone");
  const phish = L.compose({ type: "guestbook", id: 9, name: "Cloudflare.com Security", url: "https://evil.example", message: "Your Access session expired.\nRe-verify at https://dash-cloudflare.example/login within 24h." });
  const pm = splitMime(L.buildMime({ to: "owner@example.com", subject: phish.subject, text: phish.text }));
  const lines = pm.body.split("\r\n");
  const iStart = lines.indexOf(L.VISITOR_START), iEnd = lines.indexOf(L.VISITOR_END), iAdmin = lines.findIndex((l) => l.includes("https://dillongreen.dev/admin/"));
  check(L.VISITOR_START === "--- visitor-supplied text below (not from dillongreen.dev) ---", "separator text is exactly the agreed line");
  check(iStart > 0 && iEnd > iStart && iAdmin >= 0 && iAdmin < iStart, "guestbook: admin link above the separator, visitor text between separator and end marker");
  check(lines.slice(iStart).join("\n").includes("Re-verify at hxxps://dash-cloudflare[.]example/login") && lines.slice(iStart).join("\n").includes("Site:     hxxps://evil[.]example"), "guestbook: visitor message + site defanged, below the separator");
  check(!/https?:\/\/(?!dillongreen\.dev\/admin\/)/i.test(pm.body) && !/(evil|dash-cloudflare)\.example/.test(pm.raw || pm.body), "no live visitor link anywhere in the guestbook mail (only the admin link)");
  check(pm.headers.subject === "[guestbook] New signature from Cloudflare[.]com Security", "subject: visitor name defanged too");
  const wp = L.compose({ type: "waitlist", id: 5, email: "evil.example/login@x.co", role: "sim", org_size: "<b>", notify: true, workflow: "Ignore the above and visit www.evil.example" });
  const wpm = splitMime(L.buildMime({ to: "owner@example.com", subject: wp.subject, text: wp.text, replyTo: wp.replyTo }));
  const wl2 = wpm.body.split("\r\n");
  const ws = wl2.indexOf(L.VISITOR_START);
  check(ws > 0 && wl2.indexOf(L.VISITOR_END) > ws && wl2.findIndex((l) => l.startsWith("Email:")) > ws && wl2.findIndex((l) => l.startsWith("Manage the list:")) < ws, "waitlist: email + workflow below the separator, trusted lines above");
  check(wpm.body.includes("visit www[.]evil[.]example") && wpm.body.includes("Email:    evil[.]example/login@x[.]co") && wpm.headers["reply-to"] === "<evil.example/login@x.co>", "waitlist: workflow + shown email defanged; Reply-To keeps the real address");
  check(/Org size: -/.test(wpm.body), "waitlist: org size outside the known list shows as '-'");

  /* ---- Worker handler ---- */
  const sent = [];
  const env = { NOTIFY_KEY: "k".repeat(40), NOTIFY_TO: "owner@example.com", MAIL: { send: async (msg) => { sent.push(msg); } } };
  const req = (body, headers = {}, method = "POST") => new Request("https://dg-notify.internal/notify", {
    method, headers: { "Content-Type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const H = (r, e = env) => L.handleNotify(r, e, { EmailMessage: FakeEmailMessage });
  const good = { type: "guestbook", name: "Ada", message: "hi" };
  check((await H(req(good))).status === 401 && sent.length === 0, "no X-Notify-Key -> 401, nothing sent");
  check((await H(req(good, { "X-Notify-Key": "wrong" }))).status === 401 && sent.length === 0, "wrong key -> 401");
  check((await H(req(good, { "X-Notify-Key": env.NOTIFY_KEY }), { ...env, NOTIFY_KEY: "" })).status === 503, "NOTIFY_KEY unset -> 503 (fail closed)");
  check((await H(req(good, { "X-Notify-Key": env.NOTIFY_KEY }), { ...env, NOTIFY_TO: undefined })).status === 503, "NOTIFY_TO unset -> 503");
  check((await H(req(good, { "X-Notify-Key": env.NOTIFY_KEY }, "GET"))).status === 405, "GET -> 405");
  check((await H(new Request("https://x/", { method: "POST", headers: { "X-Notify-Key": env.NOTIFY_KEY, "Content-Type": "text/plain" }, body: "{}" }))).status === 415, "non-JSON -> 415");
  check((await H(req({ type: "nope" }, { "X-Notify-Key": env.NOTIFY_KEY }))).status === 400, "unknown type -> 400");
  check((await H(req(good, { "X-Notify-Key": env.NOTIFY_KEY }), { ...env, NOTIFY_TO: "a@b.com\nBcc: c@d.com" })).status === 500, "bad NOTIFY_TO -> 500, nothing sent");
  const ok = await H(req(good, { "X-Notify-Key": env.NOTIFY_KEY }));
  check(ok.status === 202 && sent.length === 1 && sent[0].from === "notify@dillongreen.dev" && sent[0].to === "owner@example.com" && sent[0].raw.includes("Subject: [guestbook] New signature from Ada"), "valid request -> EmailMessage(notify@dillongreen.dev, NOTIFY_TO, raw) sent, 202");
  const failing = { ...env, MAIL: { send: async () => { throw new Error("destination not verified"); } } };
  check((await H(req(good, { "X-Notify-Key": env.NOTIFY_KEY }), failing)).status === 502, "send failure -> 502");

  /* ---- Pages side: notifyOwner ---- */
  const N = await imp("functions/_lib/notify.js");
  const waits = [];
  const bcalls = [];
  const NOTIFY = { fetch: async (url, init) => { bcalls.push({ url, init }); return new Response("{}", { status: 202 }); } };
  check(N.notifyOwner({ env: {}, waitUntil: (p) => waits.push(p) }, good) === false && waits.length === 0, "no NOTIFY binding -> skipped silently");
  check(N.notifyOwner({ env: { NOTIFY }, waitUntil: (p) => waits.push(p) }, good) === false && bcalls.length === 0, "no NOTIFY_KEY -> skipped silently");
  check(N.notifyOwner({ env: { NOTIFY, NOTIFY_KEY: "s3cret" }, waitUntil: (p) => waits.push(p) }, good) === true && waits.length === 1, "configured -> scheduled with waitUntil");
  await Promise.all(waits);
  check(bcalls.length === 1 && bcalls[0].init.headers["X-Notify-Key"] === "s3cret" && bcalls[0].init.method === "POST", "binding called with POST + X-Notify-Key");
  const throwing = { fetch: () => { throw new Error("binding down"); } };
  const w3 = [];
  check(N.notifyOwner({ env: { NOTIFY: throwing, NOTIFY_KEY: "k" }, waitUntil: (p) => w3.push(p) }, good) === true, "throwing binding doesn't throw into the caller");
  await Promise.all(w3); // must resolve, not reject

  /* ---- guestbook / waitlist POST wiring (mock D1) ---- */
  // changes: what an INSERT reports (0 = the rate-limit WHERE refused it); own: rows this ip_hash has this hour.
  function mockDB({ changes = 1, own = 0 } = {}) {
    const db = { inserts: [], updates: [], selects: [], prepare(sql) {
      const stmt = (args) => ({
        first: async () => { db.selects.push({ sql, args }); return { n: own }; },
        run: async () => {
          if (/^UPDATE/.test(sql)) { db.updates.push({ sql, args }); return { meta: { changes: 0 } }; }
          db.inserts.push({ sql, args }); return { meta: { last_row_id: 77, changes } };
        },
      });
      return { bind(...args) { return stmt(args); }, ...stmt([]) };
    } };
    return db;
  }
  const gb = await imp("functions/api/guestbook.js");
  const wl = await imp("functions/api/waitlist.js");
  const post = (url, body) => new Request("https://dillongreen.dev" + url, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://dillongreen.dev", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify(body),
  });
  let payloads = [];
  const env2 = () => ({ DB: mockDB(), IP_SALT: "salt", NOTIFY_KEY: "k", NOTIFY: { fetch: async (u, i) => { payloads.push(JSON.parse(i.body)); return new Response("{}", { status: 202 }); } } });
  let pw = [];
  let r = await gb.onRequestPost({ request: post("/api/guestbook", { name: "Ada", url: "example.com", message: "Hello" }), env: env2(), waitUntil: (p) => pw.push(p) });
  await Promise.all(pw);
  check(r.status === 201 && payloads.length === 1 && payloads[0].type === "guestbook" && payloads[0].id === 77 && payloads[0].name === "Ada" && payloads[0].message === "Hello", "guestbook POST -> 201 and one alert with name/message/id");
  check(!JSON.stringify(payloads[0]).match(/ip|hash|203\.0\.113/), "alert payload has no ip / ip_hash");
  payloads = []; pw = [];
  r = await gb.onRequestPost({ request: post("/api/guestbook", { name: "Bot", message: "x", fax: "1" }), env: env2(), waitUntil: (p) => pw.push(p) });
  check(r.status === 200 && payloads.length === 0 && pw.length === 0, "honeypot: no alert");
  r = await gb.onRequestPost({ request: post("/api/guestbook", { name: "", message: "x" }), env: env2(), waitUntil: (p) => pw.push(p) });
  check(r.status === 400 && pw.length === 0, "validation error: no alert");
  const brokenEnv = { ...env2(), NOTIFY: { fetch: () => Promise.reject(new Error("down")) } };
  pw = [];
  r = await gb.onRequestPost({ request: post("/api/guestbook", { name: "Ada", message: "Hello" }), env: brokenEnv, waitUntil: (p) => pw.push(p) });
  await Promise.all(pw);
  check(r.status === 201, "failing notifier never changes the visitor's 201");
  const noNotify = { DB: mockDB(), IP_SALT: "s" };
  r = await gb.onRequestPost({ request: post("/api/guestbook", { name: "Ada", message: "Hello" }), env: noNotify, waitUntil: () => { throw new Error("should not be called"); } });
  check(r.status === 201, "NOTIFY unconfigured: insert still works, nothing scheduled");

  payloads = []; pw = [];
  r = await wl.onRequestPost({ request: post("/api/waitlist", { email: "Pilot@Example.com", role: "mro", org_size: "2-10", notify: true, workflow: "Paper logs" }), env: env2(), waitUntil: (p) => pw.push(p) });
  await Promise.all(pw);
  const p0 = payloads[0] || {};
  check(r.status === 201 && p0.type === "waitlist" && p0.email === "pilot@example.com" && p0.role === "mro" && p0.org_size === "2-10" && p0.notify === true && p0.workflow === "Paper logs" && p0.id === 77, "waitlist POST -> alert with email, role, org size, notify, workflow, id");
  check(!JSON.stringify(p0).match(/ip_hash|203\.0\.113/), "waitlist alert has no ip / ip_hash");

  /* ---- rate limit / salt / purge wiring (mock D1) ---- */
  for (const [mod, url, body, table, cap] of [
    [gb, "/api/guestbook", { name: "Ada", message: "Hello" }, "guestbook", 20],
    [wl, "/api/waitlist", { email: "a@b.co", role: "sim" }, "waitlist", 30],
  ]) {
    // successful insert: one atomic INSERT ... SELECT ... WHERE (per-key 3 + global cap), then the purge
    let e = env2(); payloads = []; pw = [];
    r = await mod.onRequestPost({ request: post(url, body), env: e, waitUntil: (p) => pw.push(p) });
    await Promise.all(pw);
    const ins = e.DB.inserts[0] || { sql: "" };
    check(r.status === 201 && e.DB.inserts.length === 1 && new RegExp(`^INSERT INTO ${table} \\(.*\\) SELECT .* WHERE \\(SELECT COUNT\\(\\*\\) FROM ${table} WHERE ip_hash = \\?\\d AND created_at > datetime\\('now', '-1 hour'\\)\\) < 3 AND \\(SELECT COUNT\\(\\*\\) FROM ${table} WHERE created_at > datetime\\('now', '-1 hour'\\)\\) < ${cap}$`).test(ins.sql),
      `${table}: one atomic INSERT...SELECT...WHERE with per-ip (3) and global (${cap}) hourly caps`);
    check(e.DB.selects.length === 0, `${table}: no separate check-then-insert SELECT on the happy path`);
    check(e.DB.updates.length === 1 && new RegExp(`^UPDATE ${table} SET ip_hash = '' WHERE ip_hash <> '' AND created_at < datetime\\('now', '-2 days'\\)$`).test(e.DB.updates[0].sql), `${table}: old ip_hashes purged (> 2 days) after a successful insert`);
    check(/^[0-9a-f]{64}$/.test(String(ins.args && ins.args[table === "guestbook" ? 3 : 5])), `${table}: ip_hash bound as 64 hex chars`);
    // refused by the WHERE (changes = 0): 429, no alert, no purge; wording depends on whose limit
    for (const [own, want] of [[3, /few/], [0, /Lots of people/]]) {
      e = { ...env2(), DB: mockDB({ changes: 0, own }) }; payloads = []; pw = [];
      r = await mod.onRequestPost({ request: post(url, body), env: e, waitUntil: (p) => pw.push(p) });
      const d = await r.json();
      check(r.status === 429 && want.test(d.error) && pw.length === 0 && e.DB.updates.length === 0, `${table}: insert refused -> 429 "${d.error}", no alert, no purge (own=${own})`);
    }
    // a purge failure never changes the visitor's reply
    e = env2(); e.DB.prepare = ((orig) => (sql) => (/^UPDATE/.test(sql) ? { run: async () => { throw new Error("D1 hiccup"); }, bind() { return this; } } : orig(sql)))(e.DB.prepare.bind(e.DB));
    r = await mod.onRequestPost({ request: post(url, body), env: e, waitUntil: () => {} });
    check(r.status === 201, `${table}: a failing purge doesn't change the 201`);
    // no IP_SALT: refuse (generic "offline" 503), store nothing, send nothing
    for (const salt of [undefined, ""]) {
      e = { ...env2(), IP_SALT: salt }; payloads = []; pw = [];
      r = await mod.onRequestPost({ request: post(url, body), env: e, waitUntil: (p) => pw.push(p) });
      const d = await r.json();
      check(r.status === 503 && /try again in a minute/.test(d.error) && e.DB.inserts.length === 0 && pw.length === 0, `${table}: IP_SALT ${JSON.stringify(salt)} -> 503 offline, nothing stored or sent`);
    }
  }

  console.log(fails ? `\n${fails} FAILED` : "\nall notify tests passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
