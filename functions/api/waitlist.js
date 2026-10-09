// /api/waitlist (POST only; any other method gets 405 from Pages, so the list is never readable here)
//   { email, role, org_size?, workflow?, notify?, fax (honeypot) }
import {
  json, MSG, clean, charLen, countUrls, readJson, sameOrigin, trippedHoneypot, ipHash,
  capClause, inserted, ownLimitHit, purgeOldHashes,
} from "../_lib/forms.js";
import { notifyOwner, lastRowId } from "../_lib/notify.js";

// Rate limit + insert in ONE statement (atomic in D1): see capClause in ../_lib/forms.js.
const INSERT = "INSERT INTO waitlist (email, role, org_size, workflow, notify, ip_hash) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE " +
  capClause("waitlist", "?6");

const ROLES = ["amp-avionics", "sim", "flight-school", "mro", "operator", "student", "other"];
const ORG_SIZES = ["1", "2-10", "11-50", "51-200", "201+"];
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;
const THANKS = "Got it, thank you. I read every one of these.";

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!sameOrigin(request)) return json(403, { ok: false, error: MSG.badRequest });
  const data = await readJson(request);
  if (!data) return json(400, { ok: false, error: MSG.badRequest });
  if (trippedHoneypot(data)) return json(200, { ok: true, message: THANKS });

  const email = clean(data.email, false).toLowerCase();
  const role = clean(data.role, false);
  const orgSize = clean(data.org_size, false);
  const workflow = clean(data.workflow, true);
  const notify = data.notify === true || data.notify === "on" ? 1 : 0;

  if (!email || charLen(email) > 254 || !EMAIL.test(email)) {
    return json(400, { ok: false, field: "email", error: "Please check your email address." });
  }
  if (!ROLES.includes(role)) return json(400, { ok: false, field: "role", error: "Please pick the role closest to yours." });
  if (orgSize && !ORG_SIZES.includes(orgSize)) return json(400, { ok: false, field: "org_size", error: "Please pick an organization size from the list." });
  if (charLen(workflow) > 1000) return json(400, { ok: false, field: "workflow", error: "That's a great amount of detail, but please keep it under 1,000 characters." });
  if (countUrls(workflow) > 1) return json(400, { ok: false, field: "workflow", error: "One link at most in the workflow answer, please." });

  if (!env.DB) return json(503, { ok: false, error: MSG.offline });
  try {
    const hash = await ipHash(request, env);
    if (!hash) {
      console.error("waitlist POST refused: IP_SALT is not set");
      return json(503, { ok: false, error: MSG.offline });
    }
    const ins = await env.DB.prepare(INSERT).bind(email, role, orgSize || null, workflow || null, notify, hash).run();
    if (!inserted(ins)) {
      const own = await ownLimitHit(env.DB, "waitlist", hash);
      return json(429, { ok: false, error: own ? "You've sent a few already. Try again in an hour." : MSG.busy });
    }
    await purgeOldHashes(env.DB, "waitlist");
    // Owner email alert with what's needed to reply (fire-and-forget, never changes this reply). No ip_hash.
    notifyOwner(context, { type: "waitlist", id: lastRowId(ins), email, role, org_size: orgSize || "", notify: notify === 1, workflow: workflow || "" });
    return json(201, { ok: true, message: THANKS });
  } catch (e) {
    console.error("waitlist POST failed", e && e.message);
    return json(500, { ok: false, error: MSG.offline });
  }
}
