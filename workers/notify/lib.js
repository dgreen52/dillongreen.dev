// dg-notify: plain-text owner alerts for new guestbook signatures and studio waitlist entries.
// Pure logic (no "cloudflare:email" import) so tools/test-notify.js can run it in Node.
// index.js wires it to the real EmailMessage class and the MAIL (send_email) binding.

export const FROM_ADDR = "notify@dillongreen.dev";
export const FROM_NAME = "dillongreen.dev";
export const MSGID_DOMAIN = "dillongreen.dev";
export const ADMIN_URL = "https://dillongreen.dev/admin/";
const MAX_BODY_BYTES = 16 * 1024;

// C0/C1 controls, DEL, bidi overrides/isolates, line/paragraph separators, BOM.
const HEADER_BAD = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029\uFEFF]/g;
const BODY_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029\uFEFF]/g;
// Invisible characters removed outright: Arabic letter mark, zero-width space, word joiner and the
// unassigned/deprecated start of the tag block. ZWNJ/ZWJ (U+200C/D) and the tag characters
// U+E0020-E007F stay: emoji sequences (family, rainbow flag, England/Scotland flags) need them.
const INVISIBLE = /[\u061C\u200B\u2060\u{E0000}-\u{E001F}]/gu;
// Strict ASCII address (used for To and the optional Reply-To). Anything else is refused / dropped.
const ADDR = /^[A-Za-z0-9.!#%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function cap(s, max) {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, Math.max(0, max - 1)).join("") + "…" : s;
}

/** One-line header-safe text: no CR/LF or other controls, whitespace collapsed, capped (code points). */
export function headerSafe(value, max = 80) {
  const s = String(value == null ? "" : value).normalize("NFC").replace(INVISIBLE, "").replace(HEADER_BAD, " ").replace(/\s+/g, " ").trim();
  return cap(s, max);
}

/** Multi-line body text: LF newlines, no other controls, tabs -> spaces, capped (code points). */
export function bodySafe(value, max = 2000) {
  const s = String(value == null ? "" : value).normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, "  ")
    .replace(INVISIBLE, "").replace(BODY_BAD, "").replace(/\n{3,}/g, "\n\n").trim();
  return cap(s, max);
}

export const isAddress = (s) => typeof s === "string" && s.length <= 254 && ADDR.test(s);

