// Fire-and-forget owner alert through the NOTIFY service binding (the dg-notify Worker in workers/notify).
// Never affects the visitor's response: it runs in waitUntil, every error is caught and logged,
// and it is skipped silently when the binding or the NOTIFY_KEY secret isn't configured.
// This module exports no onRequest* handler, so it never becomes a route of its own.

export function notifyOwner(context, payload) {
  try {
    const env = context && context.env;
    if (!env || !env.NOTIFY || typeof env.NOTIFY.fetch !== "function" || !env.NOTIFY_KEY) return false;
    if (typeof context.waitUntil !== "function") return false;
    const send = Promise.resolve()
      .then(() => env.NOTIFY.fetch("https://dg-notify.internal/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Notify-Key": String(env.NOTIFY_KEY) },
        body: JSON.stringify(payload),
      }))
      .then((res) => { if (!res || !res.ok) console.error("notify: dg-notify answered", res && res.status); })
      .catch((e) => console.error("notify failed", e && e.message));
    context.waitUntil(send);
    return true;
  } catch (e) {
    console.error("notify skipped", e && e.message);
    return false;
  }
}

/** D1 run() result -> the new row id, or undefined. */
export function lastRowId(result) {
  const id = result && result.meta && Number(result.meta.last_row_id);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
