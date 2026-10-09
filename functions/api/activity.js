// /api/activity (GET only; other methods get 405 from Pages)
//   -> { ok, stale, fetched_at, items: [{ repo, type: "push"|"create"|"release", message, url, date }] }  (max 8, newest first)
//   -> 503 { ok: false, items: [] } only if GitHub has never answered and there's no stored copy.
// The owner's public GitHub activity for the /now/ page's "Latest from the workshop" list. Reducer, caching
// (30 min, stale-while-error) and the optional GITHUB_TOKEN live in ../_lib/activity-core.js.
// No request input is used.
import { activityResponse } from "../_lib/activity-core.js";

export function onRequestGet(context) {
  return activityResponse(context);
}
