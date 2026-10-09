// Guestbook + studio waitlist forms, and the guestbook listing.
// User text is only ever rendered with textContent; nothing from the API goes through innerHTML.
(function () {
  "use strict";
  var calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  var DG_GB = {}; // guestbook hooks, filled in below on the guestbook page

  /* ---------- character counters ---------- */
  function counter(c) {
    var field = document.getElementById(c.getAttribute("data-count-for"));
    if (!field) return function () {};
    var max = field.maxLength;
    var update = function () {
      var n = field.value.length;
      c.textContent = n + " / " + max;
      c.classList.toggle("over", n >= max * 0.9);
    };
    field.addEventListener("input", update);
    update();
    return update;
  }
  var counters = Array.prototype.map.call(document.querySelectorAll("[data-count-for]"), counter);

  /* ---------- messages ---------- */
  function labelFor(field) {
    var l = field.id && document.querySelector('label[for="' + field.id + '"]');
    var t = l ? (l.firstChild && l.firstChild.textContent) || l.textContent : field.name;
    return t.trim().toLowerCase().replace(/^your\s+/, "").replace(/\?$/, "");
  }
  function problem(field) {
    var v = field.validity;
    if (v.valueMissing) return field.tagName === "SELECT" ? "Please choose your " + labelFor(field) + "." : "Please add your " + labelFor(field) + ".";
    if (v.typeMismatch) return "Please check your " + labelFor(field) + ".";
    if (v.tooLong) return "Your " + labelFor(field) + " is a little long.";
    return "Please check your " + labelFor(field) + ".";
  }
  var COPY = {
    guestbook: {
      busy: "Signing…",
      ok: function () { return ["Signed!", "I approve entries by hand, so yours will appear here once I've seen it. Until then it's pinned to the top of the list below, where only you can see it."]; },
      tooFast: "You've signed a few times already. Try again in an hour."
    },
    waitlist: {
      busy: "Sending…",
      ok: function (p) {
        return ["Sent. Thank you!", "I read every one of these" + (p.email ? " and will reply to " + p.email + " if I have questions" : "") + "." +
          (p.notify ? " I'll also email you when something ships, and nothing else." : "")];
      },
      tooFast: "You've sent a few already. Try again in an hour."
    }
  };

  /* ---------- submit ---------- */
  document.querySelectorAll("form[data-form]").forEach(function (form) {
    var kind = form.getAttribute("data-form");
    var copy = COPY[kind] || COPY.waitlist;
    var status = form.querySelector("[data-status]");
    var button = form.querySelector('button[type="submit"]');
    var idle = button.textContent;
    var sending = false;
    var say = function (cls, title, body) {
      status.textContent = "";
      status.className = "form-status" + (cls ? " " + cls : "");
      if (title) status.appendChild(el("strong", "form-status-title", title));
      if (body) status.appendChild(el("span", "form-status-body", body));
    };
    var busy = function (on) {
      sending = on;
      button.disabled = on;
      button.setAttribute("aria-busy", on ? "true" : "false");
      button.textContent = on ? copy.busy : idle;
    };
    var flag = function (field, msg) {
      if (field) { field.setAttribute("aria-invalid", "true"); field.focus(); }
      say("err", null, msg);
    };

    form.addEventListener("input", function (e) {
      if (e.target.getAttribute("aria-invalid")) e.target.removeAttribute("aria-invalid");
      if (status.classList.contains("ok")) say("", null, null); // starting a new one clears the old "sent" panel
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (sending) return; // no double submits, even from a repeated Enter
      var fields = Array.prototype.filter.call(form.elements, function (f) { return f.name; });
      var bad = fields.filter(function (f) { return f.willValidate && !f.checkValidity(); })[0];
      if (bad) { flag(bad, problem(bad)); return; }

      var payload = {};
      fields.forEach(function (f) { payload[f.name] = f.type === "checkbox" ? f.checked : f.value; });
      busy(true);
      say("", null, copy.busy);
      fetch(form.getAttribute("data-endpoint"), {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.ok && data.ok) {
            form.reset();
            counters.forEach(function (u) { u(); });
            var msg = copy.ok(payload);
            say("ok", msg[0], msg[1]);
            if (kind === "guestbook" && !payload.fax && DG_GB.addPending) DG_GB.addPending(payload);
          } else if (res.status === 429) {
            say("err", null, typeof data.error === "string" && data.error ? data.error : copy.tooFast);
          } else {
            var field = data.field && form.elements[data.field];
            flag(field && field.focus ? field : null, data.error || "That didn't go through. Please try again in a minute.");
          }
        });
      }).catch(function () {
        say("err", null, "Couldn't reach the server. Check your connection and try again; what you typed is still here.");
      }).then(function () { busy(false); });
    });
  });

  /* ---------- guestbook listing + odometer ---------- */
  var list = document.querySelector("[data-gb-list]");
  if (!list) return;
  var empty = document.querySelector("[data-gb-empty]");
  var odo = document.querySelector("[data-odometer]");
  var countText = document.querySelector("[data-count-text]");
  var geoText = document.querySelector("[data-gb-geo-text]");
  var flagRow = document.querySelector("[data-gb-flags]");
  var PENDING = "dg-gb-pending";
  var approved = null; // last approved list from the API

  function setDigits(n) {
    var s = String(Math.max(0, Math.min(999999, n))).padStart(6, "0");
    Array.prototype.forEach.call(odo.children, function (d, i) { d.textContent = s[i]; });
  }
  function showCount(total) {
    if (total == null) { countText.textContent = "The counter is taking a coffee break."; return; }
    countText.textContent = total === 0 ? "Nobody yet. You could be number one." :
      total === 1 ? "One person has signed. You could be the second." : total.toLocaleString("en-US") + " people have signed.";
    if (calm || total === 0) { setDigits(total); return; }
    var start = performance.now(), dur = Math.min(1400, 500 + total * 40);
    (function tick(now) {
      var t = Math.min(1, (now - start) / dur), eased = 1 - Math.pow(1 - t, 3);
      setDigits(Math.round(total * eased));
      if (t < 1) requestAnimationFrame(tick);
    })(start);
  }
  // "Signed from N countries" + flags. The API sends only two-letter codes of approved entries (the
  // server validated them already); they're checked again here and each flag is built from the code as
  // two regional-indicator characters, set with textContent. Country names (for the tooltip and the
  // screen-reader label) come from the browser's own Intl.DisplayNames.
  var regionName = (function () {
    try {
      var dn = new Intl.DisplayNames(["en"], { type: "region" });
      return function (c) { try { return dn.of(c) || c; } catch (e) { return c; } };
    } catch (e) { return function (c) { return c; }; }
  })();
  function flagOf(c) { return String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65, 0x1F1E6 + c.charCodeAt(1) - 65); }
  // Some systems (Windows, notably) have no flag emoji and draw the two letters instead. Draw one flag on a
  // tiny canvas: a real flag has colour, the letter fallback is plain. Without flags, each country gets a
  // small retro code chip ("NZ") instead, which reads as intended rather than broken.
  var flagsWork = (function () {
    try {
      var c = document.createElement("canvas");
      c.width = c.height = 20;
      var x = c.getContext("2d", { willReadFrequently: true });
      if (!x) return true;
      x.textBaseline = "top";
      x.font = '18px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';
      x.fillText(flagOf("SE"), 0, 0);
      var d = x.getImageData(0, 0, 20, 20).data;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 128 && (Math.abs(d[i] - d[i + 1]) > 40 || Math.abs(d[i + 1] - d[i + 2]) > 40)) return true;
      }
      return false;
    } catch (e) { return true; }
  })();
  function showGeo(list) {
    if (!geoText || !flagRow) return;
    flagRow.textContent = "";
    if (list == null) {
      geoText.textContent = "Flags are offline";
      flagRow.setAttribute("aria-label", "Visitor flags unavailable");
      return;
    }
    var codes = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      if (typeof c === "string" && /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" && codes.indexOf(c) < 0) codes.push(c);
    });
    var n = codes.length;
    geoText.textContent = n === 0 ? "No flags on the map yet" : "Signed from " + n + (n === 1 ? " country" : " countries");
    if (!n) { // three empty slots keep the row from looking broken
      for (var k = 0; k < 3; k++) flagRow.appendChild(el("span", "gb-flag-slot"));
      flagRow.setAttribute("aria-label", "No visitor flags yet");
      return;
    }
    // as many as fit on the one reserved row (about 32px per flag, 38px per code chip), the rest as "+N"
    var fit = Math.max(3, Math.min(14, Math.floor((flagRow.clientWidth + 4) / (flagsWork ? 32 : 38))));
    var shown = n > fit ? codes.slice(0, fit - 1) : codes;
    shown.forEach(function (c) {
      var f = el("span", flagsWork ? "gb-flag" : "gb-flag is-code", flagsWork ? flagOf(c) : c);
      f.title = regionName(c);
      flagRow.appendChild(f);
    });
    if (n > shown.length) flagRow.appendChild(el("span", "gb-flag-more", "+" + (n - shown.length)));
    flagRow.setAttribute("aria-label", n ? "Visitors' countries: " + codes.map(regionName).join(", ") : "No visitor flags yet");
  }
  function fmtDate(d) {
    var dt = new Date(d + "T00:00:00Z");
    return isNaN(dt) ? d : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  function entryEl(e, num, opts) {
    var li = el("li", "gb-entry" + (opts.pending ? " pending" : "")), head = el("div", "head");
    head.appendChild(el("span", "num", num));
    head.appendChild(el("span", "who", String(e.name || "")));
    if (opts.fresh) head.appendChild(el("span", "gb-new", "NEW!"));
    var when = el("time", "when", fmtDate(String(e.date || "")));
    when.setAttribute("datetime", String(e.date || ""));
    head.appendChild(when);
    li.appendChild(head);
    if (opts.pending) li.appendChild(el("span", "gb-pending", "Awaiting approval · only you can see this"));
    if (e.url) li.appendChild(el("span", "site", String(e.url).replace(/^https?:\/\//i, "")));
    li.appendChild(el("p", "msg", String(e.message || "")));
    return li;
  }
  // Your own not-yet-approved entries live only in this browser, until the approved list includes them.
  var norm = function (s) { return String(s || "").replace(/\s+/g, " ").trim(); };
  function pendingList() {
    var p = store.get(PENDING);
    if (!Array.isArray(p)) return [];
    var cutoff = Date.now() - 60 * 864e5; // and never longer than 60 days
    return p.filter(function (x) { return x && typeof x.name === "string" && typeof x.message === "string" && Number(x.ts) > cutoff; });
  }
  function draw() {
    var entries = approved ? approved.entries : [];
    var total = approved ? approved.total : 0;
    var mine = pendingList();
    if (approved) { // drop any that have been approved since
      mine = mine.filter(function (p) {
        return !entries.some(function (e) { return norm(e.name) === norm(p.name) && norm(e.message) === norm(p.message); });
      });
      store.set(PENDING, mine.length ? mine : null);
    }
    list.textContent = "";
    mine.slice().reverse().forEach(function (p) { list.appendChild(entryEl(p, "#…", { pending: true })); });
    entries.forEach(function (e, i) {
      var fresh = i === 0 && Date.now() - new Date(e.date + "T00:00:00Z").getTime() < 14 * 864e5;
      list.appendChild(entryEl(e, "#" + (total - i), { fresh: fresh }));
    });
    var none = entries.length + mine.length === 0;
    if (mine.length || (approved && entries.length)) empty.hidden = true;
    else if (approved && none) { empty.hidden = false; empty.textContent = "No signatures yet. Be the first!"; }
  }
  DG_GB.addPending = function (payload) {
    var d = new Date();
    var p = pendingList();
    p.push({
      name: norm(payload.name).slice(0, 40), url: norm(payload.url).slice(0, 80),
      message: String(payload.message || "").trim().slice(0, 280),
      date: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"),
      ts: Date.now()
    });
    store.set(PENDING, p.slice(-5));
    draw();
  };

  empty.textContent = "Loading the guestbook…";
  draw(); // your own pending entries show at once, before the network answers
  fetch("/api/guestbook", { headers: { Accept: "application/json" }, credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      var entries = Array.isArray(data.entries) ? data.entries : [];
      approved = { entries: entries, total: Number(data.total) || entries.length };
      draw();
      showCount(approved.total);
      showGeo(Array.isArray(data.countries) ? data.countries : []);
    })
    .catch(function () {
      empty.hidden = false;
      empty.textContent = "The guestbook couldn't load just now. Try again in a bit.";
      showCount(null);
      showGeo(null);
    });
})();
