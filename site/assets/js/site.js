// Dillon Green — portfolio. Progressive enhancement only; the page works without it.
(function () {
  "use strict";
  var root = document.documentElement;
  var DG = (window.DG = window.DG || {});

  /* ---------- ARINC 429 decoding (shared with the terminal) ---------- */
  var SSM_BNR = ["Failure warning", "No computed data", "Functional test", "Normal operation"];
  // word: unsigned 32-bit number. Bit n (1..32) = (word >>> (n-1)) & 1.
  DG.decodeWord = function (word) {
    word = word >>> 0;
    var bit = function (n) { return (word >>> (n - 1)) & 1; };
    var i, ones = 0, label = 0, raw = 0, data = 0;
    for (i = 1; i <= 32; i++) ones += bit(i);
    for (i = 1; i <= 8; i++) label = label * 2 + bit(i); // bit 1 is the label's MSB
    var r = {
      hex: "0x" + word.toString(16).toUpperCase().padStart(8, "0"),
      label: label, oct: label.toString(8).padStart(3, "0"),
      sdi: bit(10) * 2 + bit(9),
      ssmBits: "" + bit(31) + bit(30),
      ssm: SSM_BNR[bit(31) * 2 + bit(30)],
      parityOk: ones % 2 === 1,
      known: label === 0o203
    };
    if (r.known) {
      // Label 203 pressure altitude, BNR: sign bit 29, MSB (bit 28) = 65,536 ft, 1 ft resolution, bit 11 pad.
      for (i = 29; i >= 12; i--) raw = raw * 2 + bit(i);
      if (bit(29)) raw -= 262144; // two's complement over 18 bits
      r.name = "Pressure altitude";
      r.value = raw;
      r.text = (raw >= 0 ? "+" : "−") + Math.abs(raw).toLocaleString("en-US") + " ft";
    } else {
      for (i = 29; i >= 11; i--) data = data * 2 + bit(i);
      r.name = "not in this demo's table";
      r.value = data;
      r.text = "0x" + data.toString(16).toUpperCase().padStart(5, "0") + " raw";
    }
    return r;
  };

  /* ---------- theme ---------- */
  DG.currentTheme = function () {
    return root.getAttribute("data-theme") === "light" ? "light" : "dark"; // night is the default
  };
  function syncThemeLabels() {
    var next = DG.currentTheme() === "dark" ? "light" : "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.setAttribute("aria-label", "Switch to " + next + " theme");
      b.title = "Switch to " + next + " theme";
    });
  }
  DG.setTheme = function (t) {
    root.setAttribute("data-theme", t);
    try { localStorage.setItem("theme", t); } catch (e) {}
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      m.setAttribute("content", t === "dark" ? "#06080b" : "#eef3f4"); m.removeAttribute("media");
    });
    syncThemeLabels();
  };
  document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
    b.addEventListener("click", function () { DG.setTheme(DG.currentTheme() === "dark" ? "light" : "dark"); });
  });
  syncThemeLabels();

  /* ---------- header hairline once scrolled ---------- */
  var top = document.getElementById("top");
  if (top) {
    var stuck = null, ticking = false;
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var now = window.scrollY > 8;
        if (now !== stuck) { stuck = now; top.classList.toggle("is-stuck", now); } // only touch the DOM on change
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------- mobile menu ----------
     A modal <dialog> sheet: showModal() makes the page behind it inert and puts the sheet in
     the top layer, so the header's backdrop-filter can't trap it. Tab wraps inside the sheet;
     Esc, the close button, the backdrop or picking a link closes it and focus goes back. */
  var menuBtn = document.querySelector("[data-menu]");
  if (menuBtn && typeof HTMLDialogElement !== "function") menuBtn.hidden = true; // very old browser: footer links remain
  if (menuBtn && typeof HTMLDialogElement === "function") {
    var onHome = function (id) { return !!document.getElementById(id); };
    var here = location.pathname.replace(/index\.html$/, "").replace(/\.html$/, "");
    var LINKS = [
      ["Home", "/", "01"], ["Projects", "/projects/", "02"], ["Studio", "/studio/", "03"],
      ["How I work", "/#practice", "04"], ["Experience", "/#experience", "05"],
      ["Guestbook", "/guestbook/", "06"], ["Now", "/now/", "07"]
    ];
    var NS = "http://www.w3.org/2000/svg";
    var icon = function (d) {
      var s = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
      s.setAttribute("viewBox", "0 0 20 20"); s.setAttribute("aria-hidden", "true");
      p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "1.7"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
      s.appendChild(p); return s;
    };
    var mk = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    var sheet = mk("dialog", "menu");
    sheet.id = "site-menu";
    sheet.setAttribute("aria-label", "Site menu");
    var head = mk("div", "menu-head");
    head.appendChild(mk("span", "menu-title", "Menu"));
    var x = mk("button", "theme-btn menu-x");
    x.type = "button"; x.setAttribute("aria-label", "Close menu");
    x.appendChild(icon("M5 5l10 10M15 5 5 15"));
    head.appendChild(x);
    var nav = mk("nav", "menu-nav"); nav.setAttribute("aria-label", "Site");
    var ul = mk("ul");
    LINKS.forEach(function (l) {
      var href = l[1], hash = href.split("#")[1];
      if (hash && onHome(hash)) href = "#" + hash;
      var a = mk("a"); a.href = href;
      a.appendChild(mk("span", "menu-n", l[2]));
      a.appendChild(document.createTextNode(l[0]));
      if (!hash && (here === l[1] || (l[1] !== "/" && here.indexOf(l[1]) === 0))) a.setAttribute("aria-current", "page");
      var li = mk("li"); li.appendChild(a); ul.appendChild(li);
    });
    nav.appendChild(ul);
    var acts = mk("div", "menu-actions");
    var res = mk("a", "btn btn-primary", "Resume (PDF)"); res.href = "/Dillon_Green_Resume.pdf";
    res.insertBefore(icon("M10 3v10m-4-4 4 4 4-4M4 16h12"), res.firstChild);
    var mail = mk("a", "btn", "Email"); mail.href = "mailto:dillon@dillongreen.dev";
    mail.insertBefore(icon("M2.5 5.5h15v9h-15zM3 6l7 5.5L17 6"), mail.firstChild);
    var gh = mk("a", "btn", "GitHub"); gh.href = "https://github.com/dgreen52"; gh.rel = "me";
    gh.appendChild(icon("M7 13 13 7M8 7h5v5"));
    acts.append(res, mail, gh);
    var mailNote = mk("p", "menu-note", "dillon@dillongreen.dev · Seattle, WA");
    sheet.append(head, nav, acts, mailNote);
    document.body.appendChild(sheet);

    var focusables = function () {
      return Array.prototype.filter.call(sheet.querySelectorAll("a[href], button"), function (n) { return n.offsetParent !== null; });
    };
    var openMenu = function () {
      if (sheet.open) return;
      sheet.showModal();
      root.classList.add("menu-open");
      menuBtn.setAttribute("aria-expanded", "true");
      x.focus();
    };
    var closeMenu = function () { if (sheet.open) sheet.close(); };
    sheet.addEventListener("close", function () {
      root.classList.remove("menu-open");
      menuBtn.setAttribute("aria-expanded", "false");
      menuBtn.focus({ preventScroll: true });
    });
    // Esc fires "cancel" right away and "close" a moment later; reflect the state immediately
    sheet.addEventListener("cancel", function () { menuBtn.setAttribute("aria-expanded", "false"); });
    x.addEventListener("click", closeMenu);
    sheet.addEventListener("click", function (e) {
      if (e.target.closest("a[href]")) { closeMenu(); return; } // let the link navigate
      if (e.target !== sheet) return;
      var r = sheet.getBoundingClientRect(); // clicks on ::backdrop land on the dialog, outside its box
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeMenu();
    });
    sheet.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var f = focusables(); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    // A window wide enough for the full header nav doesn't need the sheet.
    if (window.matchMedia) {
      var wide = matchMedia("(min-width: 1024px)");
      var onWide = function () { if (wide.matches) closeMenu(); };
      if (wide.addEventListener) wide.addEventListener("change", onWide);
    }
    menuBtn.addEventListener("click", openMenu);
    menuBtn.hidden = false;
  }

  /* ---------- "More" disclosures for long copy on phones ----------
     <button class="more-btn" aria-controls="id1 id2" aria-expanded="false">. CSS hides the
     controlled .m-extra elements below 720px until the button opens them; wider screens and
     no-JS visitors always see everything. */
  document.querySelectorAll(".more-btn").forEach(function (b) {
    var targets = (b.getAttribute("aria-controls") || "").split(/\s+/).map(function (id) { return document.getElementById(id); }).filter(Boolean);
    var label = b.querySelector(".more-label");
    var closed = label ? label.textContent : "";
    b.addEventListener("click", function () {
      var open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", open ? "true" : "false");
      targets.forEach(function (t) { t.classList.toggle("is-open", open); });
      if (label) label.textContent = open ? (b.getAttribute("data-less") || "Show less") : closed;
    });
  });

  /* ---------- sideways card rails (phones) ----------
     Below 720px CSS turns .rail into a scroll-snap row. While it actually scrolls, it becomes a
     labelled, focusable region so keyboard users can arrow through it. */
  var rails = document.querySelectorAll(".rail");
  if (rails.length) {
    var syncRails = function () {
      rails.forEach(function (r) {
        if (r.scrollWidth > r.clientWidth + 2) {
          r.setAttribute("role", "region");
          r.setAttribute("aria-label", (r.getAttribute("data-rail-label") || "Cards") + " (scrolls sideways)");
          r.tabIndex = 0;
        } else {
          r.removeAttribute("role"); r.removeAttribute("aria-label"); r.removeAttribute("tabindex");
        }
      });
    };
    syncRails();
    window.addEventListener("resize", syncRails, { passive: true });
  }

  /* ---------- project filters (/projects/) ----------
     Toggle buttons with aria-pressed; the choice lives in the URL hash (#games) so it can be
     linked. Without JS the buttons are hidden by CSS and every card shows. */
  var filters = document.querySelector("[data-filters]");
  var flist = document.querySelector("[data-filter-list]");
  if (filters && flist) {
    var fbuttons = Array.prototype.slice.call(filters.querySelectorAll("[data-filter]"));
    var fcards = Array.prototype.slice.call(flist.children);
    var fcount = document.querySelector("[data-filter-count]");
    var names = fbuttons.map(function (b) { return b.getAttribute("data-filter"); });
    var applyFilter = function (f, fromUser) {
      if (names.indexOf(f) < 0) f = "all";
      var shown = 0;
      fbuttons.forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-filter") === f ? "true" : "false"); });
      fcards.forEach(function (c) {
        var on = f === "all" || (" " + c.getAttribute("data-cats") + " ").indexOf(" " + f + " ") >= 0;
        c.hidden = !on;
        if (on) shown++;
      });
      if (fcount) fcount.textContent = f === "all" ? shown + " projects" : shown + " of " + fcards.length + " projects · " + f;
      if (fromUser && window.history && history.replaceState) history.replaceState(null, "", f === "all" ? location.pathname : "#" + f);
    };
    filters.addEventListener("click", function (e) {
      var b = e.target.closest("[data-filter]");
      if (b) applyFilter(b.getAttribute("data-filter"), true);
    });
    var fromHash = function () {
      var h = location.hash.replace("#", "");
      if (names.indexOf(h) >= 0) { applyFilter(h, false); return; }
      applyFilter("all", false);
      var card = h && document.getElementById(h); // #crumb etc. still jumps to that card
      if (card && card.parentElement === flist) card.scrollIntoView({ block: "start" });
    };
    window.addEventListener("hashchange", fromHash);
    fromHash();
  }

  /* ---------- ARINC 429 bit flipper ---------- */
  var grid = document.querySelector("[data-bits]");
  if (!grid) return;
  var reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var cells = Array.prototype.slice.call(grid.querySelectorAll(".bit"));
  var $ = function (sel) { return document.querySelector(sel); };
  var out = {
    hex: $("[data-hex]"), name: $("[data-label-name]"), value: $("[data-value]"),
    ssm: $("[data-ssm]"), parity: $("[data-parity]"), reset: $("[data-reset]")
  };
  function readWord() {
    var w = 0;
    cells.forEach(function (c) { w = w * 2 + (c.getAttribute("aria-pressed") === "true" ? 1 : 0); });
    return w >>> 0; // cells run bit 32 -> bit 1
  }
  var initial = readWord();

  function render() {
    var w = readWord(), d = DG.decodeWord(w);
    out.hex.textContent = d.hex;
    out.name.textContent = "Label " + d.oct + " · " + d.name + (d.known ? " · SDI " + d.sdi : "");
    var parts = d.text.split(" ");
    out.value.textContent = parts[0];
    var small = document.createElement("small"); small.textContent = parts[1];
    out.value.appendChild(small);
    out.ssm.textContent = "SSM " + d.ssmBits + " · " + d.ssm;
    out.parity.textContent = d.parityOk ? "Parity OK" : "Parity error";
    out.parity.className = d.parityOk ? "ok" : "bad";
    out.reset.hidden = w === initial;
  }
  function setCell(c, v, animate) {
    c.setAttribute("aria-pressed", v ? "true" : "false");
    c.querySelector(".v").textContent = v ? "1" : "0";
    if (animate && !reduceMotion) { c.classList.remove("flip"); void c.offsetWidth; c.classList.add("flip"); }
  }
  DG.loadWord = function (w) {
    cells.forEach(function (c, k) { setCell(c, (w >>> (31 - k)) & 1, true); });
    render();
  };
  // Optional preset buttons next to a word (used by the ARINC 429 post): <button data-load-word="7FE0C0C1">
  document.querySelectorAll("[data-word-try]").forEach(function (row) {
    row.hidden = false;
    row.addEventListener("click", function (e) {
      var b = e.target.closest("[data-load-word]");
      if (b) DG.loadWord(parseInt(b.getAttribute("data-load-word"), 16) >>> 0);
    });
  });

  grid.addEventListener("click", function (e) {
    var c = e.target.closest(".bit");
    if (!c) return;
    setCell(c, c.getAttribute("aria-pressed") !== "true", true);
    render();
  });
  // Roving tabindex: one tab stop for the whole word, arrows move between bits.
  grid.addEventListener("keydown", function (e) {
    var idx = cells.indexOf(document.activeElement);
    if (idx < 0) return;
    var next = null;
    if (e.key === "ArrowRight") next = Math.min(31, idx + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, idx - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 31;
    if (next === null) return;
    e.preventDefault();
    cells[idx].tabIndex = -1;
    cells[next].tabIndex = 0;
    cells[next].focus();
  });
  out.reset.addEventListener("click", function () {
    cells.forEach(function (c, k) { setCell(c, (initial >>> (31 - k)) & 1, false); });
    render();
    cells[0].focus();
  });
  render();
})();
