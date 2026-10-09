// /api/admin/* — moderation API for /admin/. Locked behind Cloudflare Access; the JWT is verified
// here too (fail closed). Logic: ../../_lib/admin-core.js, JWT checks: ../../_lib/access.js.
import { handleAdmin } from "../../_lib/admin-core.js";

export function onRequest(context) {
  return handleAdmin(context);
}
