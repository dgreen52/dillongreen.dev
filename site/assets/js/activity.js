// "Latest from the workshop" on /now/: the owner's recent public GitHub activity from GET /api/activity
// (functions/_lib/activity-core.js caches it for 30 minutes). Renders into [data-activity]:
//   [PUSH] linework                     2d ago
//          Add DGN cell header reader
// Text goes in with textContent only; links are only ever https://github.com/... (checked again here).
// The box reserves its height in CSS (6 fixed rows), so loading, empty, offline and full all take the
// same space. The last good list is kept in localStorage (a per-browser convenience) and shown, marked
// as such, when the feed can't be reached.
(function () {
  "use strict";
  var host = document.querySelector("[data-activity]");
  if (!host) return;
  var foot = document.querySelector("[data-activity-foot]");
  var API = "/api/activity";
  var SHOW = 6;
  var KEY = "dg-activity";
  var LABEL = { push: "Push", create: "New repo", release: "Release" };
  var PROFILE = "https://github.com/dgreen52";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var store = {
    get: function () { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } },
    set: function (v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* storage blocked: fine */ } }
  };

  function safeUrl(u) {
    try {
      var x = new URL(String(u));
      return x.protocol === "https:" && x.hostname === "github.com" && !x.username && !x.password ? x.href : null;
    } catch (e) { return null; }
  }
  // Accept only the expected shape; anything else counts as a failed load.
  function valid(list) {
    if (!Array.isArray(list)) return null;
    var out = [];
    for (var i = 0; i < list.length && out.length < SHOW; i++) {
      var it = list[i];
      if (!it || !LABEL.hasOwnProperty(it.type) || typeof it.repo !== "string" || typeof it.message !== "string") continue;
      var t = Date.parse(it.date);
      if (!isFinite(t)) continue;
      out.push({ type: it.type, repo: it.repo.slice(0, 100), message: it.message.slice(0, 120), url: safeUrl(it.url), t: t });
    }
    return out;
  }

  function ago(t) {
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    if (s < 7 * 86400) return Math.round(s / 86400) + "d ago";
    var d = new Date(t), opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  }
  function full(t) {
    return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function skeleton() {
    host.textContent = "";
    host.setAttribute("aria-busy", "true");
    var ul = el("ul", "ws-list");
    ul.setAttribute("aria-hidden", "true");
    for (var i = 0; i < SHOW; i++) {
      var li = el("li"), row = el("div", "ws-item is-skel"), l1 = el("span", "ws-l1");
      l1.appendChild(el("span", "ws-kind", "-"));
      l1.appendChild(el("span", "ws-repo", "-"));
      row.appendChild(l1);
      row.appendChild(el("span", "ws-l2", "-"));
      li.appendChild(row);
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }

  function render(items) {
    host.textContent = "";
    host.removeAttribute("aria-busy");
    var ul = el("ul", "ws-list");
    items.forEach(function (it) {
      var li = el("li");
      var row = el(it.url ? "a" : "div", "ws-item");
      if (it.url) { row.href = it.url; row.rel = "noopener"; }
      var l1 = el("span", "ws-l1");
      l1.appendChild(el("span", "ws-kind " + it.type, LABEL[it.type]));
      l1.appendChild(el("span", "ws-repo", it.repo));
      var when = el("time", "ws-when", ago(it.t));
      when.setAttribute("datetime", new Date(it.t).toISOString());
      when.title = full(it.t);
      l1.appendChild(when);
      row.appendChild(l1);
      var l2 = el("span", "ws-l2", it.message);
      l2.title = it.message;
      row.appendChild(l2);
      li.appendChild(row);
      ul.appendChild(li);
    });
    host.appendChild(ul);
  }

  // empty feed / unreachable feed: one calm message in the same reserved box
  function message(title, body, linkText) {
    host.textContent = "";
    host.removeAttribute("aria-busy");
    var box = el("div", "ws-msg");
    box.appendChild(el("b", null, title));
    var p = el("span", null, body);
    if (linkText) {
      var a = el("a", null, linkText);
      a.href = PROFILE; a.rel = "noopener";
      p.appendChild(document.createTextNode(" "));
      p.appendChild(a);
      p.appendChild(document.createTextNode("."));
    }
    box.appendChild(p);
    host.appendChild(box);
  }
  function setFoot(text) { if (foot) foot.textContent = text; }

  function show(items, fetchedAt, stale, fromCopy) {
    if (!items.length) {
      message("Quiet week in the workshop", "Nothing public on GitHub lately. The good stuff is probably still on the bench; everything else is on", "github.com/dgreen52");
    } else {
      render(items);
    }
    var when = isFinite(fetchedAt) ? ago(fetchedAt) : "";
    if (fromCopy) setFoot("Offline · showing the list from " + (when || "your last visit"));
    else if (stale) setFoot("GitHub isn't answering · showing the last good copy" + (when ? ", from " + when : ""));
    else setFoot("Public GitHub activity · updated " + (when || "just now"));
  }

  function fallback() {
    var copy = store.get();
    var items = copy && valid(copy.items);
    if (items) { show(items, Number(copy.at), false, true); return; }
    var offline = navigator.onLine === false;
    message(offline ? "You're offline" : "The feed is taking a break",
      offline ? "The workshop feed will be back when you are. Meanwhile, everything lives on" : "Couldn't reach it just now. Everything lives on", "github.com/dgreen52");
    setFoot("Public GitHub activity · not available right now");
  }

  function load() {
    fetch(API, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var items = j && j.ok === true ? valid(j.items) : null;
        if (!items) throw new Error("no feed");
        var at = Date.parse(j.fetched_at);
        store.set({ at: isFinite(at) ? at : Date.now(), items: j.items.slice(0, SHOW) });
        show(items, at, !!j.stale, false);
      })
      .catch(fallback);
  }

  skeleton();
  var idle = function () {
    if ("requestIdleCallback" in window) window.requestIdleCallback(load, { timeout: 2000 });
    else setTimeout(load, 400);
  };
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
})();
