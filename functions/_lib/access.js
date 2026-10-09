// Cloudflare Access JWT verification for /api/admin/* (fail closed).
// Access puts a signed JWT in the Cf-Access-Jwt-Assertion header of every request it lets through.
// We verify it ourselves (RS256, WebCrypto) so the API stays locked even if the Access application
// were misconfigured or removed:
//   * env.ACCESS_TEAM_DOMAIN  e.g. "yourteam.cloudflareaccess.com"   (required)
//   * env.ACCESS_AUD          the Access application's Audience (AUD) tag (required)
//   * env.ADMIN_EMAILS        comma-separated allow-list (required), matched case-insensitively against
//                             the token's email; a token without an email claim is always refused
// Keys come from https://<team>/cdn-cgi/access/certs and are cached per isolate for an hour
// (re-fetched early, at most once a minute, when a token names an unknown key id).
// This module exports no onRequest* handler, so it never becomes a route of its own.

const KEY_TTL_MS = 60 * 60 * 1000;
const REFETCH_MIN_MS = 60 * 1000;
const SKEW_S = 60;
const keyCache = new Map(); // team -> { at, keys: Map(kid -> CryptoKey) }

export function _resetKeyCache() { keyCache.clear(); }

function b64urlBytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** "https://Team.cloudflareaccess.com/" -> "team.cloudflareaccess.com"; null if it isn't a plain hostname. */
export function teamHost(value) {
  if (typeof value !== "string") return null;
  const h = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h) ? h : null;
}

async function loadKeys(team, fetchImpl, force, nowMs) {
  const hit = keyCache.get(team);
  if (hit && !force && nowMs - hit.at < KEY_TTL_MS) return hit.keys;
  if (hit && force && nowMs - hit.at < REFETCH_MIN_MS) return hit.keys; // don't let bad kids hammer the endpoint
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("certs fetch " + res.status);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of (body && Array.isArray(body.keys) ? body.keys : [])) {
    if (!jwk || jwk.kty !== "RSA" || !jwk.kid || (jwk.alg && jwk.alg !== "RS256")) continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      keys.set(jwk.kid, key);
    } catch (e) { /* skip unusable key */ }
  }
  keyCache.set(team, { at: nowMs, keys });
  return keys;
}

/**
 * Verify the Access JWT on `request`. Resolves { ok: true, email, sub } or { ok: false, reason }.
 * opts (tests): fetch, now (ms).
 */
export async function verifyAccess(request, env, opts = {}) {
  const fetchImpl = opts.fetch || ((...a) => fetch(...a));
  const nowMs = (opts.now || Date.now)();
  const team = teamHost(env && env.ACCESS_TEAM_DOMAIN);
  const aud = env && typeof env.ACCESS_AUD === "string" ? env.ACCESS_AUD.trim() : "";
  if (!team || !aud) return { ok: false, reason: "access not configured" };
  const allow = adminEmails(env);
  if (!allow.length) return { ok: false, reason: "ADMIN_EMAILS not configured" };

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, reason: "missing token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };

  let header, payload, sig;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
    sig = b64urlBytes(parts[2]);
  } catch (e) { return { ok: false, reason: "malformed token" }; }
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "unsupported alg" };
  if (!payload || typeof payload !== "object") return { ok: false, reason: "malformed token" };

  let key;
  try {
    let keys = await loadKeys(team, fetchImpl, false, nowMs);
    key = keys.get(header.kid);
    if (!key) { keys = await loadKeys(team, fetchImpl, true, nowMs); key = keys.get(header.kid); }
  } catch (e) { return { ok: false, reason: "certs unavailable" }; }
  if (!key) return { ok: false, reason: "unknown key" };

  let valid = false;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch (e) { valid = false; }
  if (!valid) return { ok: false, reason: "bad signature" };

  const now = Math.floor(nowMs / 1000);
  if (payload.iss !== "https://" + team) return { ok: false, reason: "wrong issuer" };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { ok: false, reason: "wrong audience" };
  if (typeof payload.exp !== "number" || payload.exp <= now - SKEW_S) return { ok: false, reason: "expired" };
  if (payload.nbf != null && (typeof payload.nbf !== "number" || payload.nbf > now + SKEW_S)) return { ok: false, reason: "not yet valid" };
  if (payload.iat != null && typeof payload.iat === "number" && payload.iat > now + SKEW_S) return { ok: false, reason: "issued in the future" };

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) return { ok: false, reason: "no email in token" };
  if (!allow.includes(email)) return { ok: false, reason: "email not allowed" };
  return { ok: true, email, sub: typeof payload.sub === "string" ? payload.sub : "" };
}

/** env.ADMIN_EMAILS -> lower-cased, trimmed, non-empty addresses. */
export function adminEmails(env) {
  const raw = env && typeof env.ADMIN_EMAILS === "string" ? env.ADMIN_EMAILS : "";
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
