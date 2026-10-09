// dg-notify Worker: emails the site owner when someone signs the guestbook or joins the studio waitlist.
// Reachable only through the NOTIFY service binding of the dillongreen Pages project
// (workers_dev = false, no routes), and every request must also carry X-Notify-Key == NOTIFY_KEY.
// Secrets (never in the repo): NOTIFY_KEY, NOTIFY_TO (a verified Email Routing destination address).
import { EmailMessage } from "cloudflare:email";
import { handleNotify } from "./lib.js";

export default {
  fetch(request, env) {
    return handleNotify(request, env, { EmailMessage });
  },
};
