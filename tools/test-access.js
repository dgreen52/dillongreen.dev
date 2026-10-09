// Unit tests for the admin lock: Cloudflare Access JWT verification (functions/_lib/access.js) with a
// locally generated RSA keypair and a mocked certs endpoint, plus the admin API rules
// (functions/_lib/admin-core.js) with a mock D1. No network.   node tools/test-access.js
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log((ok ? "ok " : "!! ") + label); };
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const subtle = globalThis.crypto.subtle;

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "a".repeat(64);

async function keypair() {
  return subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
}
async function sign(priv, header, payload) {
  const h = b64u(JSON.stringify(header)), p = b64u(JSON.stringify(payload));
  const sig = await subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(h + "." + p));
  return h + "." + p + "." + b64u(sig);
}

(async () => {
  const A = await imp("functions/_lib/access.js");
  const C = await imp("functions/_lib/admin-core.js");

  const kp = await keypair();
  const other = await keypair();
  const jwk = await subtle.exportKey("jwk", kp.publicKey);
  let certFetches = 0;
  const certsUrls = [];
  const fetchCerts = async (url) => {
    certFetches++; certsUrls.push(url);
    if (url !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response("no", { status: 404 });
    return new Response(JSON.stringify({ keys: [{ kid: "k1", kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }], public_cert: {}, public_certs: [] }),
      { headers: { "Content-Type": "application/json" } });
  };
  let nowMs = Date.parse("2026-10-03T12:00:00Z");
  const now = Math.floor(nowMs / 1000);
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: "owner@example.com" };
  const opts = { fetch: fetchCerts, now: () => nowMs };
  const claims = (over = {}) => ({ aud: [AUD], email: "owner@example.com", exp: now + 3600, iat: now - 10, nbf: now - 10, iss: `https://${TEAM}`, sub: "u1", type: "app", ...over });
  const req = (token, url = "https://dillongreen.dev/api/admin/pending", init = {}) => {
    const headers = new Headers(init.headers || {});
    if (token) headers.set("Cf-Access-Jwt-Assertion", token);
    return new Request(url, { ...init, headers });
  };
  const V = (token, e = env) => A.verifyAccess(req(token), e, opts);

  const good = await sign(kp.privateKey, { alg: "RS256", kid: "k1", typ: "JWT" }, claims());
  let r = await V(good);
  check(r.ok && r.email === "owner@example.com", "valid token -> ok, email returned");
  check(certsUrls[0] === `https://${TEAM}/cdn-cgi/access/certs`, "keys fetched from https://<team>/cdn-cgi/access/certs");
  await V(good); await V(good);
  check(certFetches === 1, "certs cached (1 fetch for 3 verifications)");
  nowMs += 61 * 60 * 1000;
  const later = await sign(kp.privateKey, { alg: "RS256", kid: "k1" }, claims({ exp: Math.floor(nowMs / 1000) + 600, iat: Math.floor(nowMs / 1000), nbf: Math.floor(nowMs / 1000) }));
  r = await V(later);
  check(r.ok && certFetches === 2, "certs re-fetched after ~1h");
  nowMs = Date.parse("2026-10-03T12:00:00Z");
  A._resetKeyCache(); certFetches = 0;

  r = await V(await sign(kp.privateKey, { alg: "RS256", kid: "k1" }, claims({ exp: now - 3600 })));
  check(!r.ok && r.reason === "expired", "expired -> refused");
  r = await V(await sign(kp.privateKey, { alg: "RS256", kid: "k1" }, claims({ nbf: now + 3600 })));
  check(!r.ok && r.reason === "not yet valid", "nbf in the future -> refused");
  r = await V(await sign(kp.privateKey, { alg: "RS256", kid: "k1" }, claims({ aud: ["someone-else"] })));
  check(!r.ok && r.reason === "wrong audience", "wrong aud -> refused");
  r = await V(await sign(kp.privateKey, { alg: "RS256", kid: "k1" }, claims({ aud: AUD })));
  check(r.ok, "aud as a plain string also accepted");
  r = await V(await sign(kp.privateKey, { alg: "RS256", kid: "k1" }, claims({ iss: "https://evil.cloudflareaccess.com" })));
  check(!r.ok && r.reason === "wrong issuer", "wrong iss -> refused");
  r = await V(await sign(other.privateKey, { alg: "RS256", kid: "k1" }, claims()));
  check(!r.ok && r.reason === "bad signature", "signed by another key -> bad signature");
  const [h, p, s] = good.split(".");
  const tampered = h + "." + b64u(JSON.stringify(claims({ email: "attacker@example.com" }))) + "." + s;
  r = await V(tampered);
  check(!r.ok && r.reason === "bad signature", "tampered payload -> bad signature");
  r = await V(h + "." + p + "." + s.slice(0, -4) + "AAAA");
  check(!r.ok, "corrupted signature -> refused");
  r = await V(b64u(JSON.stringify({ alg: "none", kid: "k1" })) + "." + p + ".");
  check(!r.ok && r.reason === "unsupported alg", "alg none -> refused");
  r = await V(b64u(JSON.stringify({ alg: "HS256", kid: "k1" })) + "." + p + "." + s);
  check(!r.ok && r.reason === "unsupported alg", "alg HS256 -> refused");
  const before = certFetches;
  r = await V(await sign(kp.privateKey, { alg: "RS256", kid: "nope" }, claims()));
  check(!r.ok && r.reason === "unknown key", "unknown kid -> refused");
  await V(await sign(kp.privateKey, { alg: "RS256", kid: "nope2" }, claims()));
  check(certFetches - before <= 1, "unknown kids can't hammer the certs endpoint (<= 1 refetch/min)");
  r = await V(null);
  check(!r.ok && r.reason === "missing token", "missing header -> refused");
  r = await V("not.a.jwt!");
  check(!r.ok && r.reason === "malformed token", "garbage token -> refused");
  r = await V(good, {});
  check(!r.ok && r.reason === "access not configured", "env unset -> refused");
  r = await V(good, { ACCESS_TEAM_DOMAIN: TEAM });
  check(!r.ok && r.reason === "access not configured", "ACCESS_AUD unset -> refused");
  r = await V(good, { ACCESS_AUD: AUD });
  check(!r.ok && r.reason === "access not configured", "ACCESS_TEAM_DOMAIN unset -> refused");
  r = await V(good, { ...env, ACCESS_TEAM_DOMAIN: "https://TestTeam.cloudflareaccess.com/" });
  check(r.ok, "team domain given with https:// and a trailing slash is normalized");
  r = await V(good, { ...env, ACCESS_TEAM_DOMAIN: "evil.com/x?y" });
  check(!r.ok, "team domain that isn't a plain hostname -> refused");
  r = await V(good, { ...env, ADMIN_EMAILS: "someone@example.com, other@example.com" });
  check(!r.ok && r.reason === "email not allowed", "ADMIN_EMAILS set and email not in it -> refused");
  r = await V(good, { ...env, ADMIN_EMAILS: "Someone@example.com, OWNER@example.com" });
  check(r.ok, "ADMIN_EMAILS match is case-insensitive");
  r = await V(good, { ...env, ADMIN_EMAILS: "  someone@example.com ,  owner@example.com  ," });
  check(r.ok, "ADMIN_EMAILS entries are trimmed, empty entries ignored");
  {
    const f0 = certFetches;
    for (const [val, label] of [[undefined, "unset"], ["", "empty"], [" , ,", "only commas/spaces"], [42, "not a string"]]) {
      r = await V(good, { ...env, ADMIN_EMAILS: val });
      check(!r.ok && r.reason === "ADMIN_EMAILS not configured", `ADMIN_EMAILS ${label} -> refused, fail closed (${r.reason})`);
    }
    check(certFetches === f0, "ADMIN_EMAILS missing: refused before any certs fetch");
  }
  for (const [over, label] of [[{ email: undefined }, "no email claim"], [{ email: "" }, "empty email"], [{ email: "   " }, "blank email"], [{ email: 7 }, "non-string email"]]) {
    r = await V(await sign(kp.privateKey, { alg: "RS256", kid: "k1" }, claims(over)));
    check(!r.ok && r.reason === "no email in token", `valid signature but ${label} -> refused (${r.reason})`);
  }
  r = await V(await sign(kp.privateKey, { alg: "RS256", kid: "k1" }, claims({ email: " Owner@Example.com " })));
  check(r.ok && r.email === "owner@example.com", "token email is trimmed + lower-cased before matching");
  A._resetKeyCache();
  r = await A.verifyAccess(req(good), env, { fetch: async () => new Response("down", { status: 500 }), now: () => nowMs });
  check(!r.ok && r.reason === "certs unavailable", "certs endpoint down -> refused (fail closed)");
  A._resetKeyCache();

  /* ---------------- admin API rules (mock D1) ---------------- */
  function mockDB() {
    const db = { runs: [], batches: 0, prepare(sql) {
      const stmt = { sql, args: [], bind(...a) { stmt.args = a; return stmt; },
        run: async () => { db.runs.push({ sql, args: stmt.args }); return { meta: { changes: 1 } }; } };
      return stmt;
    }, async batch(stmts) {
      db.batches++;
      return [{ results: [{ id: 1, name: "Ada", url: null, message: "<img src=x onerror=alert(1)>", created_at: "2026-10-03 12:00:00" }] },
        { results: [{ pending: 1, approved: 2, waitlist: 3 }] }];
    } };
    return db;
  }
  // A body sent as a stream has no Content-Length (like a chunked upload).
  const streamOf = (text, chunk = 256) => new ReadableStream({
    start(c) { const b = new TextEncoder().encode(text); for (let i = 0; i < b.length; i += chunk) c.enqueue(b.slice(i, i + chunk)); c.close(); },
  });
  // origin: undefined -> same origin as `host`; null -> no Origin header; a string -> that Origin.
  const call = async (method, route, { token = good, e = {}, origin, type = "application/json", body, host = "https://dillongreen.dev", stream = false, extra = {} } = {}) => {
    const db = mockDB();
    const headers = { ...extra };
    if (origin === undefined) origin = new URL(host).origin;
    if (origin) headers.Origin = origin;
    if (type) headers["Content-Type"] = type;
    let b = method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined;
    if (b !== undefined && stream) b = streamOf(b);
    const request = req(token, host + "/api/admin/" + route, { method, headers, body: b, ...(stream ? { duplex: "half" } : {}) });
    const res = await C.handleAdmin({ request, env: { ...env, DB: db, ...e } }, opts);
    let data = null; try { data = await res.json(); } catch (x) {}
    return { status: res.status, data, db, res };
  };

  let x = await call("GET", "pending");
  check(x.status === 200 && x.data.items.length === 1 && x.data.counts.pending === 1 && x.data.who === "owner@example.com", "GET pending with a valid token -> 200 + items + counts");
  check(x.res.headers.get("Cache-Control") === "no-store" && /noindex/.test(x.res.headers.get("X-Robots-Tag")), "admin responses: no-store + X-Robots-Tag noindex");
  for (const route of ["approved", "waitlist"]) check((await call("GET", route)).status === 200, `GET ${route} -> 200`);
  check((await call("GET", "pending", { token: null })).status === 403, "no token -> 403");
  check((await call("GET", "pending", { e: { ACCESS_AUD: undefined } })).status === 403, "ACCESS_AUD unset -> 403 (fail closed)");
  check((await call("GET", "pending", { e: { ACCESS_TEAM_DOMAIN: "" } })).status === 403, "ACCESS_TEAM_DOMAIN unset -> 403 (fail closed)");
  check((await call("GET", "nope")).status === 404, "unknown route -> 404 (after auth)");
  check((await call("GET", "nope", { token: null })).status === 403, "unknown route without auth -> 403, nothing leaks");

  x = await call("POST", "approve", { body: { id: 5 } });
  check(x.status === 200 && x.data.changed === 1 && x.db.runs[0].args[0] === 5 && /\?1/.test(x.db.runs[0].sql) && /status = 'pending'/.test(x.db.runs[0].sql), "POST approve {id:5} -> parameterized UPDATE");
  x = await call("POST", "delete-guestbook", { body: { id: 6 } });
  check(x.status === 200 && /^DELETE FROM guestbook WHERE id = \?1$/.test(x.db.runs[0].sql) && x.db.runs[0].args[0] === 6, "POST delete-guestbook -> parameterized DELETE");
  x = await call("POST", "delete-waitlist", { body: { id: 7 } });
  check(x.status === 200 && /^DELETE FROM waitlist WHERE id = \?1$/.test(x.db.runs[0].sql), "POST delete-waitlist -> parameterized DELETE");
  for (const bad of [0, -1, 1.5, "5", "5; DROP TABLE guestbook", null, 1e20, [5], { id: 5 }]) {
    x = await call("POST", "approve", { body: { id: bad } });
    check(x.status === 400 && x.db.runs.length === 0, `id ${JSON.stringify(bad)} -> 400, no SQL run`);
  }
  x = await call("POST", "approve", { body: "{not json" });
  check(x.status === 400 && x.db.runs.length === 0, "malformed JSON -> 400");
  x = await call("POST", "approve", { body: { id: 5 }, origin: null });
  check(x.status === 403 && x.db.runs.length === 0, "POST without Origin -> 403");
  x = await call("POST", "approve", { body: { id: 5 }, origin: "https://evil.example" });
  check(x.status === 403 && x.db.runs.length === 0, "POST cross-origin -> 403");
  x = await call("POST", "approve", { body: { id: 5 }, origin: "http://dillongreen.dev" });
  check(x.status === 403, "POST from http:// origin (scheme mismatch) -> 403");
  x = await call("POST", "approve", { body: "id=5", type: "application/x-www-form-urlencoded" });
  check(x.status === 415 && x.db.runs.length === 0, "POST form-encoded -> 415");
  x = await call("POST", "approve", { body: { id: 5 }, token: null });
  check(x.status === 403 && x.db.runs.length === 0, "POST without token -> 403");
  x = await call("PUT", "approve", { body: { id: 5 } });
  check(x.status === 405, "PUT -> 405");
  x = await call("POST", "pending", { body: { id: 5 } });
  check(x.status === 404, "POST to a GET route -> 404");
  check((await call("GET", "pending", { e: { ADMIN_EMAILS: undefined } })).status === 403, "ADMIN_EMAILS unset -> 403 even with a valid token (fail closed)");
  {
    const noMail = await sign(kp.privateKey, { alg: "RS256", kid: "k1" }, claims({ email: undefined }));
    check((await call("GET", "pending", { token: noMail })).status === 403, "valid token without an email claim -> 403");
  }

  /* ---------------- prototype-ish route names are just unknown routes ---------------- */
  for (const route of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    const g = await call("GET", route), p = await call("POST", route, { body: { id: 1 } });
    check(g.status === 404 && p.status === 404 && g.db.batches === 0 && p.db.runs.length === 0, `"${route}" -> 404 for GET and POST, no SQL (was a 500)`);
  }

  /* ---------------- 1 KB body cap, streamed ---------------- */
  x = await call("POST", "approve", { body: { id: 5, pad: "x".repeat(2000) } });
  check(x.status === 400 && x.db.runs.length === 0, "POST body over 1 KB -> 400, no SQL");
  x = await call("POST", "approve", { body: { id: 5, pad: "x".repeat(2000) }, stream: true });
  check(x.status === 400 && x.db.runs.length === 0, "chunked POST over 1 KB without Content-Length -> 400, no SQL");
  x = await call("POST", "approve", { body: { id: 9 }, stream: true });
  check(x.status === 200 && x.db.runs[0].args[0] === 9, "small chunked POST (no Content-Length) still works");
  x = await call("POST", "approve", { body: { id: 9 }, extra: { "Content-Length": "5000" } });
  check(x.status === 400 && x.db.runs.length === 0, "declared Content-Length over 1 KB -> 400 without reading");
  {
    let pulled = 0;
    const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(512).fill(32)); } }); // never ends
    const request = req(good, "https://dillongreen.dev/api/admin/approve", { method: "POST", headers: { Origin: "https://dillongreen.dev", "Content-Type": "application/json" }, body: endless, duplex: "half" });
    const res = await C.handleAdmin({ request, env: { ...env, DB: mockDB() } }, opts);
    check(res.status === 400 && pulled <= 4, `endless chunked body: stops reading at the cap and answers 400 (${pulled} chunks pulled)`);
  }

  /* ---------------- host allow-list: the API only exists where Access sits in front ---------------- */
  x = await call("GET", "pending", { host: "https://www.dillongreen.dev" });
  check(x.status === 200, "www.dillongreen.dev with a valid token -> 200");
  x = await call("POST", "approve", { host: "https://www.dillongreen.dev", body: { id: 3 } });
  check(x.status === 200 && x.db.runs[0].args[0] === 3, "www.dillongreen.dev POST (same-origin) -> 200");
  for (const host of ["https://dillongreen.pages.dev", "https://3f2a9c1d.dillongreen.pages.dev", "https://preview.dillongreen.pages.dev", "https://evil.example", "https://dillongreen.dev.evil.example", "http://127.0.0.1:8791"]) {
    const f0 = certFetches;
    x = await call("GET", "pending", { host });
    const y = await call("POST", "approve", { host, body: { id: 1 } });
    check(x.status === 404 && y.status === 404 && x.db.batches === 0 && y.db.runs.length === 0 && certFetches === f0,
      `${new URL(host).host}: even a VALID token gets 404, no SQL, no certs fetch`);
  }
  x = await call("GET", "pending", { host: "https://dillongreen.pages.dev", token: null });
  check(x.status === 404 && x.data && x.data.error === "not found", "dillongreen.pages.dev without a token -> plain 404");

  /* ---------------- dev bypass (local only) ---------------- */
  const DEV = { DEV_ADMIN_BYPASS: "1", ACCESS_AUD: undefined, ACCESS_TEAM_DOMAIN: undefined, ADMIN_EMAILS: undefined };
  x = await call("GET", "pending", { token: null, e: DEV, host: "http://127.0.0.1:8791" });
  check(x.status === 200 && x.data.who === "local-dev", "bypass works on 127.0.0.1 with DEV_ADMIN_BYPASS=1");
  x = await call("GET", "pending", { token: null, e: DEV, host: "http://localhost:8791" });
  check(x.status === 200, "bypass works on localhost");
  x = await call("GET", "pending", { token: null, e: DEV });
  check(x.status === 403, "bypass is ignored on dillongreen.dev even with DEV_ADMIN_BYPASS=1");
  x = await call("GET", "pending", { token: null, e: { ...DEV }, host: "https://dillongreen.pages.dev" });
  check(x.status === 404, "bypass is ignored on *.pages.dev (not an admin host: 404)");
  x = await call("GET", "pending", { token: null, e: { DEV_ADMIN_BYPASS: "true", ACCESS_AUD: undefined }, host: "http://127.0.0.1:8791" });
  check(x.status === 404, "bypass needs exactly \"1\" (otherwise 127.0.0.1 isn't an admin host: 404)");
  x = await call("GET", "pending", { token: null, e: { ACCESS_AUD: undefined }, host: "http://127.0.0.1:8791" });
  check(x.status === 404, "localhost without the bypass var -> 404");
  x = await call("POST", "approve", { token: null, e: DEV, host: "http://127.0.0.1:8791", origin: "https://evil.example", body: { id: 1 } });
  check(x.status === 403, "bypass still enforces same-origin on POST");
  x = await call("POST", "approve", { token: null, e: DEV, host: "http://127.0.0.1:8791", body: { id: 1, pad: "x".repeat(2000) }, stream: true });
  check(x.status === 400, "bypass still enforces the 1 KB body cap");
  check(C.ADMIN_HOSTS instanceof Set && C.ADMIN_HOSTS.size === 2 && C.ADMIN_HOSTS.has("dillongreen.dev") && C.ADMIN_HOSTS.has("www.dillongreen.dev"), "ADMIN_HOSTS is exactly dillongreen.dev + www.dillongreen.dev");

  const fs = require("fs");
  const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
  check(!/DEV_ADMIN_BYPASS\s*=/m.test(toml.replace(/^\s*#.*$/gm, "")), "wrangler.toml never sets DEV_ADMIN_BYPASS");

  console.log(fails ? `\n${fails} FAILED` : "\nall access/admin tests passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
