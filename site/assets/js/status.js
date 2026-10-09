// Live network status widget. Reads GET /api/status and renders into every [data-status-panel]:
//   // NETWORK STATUS            9/9 NODES ONLINE
//   [dot name / UP · 120 ms] ...  (state is always spelled out, never colour alone)
//   checked 12s ago
// Also sets data-state="up|slow|down" on any [data-status-slug="<slug>"] element (project cards).
// Loads after the page is idle, refreshes every 60 s only while the tab is visible, and fails soft to
// "status unavailable". Text goes in with textContent only; no inline style attributes, no eval.
(function () {
  "use strict";
  var API = "/api/status";
  var REFRESH_MS = 60000;
  var STATES = { up: "Up", slow: "Slow", down: "Down" };

  var panels = [];
  var data = null;        // last good payload
  var ageBase = 0;        // seconds old the data was when it arrived
  var receivedAt = 0;     // Date.now() when it arrived
  var lastTry = 0;
  var failed = false;
  var busy = false;
  var refreshTimer = null;
  var tickTimer = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function mount(host) {
    host.textContent = "";
    var root = el("div", "ns");
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Network status of my live projects");
    root.setAttribute("data-state", "loading");
    var head = el("p", "ns-head");
    head.appendChild(el("span", "ns-title", "// NETWORK STATUS"));
    var count = el("span", "ns-count");
    count.setAttribute("aria-live", "polite");
    head.appendChild(count);
    var body = el("div", "ns-body");
    var foot = el("p", "ns-foot");
    root.appendChild(head);
    root.appendChild(body);
    root.appendChild(foot);
    host.appendChild(root);
    var p = { host: host, root: root, count: count, body: body, foot: foot };
    setCount(p, null, "Checking nodes");
    skeleton(p);
    return p;
  }

  function setCount(p, onlineTotal, text) {
    p.count.textContent = "";
    p.count.appendChild(el("span", "ns-lamp"));
    if (onlineTotal) {
      p.count.appendChild(el("b", null, onlineTotal));
      p.count.appendChild(document.createTextNode(" "));
      p.count.appendChild(el("span", "ns-word", "NODES "));
      p.count.appendChild(document.createTextNode(text));
    } else {
      p.count.appendChild(document.createTextNode(text));
    }
  }

  // one placeholder per reserved slot (--ns-cols x --ns-rows from status.css), so the skeleton fills
  // exactly the box the real grid will occupy, whatever the node count is
  function slots(host) {
    var cs = getComputedStyle(host);
    var c = parseInt(cs.getPropertyValue("--ns-cols"), 10), r = parseInt(cs.getPropertyValue("--ns-rows"), 10);
    return c > 0 && r > 0 && c * r <= 60 ? c * r : 9;
  }

  function skeleton(p) {
    p.body.textContent = "";
    var ul = el("ul", "ns-grid");
    ul.setAttribute("aria-hidden", "true");
    for (var i = 0, n = slots(p.host); i < n; i++) {
      var li = el("li");
      var n = el("div", "ns-node is-skel");
      var l1 = el("span", "ns-l1");
      l1.appendChild(el("span", "ns-dot"));
      l1.appendChild(el("span", "ns-name", "-"));
      var l2 = el("span", "ns-l2");
      l2.appendChild(el("span", null, "-"));
      n.appendChild(l1);
      n.appendChild(l2);
      li.appendChild(n);
      ul.appendChild(li);
    }
    p.body.appendChild(ul);
    p.foot.textContent = "checking…";
  }

  function latency(node) {
    return (node.ms >= 1000 ? (node.ms / 1000).toFixed(1) + " s" : node.ms + " ms");
  }

  function safeUrl(u) {
    try {
      var x = new URL(u);
      return x.protocol === "https:" ? x.href : null;
    } catch (e) { return null; }
  }

  function render(p) {
    if (!data) {
      if (failed) {
        p.root.setAttribute("data-state", "error");
        setCount(p, null, "Status unavailable");
        p.body.textContent = "";
        var msg = el("div", "ns-msg");
        msg.appendChild(el("b", null, "status unavailable"));
        msg.appendChild(el("span", null, "Couldn't reach the status check. Retrying shortly."));
        p.body.appendChild(msg);
        p.foot.textContent = "last check failed";
      }
      return;
    }
    var online = data.up, total = data.total;
    p.root.setAttribute("data-state", online === total ? "ok" : online === 0 ? "error" : "degraded");
    setCount(p, online + "/" + total, "ONLINE");
    p.count.setAttribute("aria-label", online + " of " + total + " nodes online");
    p.body.textContent = "";
    var ul = el("ul", "ns-grid");
    data.nodes.forEach(function (node) {
      var li = el("li");
      var href = safeUrl(node.url);
      var n = el(href ? "a" : "div", "ns-node");
      if (href) { n.href = href; n.rel = "noopener"; }
      n.setAttribute("data-state", node.status);
      n.setAttribute("aria-label", node.name + ": " + STATES[node.status] + (node.status === "down" ? "" : ", " + latency(node)));
      n.title = node.name + " · " + STATES[node.status];
      var l1 = el("span", "ns-l1");
      var dot = el("span", "ns-dot");
      dot.setAttribute("aria-hidden", "true");
      l1.appendChild(dot);
      l1.appendChild(el("span", "ns-name", node.name));
      var l2 = el("span", "ns-l2");
      l2.setAttribute("aria-hidden", "true");
      l2.appendChild(el("span", "ns-state", STATES[node.status]));
      if (node.status !== "down") {
        l2.appendChild(el("span", null, "·"));
        l2.appendChild(el("span", "ns-ms", latency(node)));
      }
      n.appendChild(l1);
      n.appendChild(l2);
      li.appendChild(n);
      ul.appendChild(li);
    });
    p.body.appendChild(ul);
    foot(p);
  }

  function ageText() {
    var s = Math.max(0, Math.round(ageBase + (Date.now() - receivedAt) / 1000));
    return s < 60 ? s + "s ago" : Math.floor(s / 60) + "m ago";
  }
  function foot(p) {
    if (!data) return;
    p.foot.textContent = "checked " + ageText() + (failed ? " · refresh failed" : "");
  }

  function lamps() {
    if (!data) return;
    var by = {};
    data.nodes.forEach(function (n) { by[n.slug] = n; if (n.alias) by[n.alias] = n; });
    var els = document.querySelectorAll("[data-status-slug]");
    for (var i = 0; i < els.length; i++) {
      var e = els[i], n = by[e.getAttribute("data-status-slug")];
      if (!n) continue;
      e.setAttribute("data-state", n.status);
      e.setAttribute("data-ms", String(n.ms));
      if (!e.firstChild || e.classList.contains("ns-auto")) {
        e.classList.add("ns-auto");
        e.textContent = "";
        e.appendChild(el("span", "ns-sr", "Status: " + STATES[n.status]));
      }
    }
  }

  // Accept only the expected shape; anything else counts as a failed check.
  function valid(j) {
    if (!j || typeof j !== "object" || !Array.isArray(j.nodes) || !j.nodes.length) return null;
    var nodes = [];
    for (var i = 0; i < j.nodes.length && i < 50; i++) {
      var n = j.nodes[i];
      if (!n || typeof n.slug !== "string" || typeof n.name !== "string" || !STATES[n.status]) return null;
      var host = "";
      try { host = n.url ? new URL(n.url).hostname.split(".")[0] : ""; } catch (e) { host = ""; }
      nodes.push({ slug: n.slug, name: n.name.slice(0, 60), status: n.status, ms: Math.max(0, Math.round(Number(n.ms) || 0)), url: typeof n.url === "string" ? n.url : "", alias: host && host !== n.slug ? host : "" });
    }
    var up = nodes.filter(function (n) { return n.status !== "down"; }).length;
    var t = Date.parse(j.checked_at);
    return { up: up, total: nodes.length, nodes: nodes, checkedAt: isFinite(t) ? t : Date.now() };
  }

  function load() {
    if (busy) return;
    busy = true;
    lastTry = Date.now();
    fetch(API, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        var d = valid(j);
        if (!d) throw new Error("bad payload");
        data = d;
        failed = false;
        receivedAt = Date.now();
        ageBase = Math.min(120, Math.max(0, (receivedAt - d.checkedAt) / 1000));
      })
      .catch(function () { failed = true; })
      .then(function () {
        busy = false;
        panels.forEach(render);
        lamps();
        try { document.dispatchEvent(new CustomEvent("dg:status", { detail: data })); } catch (e) { /* old browsers */ }
      });
  }

  function schedule() {
    clearTimeout(refreshTimer);
    clearInterval(tickTimer);
    if (document.visibilityState === "hidden") return;
    var wait = Math.max(0, REFRESH_MS - (Date.now() - lastTry));
    refreshTimer = setTimeout(function () { load(); schedule(); }, wait);
    tickTimer = setInterval(function () { panels.forEach(foot); }, 1000);
  }

  function start() {
    load();
    schedule();
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && Date.now() - lastTry >= REFRESH_MS) load();
      schedule();
    });
  }

  function init() {
    var hosts = document.querySelectorAll("[data-status-panel]");
    for (var i = 0; i < hosts.length; i++) panels.push(mount(hosts[i]));
    if (!panels.length && !document.querySelector("[data-status-slug]")) return;
    var idle = function () {
      if ("requestIdleCallback" in window) window.requestIdleCallback(start, { timeout: 2500 });
      else setTimeout(start, 600);
    };
    if (document.readyState === "complete") idle();
    else window.addEventListener("load", idle, { once: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