/** RFC 2047 encoded-words (UTF-8, base64) when needed; each word <= 75 chars, folded with CRLF SP. */
export function encodeHeaderText(s) {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const enc = new TextEncoder();
  const words = [];
  let chunk = "";
  for (const ch of Array.from(s)) {
    if (enc.encode(chunk + ch).length > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => "=?UTF-8?B?" + b64(enc.encode(w)) + "?=").join("\r\n ");
}

function b64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** RFC 5322 date-time in UTC, e.g. "Sat, 03 Oct 2026 14:05:09 +0000". */
export function rfc5322Date(d) {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** Soft-wrap one paragraph at `width` code points; long words are hard-split (keeps 8bit lines < 998 octets). */
function wrap(line, width = 76) {
  if (Array.from(line).length <= width) return [line];
  const out = [];
  let cur = "";
  for (const word of line.split(" ")) {
    let w = word;
    while (Array.from(w).length > width) {
      if (cur) { out.push(cur); cur = ""; }
      const cps = Array.from(w);
      out.push(cps.slice(0, width).join(""));
      w = cps.slice(width).join("");
    }
    const next = cur ? cur + " " + w : w;
    if (Array.from(next).length > width) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

function bodyLines(text) {
  return text.split("\n").flatMap((l) => wrap(l.replace(/\s+$/, "")));
}

const ROLE_LABEL = {
  "amp-avionics": "A&P / avionics tech", sim: "Sim tech / engineer", "flight-school": "Flight school",
  mro: "MRO / repair station", operator: "Operator / airline", student: "Student", other: "Other",
};
const ORG_SIZES = ["1", "2-10", "11-50", "51-200", "201+"];
const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

// Everything a visitor typed goes below this line, so a message dressed up as a system notice
// ("your session expired, sign in at ...") can't pass for something the site itself wrote.
export const VISITOR_START = "--- visitor-supplied text below (not from dillongreen.dev) ---";
export const VISITOR_END = "--- end of visitor-supplied text ---";

// Link-looking text: scheme URLs, www. hosts and bare domains (host.tld[:port][/path]).
const LINKISH = /\b(?:[a-z][a-z0-9+.-]{0,20}:\/\/|www\.)[^\s<>"']+|\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z][a-z0-9-]{0,61}[a-z0-9]\b(?:[:/?#][^\s<>"']*)?/gi;

/**
 * Defang links in visitor-supplied text so mail clients don't make them clickable:
 * "https://evil.example/x" -> "hxxps://evil[.]example/x", "example.com" -> "example[.]com".
 */
export function defang(value) {
  return String(value == null ? "" : value).replace(LINKISH, (t) =>
    t.replace(/^htt(?=ps?:\/\/)/i, "hxx").replace(/^ftp(?=s?:\/\/)/i, "fxp").replace(/\./g, "[.]"));
}

/** Validate + summarize the POSTed JSON. Returns { subject, text, replyTo? } or null if unusable. */
export function compose(data) {
  if (!data || typeof data !== "object") return null;
  const id = Number.isSafeInteger(data.id) && data.id > 0 ? `#${data.id}` : "(new)";
  if (data.type === "guestbook") {
    const name = defang(headerSafe(data.name, 40)) || "(no name)";
    const site = defang(headerSafe(data.url, 80));
    const message = defang(bodySafe(data.message, 600));
    return {
      subject: `[guestbook] New signature from ${name}`,
      text: [
        "New guestbook signature, waiting for approval.",
        `Entry:    ${id}`,
        `Approve or delete: ${ADMIN_URL}`,
        "",
        VISITOR_START,
        `Name:     ${name}`,
        `Site:     ${site || "-"}`,
        "",
        "Message:",
        message || "(empty)",
        VISITOR_END,
      ].join("\n"),
    };
  }
  if (data.type === "waitlist") {
    const roleCode = headerSafe(data.role, 40);
    const role = own(ROLE_LABEL, roleCode) ? ROLE_LABEL[roleCode] : "unknown";
    const orgSize = headerSafe(data.org_size, 20);
    const email = headerSafe(data.email, 254).toLowerCase();
    const workflow = defang(bodySafe(data.workflow, 1200));
    const notify = data.notify === true || data.notify === 1 || data.notify === "1";
    return {
      subject: `[studio] New waitlist entry (${role})`,
      replyTo: isAddress(email) ? email : undefined,
      text: [
        "New studio waitlist entry.",
        `Entry:    ${id}`,
        `Role:     ${role}`,
        `Org size: ${ORG_SIZES.includes(orgSize) ? orgSize : "-"}`,
        `Notify:   ${notify ? "yes, wants launch news" : "no"}`,
        isAddress(email) ? "Reply to this email to answer them directly (Reply-To is their address)." : null,
        `Manage the list: ${ADMIN_URL}`,
        "",
        VISITOR_START,
        `Email:    ${defang(email) || "-"}`,
        "",
        "Workflow:",
        workflow || "(left blank)",
        VISITOR_END,
      ].filter((l) => l !== null).join("\n"),
    };
  }
  return null;
}

/** Full RFC 5322 message (CRLF line endings, 8bit UTF-8 plain text). */
export function buildMime({ to, subject, text, replyTo, date = new Date(), messageId }) {
  if (!isAddress(to)) throw new Error("invalid To address");
  const id = messageId || `${(globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2))}@${MSGID_DOMAIN}`;
  const headers = [
    `From: "${FROM_NAME}" <${FROM_ADDR}>`,
    `To: <${to}>`,
  ];
  if (replyTo && isAddress(replyTo)) headers.push(`Reply-To: <${replyTo}>`);
  headers.push(
    `Subject: ${encodeHeaderText(headerSafe(subject, 120))}`,
    `Date: ${rfc5322Date(date)}`,
    `Message-ID: <${id.replace(/[<>\s]/g, "")}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
  );
  return headers.join("\r\n") + "\r\n\r\n" + bodyLines(bodySafe(text, 4000)).join("\r\n") + "\r\n";
}

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

const reply = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

/** The Worker's fetch handler. deps.EmailMessage is the class from "cloudflare:email". */
export async function handleNotify(request, env, deps) {
  if (request.method !== "POST") return reply(405, { ok: false, error: "method" });
  // Fail closed: without both secrets and the binding nothing is ever sent.
  if (!env || !env.NOTIFY_KEY || !env.NOTIFY_TO || !env.MAIL) return reply(503, { ok: false, error: "not configured" });
  const key = request.headers.get("X-Notify-Key") || "";
  if (!key || !(await sameSecret(key, String(env.NOTIFY_KEY)))) return reply(401, { ok: false, error: "unauthorized" });
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return reply(415, { ok: false, error: "json only" });

  let data;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return reply(413, { ok: false, error: "too large" });
    data = JSON.parse(raw);
  } catch (e) { return reply(400, { ok: false, error: "bad json" }); }
  const msg = compose(data);
  if (!msg) return reply(400, { ok: false, error: "unknown type" });

  const to = String(env.NOTIFY_TO).trim();
  if (!isAddress(to)) { console.error("NOTIFY_TO is not a plain address"); return reply(500, { ok: false, error: "config" }); }
  try {
    const raw = buildMime({ to, subject: msg.subject, text: msg.text, replyTo: msg.replyTo });
    await env.MAIL.send(new deps.EmailMessage(FROM_ADDR, to, raw));
    return reply(202, { ok: true });
  } catch (e) {
    console.error("notify send failed", e && e.message);
    return reply(502, { ok: false, error: "send failed" });
  }
}
