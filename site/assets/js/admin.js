// /admin/ moderation console. Talks to /api/admin/* (Cloudflare Access protected, JWT verified server-side).
// Everything people typed is rendered with textContent only. Approve is instant; delete removes the card
// right away and is sent after a short Undo window (or immediately if the page is being left).
(function () {
  "use strict";
  var API = "/api/admin/";
  var UNDO_MS = 4000;
  var ROLE = {
    "amp-avionics": "A&P / avionics", sim: "Sim tech", "flight-school": "Flight school",
    mro: "MRO / repair", operator: "Operator / airline", student: "Student", other: "Other",
  };
  var EMAIL_OK = /^[^\s@<>()[\]\\,;:"?&#%]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

  var panel = document.getElementById("panel");
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-tab]"));
  var toastEl = document.querySelector("[data-toast]");
  var whoEl = document.querySelector("[data-who]");
  var current = "pending";
  var counts = { pending: 0, approved: 0, waitlist: 0 };
  var pendingDeletes = []; // { action, id, timer, restore }
  var loadSeq = 0;
  var toastTimer = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function when(s) {
    if (!s) return "";
    var d = new Date(String(s).replace(" ", "T") + "Z");
    if (isNaN(d)) return String(s);
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function api(path, body, keepalive) {
    var init = { headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store" };
    if (body) {
      init.method = "POST";
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
      if (keepalive) init.keepalive = true;
    }
    return fetch(API + path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j || j.ok !== true) { var e = new Error((j && j.error) || "HTTP " + r.status); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function setCounts(c) {
    if (c) counts = { pending: +c.pending || 0, approved: +c.approved || 0, waitlist: +c.waitlist || 0 };
    Object.keys(counts).forEach(function (k) {
      var n = document.querySelector('[data-count="' + k + '"]');
      if (!n) return;
      n.textContent = String(counts[k]);
      n.classList.toggle("has", k === "pending" && counts[k] > 0);
    });
  }

  function toast(text, opts) {
    opts = opts || {};
    clearTimeout(toastTimer);
    toastEl.textContent = "";
    toastEl.classList.toggle("is-error", !!opts.error);
    toastEl.appendChild(el("span", null, text));
    if (opts.undo) {
      var b = el("button", "adm-btn", "Undo");
      b.type = "button";
      b.addEventListener("click", function () { opts.undo(); hideToast(); });
      toastEl.appendChild(b);
    }
    toastEl.hidden = false;
    toastTimer = setTimeout(hideToast, opts.ms || 3500);
  }
  function hideToast() { toastEl.hidden = true; toastEl.textContent = ""; }

  function empty(title, text) {
    panel.textContent = "";
    var p = el("p", "adm-empty");
    if (title) p.appendChild(el("b", null, title));
    p.appendChild(document.createTextNode(text));
    panel.appendChild(p);
  }

  function btn(label, cls, onClick) {
    var b = el("button", "adm-btn " + cls, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function guestCard(item, list) {
    var li = el("li", "adm-card");
    li.setAttribute("data-id", String(item.id));
    var meta = el("p", "adm-meta");
    meta.appendChild(el("span", null, "#" + item.id));
    meta.appendChild(el("span", null, when(item.created_at)));
    li.appendChild(meta);
    li.appendChild(el("h2", "adm-name", item.name || "(no name)"));
    if (item.url) li.appendChild(el("p", "adm-site", item.url)); // plain text, never a link
    li.appendChild(el("p", "adm-msg", item.message || ""));
    var act = el("div", "adm-act");
    if (list === "pending") act.appendChild(btn("Approve", "adm-btn-ok", function () { approve(item, li); }));
    act.appendChild(btn("Delete", "adm-btn-del", function () { remove("delete-guestbook", item, li, list); }));
    li.appendChild(act);
    return li;
  }

  function waitCard(item) {
    var li = el("li", "adm-card");
    li.setAttribute("data-id", String(item.id));
    var meta = el("p", "adm-meta");
    meta.appendChild(el("span", null, "#" + item.id));
    meta.appendChild(el("span", null, when(item.created_at)));
    li.appendChild(meta);
    var email = String(item.email || "");
    if (EMAIL_OK.test(email)) {
      var a = el("a", "adm-email", email);
      a.href = "mailto:" + email + "?subject=" + encodeURIComponent("Re: Dillon Green Studio waitlist");
      li.appendChild(a);
    } else {
      li.appendChild(el("p", "adm-email", email || "(no email)"));
    }
    var tags = el("ul", "adm-tags");
    tags.appendChild(el("li", null, ROLE[item.role] || String(item.role || "?")));
    tags.appendChild(el("li", null, "org " + (item.org_size || "-")));
    var nt = el("li", item.notify ? "on" : null, item.notify ? "notify: yes" : "notify: no");
    tags.appendChild(nt);
    li.appendChild(tags);
    var w = el("p", "adm-msg" + (item.workflow ? "" : " is-blank"), item.workflow || "No workflow text.");
    li.appendChild(w);
    var act = el("div", "adm-act");
    if (EMAIL_OK.test(email)) {
      var r = el("a", "adm-btn", "Reply");
      r.href = "mailto:" + email + "?subject=" + encodeURIComponent("Re: Dillon Green Studio waitlist");
      act.appendChild(r);
    }
    act.appendChild(btn("Delete", "adm-btn-del", function () { remove("delete-waitlist", item, li, "waitlist"); }));
    li.appendChild(act);
    return li;
  }

  function render(list, items) {
    panel.textContent = "";
    if (!items.length) {
      empty(null, list === "pending" ? "Nothing waiting. All caught up." : list === "approved" ? "No approved entries yet." : "Nobody on the waitlist yet.");
      return;
    }
    var ul = el("ul", "adm-list");
    items.forEach(function (it) {
      if (!it || !Number.isSafeInteger(it.id)) return;
      ul.appendChild(list === "waitlist" ? waitCard(it) : guestCard(it, list));
    });
    panel.appendChild(ul);
  }

  function load(list) {
    var seq = ++loadSeq;
    panel.setAttribute("aria-busy", "true");
    return api(list).then(function (j) {
      if (seq !== loadSeq) return;
      setCounts(j.counts);
      if (j.who && whoEl) { whoEl.textContent = j.who; whoEl.hidden = false; }
      var skip = pendingDeletes.map(function (d) { return d.id + ":" + d.list; });
      render(list, (j.items || []).filter(function (it) { return skip.indexOf(it.id + ":" + list) < 0; }));
    }).catch(function (e) {
      if (seq !== loadSeq) return;
      if (e.status === 403) empty("locked", "Not signed in through Cloudflare Access, or Access isn't configured for this site yet.");
      else if (e.status === 404) empty("wrong address", "The admin API only answers at dillongreen.dev/admin/, behind Cloudflare Access.");
      else empty("offline", "Couldn't load the list. If your Access sign-in expired, reload the page; otherwise check the connection and press Refresh.");
    }).then(function () { if (seq === loadSeq) panel.setAttribute("aria-busy", "false"); });
  }

  function dropCard(li) {
    var ul = li.parentNode;
    var next = li.nextElementSibling || li.previousElementSibling;
    ul.removeChild(li);
    if (!ul.children.length) render(current, []);
    return { ul: ul, next: next };
  }
  function putBack(li, where) {
    var p = panel.querySelector(".adm-list");
    if (!p) { panel.textContent = ""; p = el("ul", "adm-list"); panel.appendChild(p); }
    li.classList.remove("is-going");
    Array.prototype.forEach.call(li.querySelectorAll("button"), function (b) { b.disabled = false; });
    if (where && where.next && where.next.parentNode === p) p.insertBefore(li, where.next); else p.insertBefore(li, p.firstChild);
  }

  function approve(item, li) {
    var where = dropCard(li);
    counts.pending = Math.max(0, counts.pending - 1); counts.approved++; setCounts();
    toast("Approved #" + item.id + ". It's live on /guestbook/ within a minute.");
    api("approve", { id: item.id }).catch(function () {
      counts.pending++; counts.approved = Math.max(0, counts.approved - 1); setCounts();
      if (current === "pending") putBack(li, where);
      toast("Couldn't approve #" + item.id + ". Try again.", { error: true });
    });
  }

  function remove(action, item, li, list) {
    var where = dropCard(li);
    counts[list] = Math.max(0, counts[list] - 1); setCounts();
    var job = { action: action, id: item.id, list: list };
    var restore = function () {
      clearTimeout(job.timer);
      var at = pendingDeletes.indexOf(job);
      if (at < 0) return; // already sent
      pendingDeletes.splice(at, 1);
      counts[list]++; setCounts();
      if (current === list) putBack(li, where);
    };
    job.restore = restore;
    job.timer = setTimeout(function () { send(job); }, UNDO_MS);
    pendingDeletes.push(job);
    toast("Deleted #" + item.id + ".", { undo: restore, ms: UNDO_MS });
  }

  function send(job, keepalive) {
    clearTimeout(job.timer);
    var i = pendingDeletes.indexOf(job);
    if (i < 0) return;
    pendingDeletes.splice(i, 1);
    api(job.action, { id: job.id }, keepalive).catch(function () {
      if (keepalive) return;
      job.restore = null;
      counts[job.list]++; setCounts();
      toast("Couldn't delete #" + job.id + ". Refresh and try again.", { error: true });
      if (current === job.list) load(current);
    });
  }

  // Leaving the page: send queued deletes now (keepalive lets them finish after unload).
  window.addEventListener("pagehide", function () { pendingDeletes.slice().forEach(function (j) { send(j, true); }); });

  function select(name, focus) {
    current = name;
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-tab") === name;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      if (on) { panel.setAttribute("aria-labelledby", t.id); if (focus) t.focus(); }
    });
    try { history.replaceState(null, "", "#" + name); } catch (e) { /* ignore */ }
    load(name);
  }

  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { select(t.getAttribute("data-tab")); });
    t.addEventListener("keydown", function (e) {
      var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (e.key === "Home") d = -i; else if (e.key === "End") d = tabs.length - 1 - i;
      if (!d) return;
      e.preventDefault();
      select(tabs[(i + d + tabs.length) % tabs.length].getAttribute("data-tab"), true);
    });
  });
  var refresh = document.querySelector("[data-refresh]");
  if (refresh) refresh.addEventListener("click", function () { load(current); });

  var start = (location.hash || "").slice(1);
  select(["pending", "approved", "waitlist"].indexOf(start) >= 0 ? start : "pending");
})();
