// The fun layer: boot sequence, terminal, easter eggs, card tilt.
// Everything here is optional; with JS off or reduced motion on, the site is calm and complete.
(function () {
  "use strict";
  var DG = (window.DG = window.DG || {});
  var root = document.documentElement;
  var mqReduce = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var calm = function () { return mqReduce.matches; };
  var fine = window.matchMedia && matchMedia("(hover: hover) and (pointer: fine)").matches;
  var KATA = "アカサタナハマヤラワイキシチニヒミリウクスツヌフムユルエケセテネヘメレオコソトノホモヨロ0123456789";
  var EMAIL = "dillon@dillongreen.dev";
  // Projects (names, URLs, play/open lines) come from assets/js/projects-data.js, which
  // tools/build_projects.py generates from tools/projects.json.
  var PD = DG.projects || [];
  var findProject = function (name) {
    name = String(name || "").toLowerCase();
    return PD.filter(function (p) { return p.slug === name || (p.aliases || []).indexOf(name) >= 0; })[0];
  };
  var params = new URLSearchParams(location.search);
  var ss = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* =========================================================== boot / POST
     Once per session, never under reduced motion or automation, skipped by any input. */
  function boot() {
    var forced = params.has("boot");
    if (calm()) return;
    // Phones and tablets never get a full-screen overlay on arrival; ?boot still shows it.
    if (!forced && (!fine || navigator.webdriver || ss.get("dg-booted") || location.hash)) return;
    ss.set("dg-booted", "1");
    var ov = el("div", "boot");
    ov.setAttribute("aria-hidden", "true");
    var pre = el("pre", "boot-text");
    var hint = el("p", "boot-hint", "press any key to skip");
    ov.append(pre, hint);
    document.body.appendChild(ov);
    var done = false;
    var finish = function () {
      if (done) return; done = true;
      ov.classList.add("out");
      ["keydown", "pointerdown", "wheel", "touchstart"].forEach(function (t) { removeEventListener(t, finish, true); });
      setTimeout(function () { ov.remove(); }, 450);
    };
    ["keydown", "pointerdown", "wheel", "touchstart"].forEach(function (t) { addEventListener(t, finish, true); });
    var lines = [
      ["DG/OS 8.0 · FLIGHT SIMULATOR ENGINEER BIOS", ""],
      ["POST", "OK"],
      ["ARINC 429 BUS", "0x6445C0C1 · PARITY OK"],
      ["MPIC I/O CHASSIS", "16 / 16"],
      ["CLAUDE CODE AGENTS", "STANDING BY"],
      ["TEST SUITES", "340+ PASS"],
      ["LOADING PORTFOLIO", "████████████ 100%"]
    ];
    (async function () {
      for (var i = 0; i < lines.length && !done; i++) {
        var l = lines[i];
        var row = l[1] ? (l[0] + " ").padEnd(26, ".") + " " + l[1] : l[0];
        pre.textContent += row + "\n";
        await sleep(i === 0 ? 260 : 170);
      }
      await sleep(380);
      finish();
    })();
  }

  /* =========================================================== katakana rain */
  var rain = null;
  function startRain(opts) {
    opts = opts || {};
    if (calm()) return function () {};
    if (rain) rain.stop();
    var c = el("canvas", "rain" + (opts.front ? " front" : ""));
    c.setAttribute("aria-hidden", "true");
    document.body.appendChild(c);
    var ctx = c.getContext("2d"), fs = 16, drops = [], raf, last = 0, stopped = false;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    function size() {
      c.width = innerWidth * dpr; c.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var cols = Math.ceil(innerWidth / fs);
      drops = Array.from({ length: cols }, function () { return Math.random() * -50; });
    }
    size(); addEventListener("resize", size);
    var color = opts.color || (DG.currentTheme && DG.currentTheme() === "light" ? "10,108,125" : "98,211,230");
    function frame(ts) {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      if (ts - last < 45) return; last = ts;
      ctx.fillStyle = opts.front ? "rgba(5,8,10,0.18)" : "rgba(0,0,0,0)";
      if (opts.front) ctx.fillRect(0, 0, innerWidth, innerHeight); else ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.font = fs + "px ui-monospace, 'JetBrains Mono', monospace";
      for (var i = 0; i < drops.length; i++) {
        var y = drops[i] * fs;
        ctx.fillStyle = "rgba(" + color + "," + (opts.front ? 0.9 : 0.55) + ")";
        ctx.fillText(KATA[(Math.random() * KATA.length) | 0], i * fs, y);
        if (!opts.front) { // trailing column, drawn explicitly since the canvas is cleared
          for (var k = 1; k < 12; k++) {
            ctx.fillStyle = "rgba(" + color + "," + (0.5 - k * 0.04) + ")";
            ctx.fillText(KATA[(i * 7 + k * 13 + ((y / fs) | 0)) % KATA.length], i * fs, y - k * fs);
          }
        }
        drops[i] += 0.9 + (i % 5) * 0.12;
        if (y > innerHeight + 12 * fs && Math.random() > 0.96) drops[i] = Math.random() * -10;
      }
    }
    raf = requestAnimationFrame(frame);
    rain = {
      stop: function () {
        stopped = true; cancelAnimationFrame(raf); removeEventListener("resize", size);
        c.classList.add("out"); setTimeout(function () { c.remove(); }, 600); rain = null;
      }
    };
    if (opts.duration) setTimeout(function () { if (rain) rain.stop(); }, opts.duration);
    return rain.stop;
  }

  /* =========================================================== intrusion */
  var intruding = false;
  DG.intrusion = async function () {
    if (intruding) return;
    intruding = true;
    var lines = [
      "> INTRUSION DETECTED :: DILLONGREEN.DEV NODE 7",
      "> ICE: BLACKWALL v2.77 .............. BYPASSED",
      "> DECRYPTING PERSONAL SHARD  ████████░░ 87%",
      "> SHARD CONTENTS: resume.pdf, 340+ passing tests",
      "> ACCESS GRANTED · ようこそ、NETRUNNER",
      "> LOG WIPED — NO TRACE LEFT"
    ];
    if (calm()) { // no motion: a quiet, static version of the joke
      toast("Intrusion blocked. Nice try, netrunner. ようこそ。");
      intruding = false;
      return;
    }
    root.classList.add("glitching");
    await sleep(650);
    root.classList.remove("glitching");
    var stop = startRain({ front: true, color: "60,255,143" });
    var ov = el("div", "intrusion");
    ov.setAttribute("role", "status");
    var pre = el("pre", "intrusion-text");
    ov.append(pre, el("p", "boot-hint", "click or press Esc to dismiss"));
    document.body.appendChild(ov);
    var done = false;
    var end = function () {
      if (done) return; done = true;
      removeEventListener("keydown", onKey, true); ov.removeEventListener("click", end);
      ov.classList.add("out"); stop();
      setTimeout(function () { ov.remove(); intruding = false; }, 500);
    };
    var onKey = function (e) { if (e.key === "Escape") end(); };
    addEventListener("keydown", onKey, true);
    ov.addEventListener("click", end);
    for (var i = 0; i < lines.length && !done; i++) {
      for (var j = 0; j < lines[i].length && !done; j++) {
        pre.textContent += lines[i][j];
        if (j % 2) await sleep(9);
      }
      pre.textContent += "\n";
      await sleep(180);
    }
    await sleep(1500);
    end();
  };

  function toast(msg) {
    var t = el("div", "toast", msg);
    t.setAttribute("role", "status");
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("out"); }, 2600);
    setTimeout(function () { t.remove(); }, 3100);
  }

  /* =========================================================== secret inputs
     Konami code or typing "netrunner" -> intrusion; typing "rain" -> katakana rain. */
  var KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
  var kpos = 0, typed = "";
  function isTyping(t) { return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); }
  addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    kpos = k === KONAMI[kpos] ? kpos + 1 : (k === KONAMI[0] ? 1 : 0);
    if (kpos === KONAMI.length) { kpos = 0; DG.intrusion(); return; }
    if (e.key.length === 1) {
      typed = (typed + k).slice(-12);
      if (/netrunner$/.test(typed)) { typed = ""; DG.intrusion(); }
      else if (/rain$/.test(typed)) { typed = ""; startRain({ duration: 7000 }); }
    }
    if ((e.key === "`" || e.key === "/") && !(term && term.open) && !document.querySelector("dialog.menu[open]")) { e.preventDefault(); openTerm(); }
  });

  /* =========================================================== terminal */
  var term = null, termOut, termIn, history = [], hpos = 0;
  var CATEGORIES = [["games", "Games"], ["apps", "Apps"], ["aviation", "Aviation"], ["experiments", "Experiments"]];
  var PROJECTS = PD.map(function (p) { return [p.aliases[0], p.anchor || "/projects/#" + p.slug, p.desc, p]; })
    .concat(CATEGORIES.map(function (c) {
      var names = PD.filter(function (p) { return p.cats.indexOf(c[0]) >= 0; }).map(function (p) { return p.name; });
      return [c[0], "/projects/#" + c[0], names.join(", ")];
    }));
  function print(text, cls) {
    var line = el("div", "t-line" + (cls ? " " + cls : ""), text);
    termOut.appendChild(line);
    termOut.scrollTop = termOut.scrollHeight;
    return line;
  }
  function printLink(label, href, newTab) {
    var line = el("div", "t-line"), a = el("a", null, label);
    a.href = href; if (newTab) { a.target = "_blank"; a.rel = "noopener"; }
    line.appendChild(a); termOut.appendChild(line); termOut.scrollTop = termOut.scrollHeight;
  }
  // "#id" scrolls on this page (or opens it on the home page); "/path/#id" goes to that page.
  function go(target) {
    closeTerm();
    var parts = target.split("#"), path = parts[0], hash = parts[1] ? "#" + parts[1] : "";
    if (path && path !== location.pathname) { location.href = target; return; }
    var t = hash && document.querySelector(hash);
    if (t) { t.scrollIntoView({ behavior: calm() ? "auto" : "smooth", block: "start" }); }
    else if (path) location.hash = hash;
    else location.href = "/" + hash;
  }
  // Navigate to another page of the site, or say so if we're already there.
  function visit(path, label) {
    if (location.pathname === path) { print("You're already on " + label + "."); return; }
    print("→ " + label + " …");
    setTimeout(function () { location.href = path; }, 220);
  }
  // dillongreen.dev is one of its own projects. Opening it from itself goes nowhere, nicely.
  function recurse(msg) {
    if (term && term.open) print(msg, "ok"); else toast(msg);
    if (!calm() && fine) { root.classList.remove("flash"); void root.offsetWidth; root.classList.add("flash"); setTimeout(function () { root.classList.remove("flash"); }, 450); }
  }
  document.querySelectorAll("[data-recurse]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: calm() ? "auto" : "smooth" });
      recurse("> recursion depth exceeded. You're already on dillongreen.dev.");
    });
  });
  function openLive(p) {
    var url = p.url;
    window.open(url, "_blank", "noopener");
    printLink("  (if no tab opened: " + url.replace("https://", "").replace(/\/$/, "") + ")", url, true);
  }
  function fly() {
    print("DG429: Seattle Center, Dillon four-two-niner, level three-five-zero.");
    var row = el("div", "t-fly"), NS = "http://www.w3.org/2000/svg";
    row.setAttribute("aria-hidden", "true");
    var svg = document.createElementNS(NS, "svg"), path = document.createElementNS(NS, "path");
    svg.setAttribute("viewBox", "0 0 46 24");
    // side view of a little twin-jet, nose to the right
    path.setAttribute("d", "M3 13.2c0-1.6 2-2.7 5.5-2.7H35c4.6 0 8.6 1.2 9.8 2.7-1.2 1.5-5.2 2.6-9.8 2.6H8.5C5 15.8 3 14.8 3 13.2ZM4.5 10.6 1.8 3.5h3.6l5.8 7.1ZM17 14.6h7.4l-6.2 6.8h-3.4ZM18.5 11.2l3.2-4.3h3l-1.4 4.3ZM37.5 11.6h3.2l1.6 1.2h-4.8Z");
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path); row.appendChild(svg);
    termOut.appendChild(row); termOut.scrollTop = termOut.scrollHeight;
    var atc = function () { print("Seattle Center: Dillon four-two-niner, radar contact. Proceed direct dillongreen.dev.", "ok"); };
    if (calm()) { row.classList.add("calm"); atc(); return; }
    var ms = 3200;
    row.style.setProperty("--fly-to", (row.clientWidth + 10) + "px");
    row.style.setProperty("--fly-ms", ms + "ms");
    setTimeout(atc, ms * 0.6);
  }
  var COMMANDS = {
    help: function () {
      [["whoami", "who is this"], ["resume", "open the resume (PDF)"], ["contact", "email + GitHub"],
       ["projects · ls", "all projects (ls just lists) · open <name>"], ["pocket429", "open the live ARINC 429 decoder"], ["decode <hex>", "decode an ARINC 429 word, e.g. decode 6445C0C1"],
       ["studio · waitlist", "the studio, and the what-should-I-build form"],
       ["guestbook", "sign it, Web 1.0 style"], ["now", "what I'm doing these days"], ["arcade", "play the web games right on the page"], ["play " + PD.filter(function (g) { return g.play && g.url; }).map(function (g) { return g.aliases[0]; }).join(" · "), "games that are live on the web"], ["open <name>", "any project: crumb, halfsies, par, site …"], ["fly", "request flight level 350"],
       ["theme [light|dark]", "switch theme"], ["clear · exit", ""]]
        .forEach(function (r) { print("  " + r[0].padEnd(20) + r[1]); });
      print("  (there may be a couple of undocumented ones)", "dim");
    },
    whoami: function () {
      print("Dillon Green — flight simulator engineer, Seattle.");
      print("10 years in aviation, 8 hands-on with Boeing/Airbus avionics and full flight simulators (CAE, L3Harris).");
      print("Ships production software by directing AI agents; owns the architecture, review and tests.");
    },
    resume: function () { print("Opening Dillon_Green_Resume.pdf …"); window.open("/Dillon_Green_Resume.pdf", "_blank", "noopener"); },
    contact: function () {
      printLink("  email   " + EMAIL, "mailto:" + EMAIL);
      printLink("  github  github.com/dgreen52", "https://github.com/dgreen52", true);
    },
    // `ls` lists; `projects` lists and then opens the full index at /projects/
    ls: function () { PROJECTS.forEach(function (p) { print("  " + p[0].padEnd(12) + p[2]); }); print("  type: open <name>", "dim"); },
    projects: function () { COMMANDS.ls(); visit("/projects/", "the projects page"); },
    open: function (a) {
      var proj = findProject(a[0]);
      if (proj && proj.recurse) { recurse("> you are already here."); return; }
      if (proj && proj.unavailable) { print("> " + proj.name + ": " + proj.unavailable, "dim"); return; }
      var p = PROJECTS.filter(function (x) { return x[0] === (a[0] || "").toLowerCase() || x[3] === proj; })[0];
      if (!p) return print("open: no such project. Try 'ls'.", "err");
      if (proj && proj.slug === "par" && a[1] === "--case-study") { location.href = "/par.html"; return; }
      if (proj && proj.url) { if (proj.line) print(proj.line); openLive(proj); return; }
      go(p[1]);
    },
    decode: function (a) {
      var hex = (a[0] || "6445C0C1").replace(/^0x/i, "");
      if (!/^[0-9a-f]{1,8}$/i.test(hex)) return print("decode: expected up to 8 hex digits, e.g. decode 6445C0C1", "err");
      var w = parseInt(hex, 16) >>> 0, d = DG.decodeWord(w);
      print("  word    " + d.hex);
      print("  label   " + d.oct + " (octal) · " + d.name);
      print("  sdi     " + d.sdi);
      print("  data    " + d.text);
      print("  ssm     " + d.ssmBits + " · " + d.ssm);
      print("  parity  " + (d.parityOk ? "OK (odd)" : "ERROR (even)"), d.parityOk ? "ok" : "err");
      if (DG.loadWord) { DG.loadWord(w); print("  (loaded into the word on this page)", "dim"); }
    },
    theme: function (a) {
      var t = a[0] || (DG.currentTheme() === "dark" ? "light" : "dark");
      if (t !== "light" && t !== "dark") return print("theme: light or dark", "err");
      DG.setTheme(t); print("theme → " + t);
    },
    sudo: function () {
      print("[sudo] password for visitor: ********");
      print("visitor is not in the sudoers file. This incident will be reported to NODE 7.", "err");
    },
    studio: function () { visit("/studio/", "the studio"); },
    guestbook: function () { visit("/guestbook/", "the guestbook"); },
    arcade: function () { visit("/arcade/", "the arcade"); },
    now: function () { visit("/now/", "the now page"); },
    waitlist: function () {
      if (document.getElementById("waitlist")) { print("→ the waitlist form"); go("#waitlist"); return; }
      print("→ the waitlist form …");
      setTimeout(function () { location.href = "/studio/#waitlist"; }, 220);
    },
    play: function (a) {
      var p = findProject(a[0]);
      var games = PD.filter(function (g) { return g.play && g.url; }).map(function (g) { return g.aliases[0]; }).join(", ");
      if (!p || !p.play) return print((a[0] ? "play: no game called '" + a[0] + "'. " : "play: ") + "try " + games, "err");
      if (p.unavailable || !p.url) return print("> " + p.name + ": " + (p.unavailable || "no public build yet"), "dim");
      print("Preflight checklist … complete.");
      if (p.line) print(p.line, "ok");
      openLive(p);
    },
    fly: function () { fly(); },
    pocket429: function () { COMMANDS.open(["pocket429"]); },
    netrunner: function () { closeTerm(); DG.intrusion(); },
    hack: function () { COMMANDS.netrunner(); },
    rain: function () { print(calm() ? "rain: reduced motion is on, so it stays dry in here." : "Forecast: katakana."); startRain({ duration: 7000 }); },
    date: function () { print(new Date().toString()); },
    echo: function (a) { print(a.join(" ")); },
    clear: function () { termOut.textContent = ""; },
    exit: function () { closeTerm(); }
  };
  function run(line) {
    var parts = line.trim().split(/\s+/), cmd = (parts.shift() || "").toLowerCase();
    print("dillon@dg:~$ " + line, "cmd");
    if (!cmd) return;
    history.push(line); hpos = history.length;
    if (Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) COMMANDS[cmd](parts); // not "toString" & co.
    else print("command not found: " + cmd + ". Try 'help'.", "err");
  }
  function buildTerm() {
    term = el("dialog", "term");
    term.setAttribute("aria-label", "Terminal");
    var bar = el("div", "term-bar");
    bar.append(el("span", null, "dillon@dg — terminal"));
    var x = el("button", "term-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Close terminal");
    x.addEventListener("click", closeTerm);
    bar.append(x);
    termOut = el("div", "term-out"); termOut.setAttribute("role", "log"); termOut.setAttribute("aria-live", "polite");
    var form = el("form", "term-form");
    var ps = el("label", "term-ps", "dillon@dg:~$"); ps.htmlFor = "term-in";
    termIn = el("input", "term-in"); termIn.id = "term-in";
    termIn.setAttribute("autocomplete", "off"); termIn.setAttribute("autocapitalize", "off");
    termIn.setAttribute("spellcheck", "false"); termIn.setAttribute("enterkeyhint", "go");
    form.append(ps, termIn);
    form.addEventListener("submit", function (e) { e.preventDefault(); var v = termIn.value; termIn.value = ""; run(v); });
    termIn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowUp" && history.length) { hpos = Math.max(0, hpos - 1); termIn.value = history[hpos]; e.preventDefault(); }
      else if (e.key === "ArrowDown") { hpos = Math.min(history.length, hpos + 1); termIn.value = history[hpos] || ""; e.preventDefault(); }
      else if (e.key === "Tab") {
        var v = termIn.value.trim().toLowerCase(), hits = Object.keys(COMMANDS).filter(function (c) { return v && c.indexOf(v) === 0; });
        if (hits.length === 1) { termIn.value = hits[0] + " "; } e.preventDefault();
      }
    });
    term.addEventListener("click", function (e) { if (e.target === term) closeTerm(); });
    term.addEventListener("close", function () { if (lastFocus) lastFocus.focus(); });
    term.append(bar, termOut, form);
    document.body.appendChild(term);
    print("DG/OS 8.0 — type 'help' to see what's here.", "dim");
  }
  var lastFocus = null;
  function openTerm() {
    if (!term) buildTerm();
    if (term.open) return;
    lastFocus = document.activeElement;
    term.showModal();
    termIn.focus();
  }
  function closeTerm() { if (term && term.open) term.close(); }
  DG.openTerm = openTerm;
  document.querySelectorAll("[data-term]").forEach(function (b) {
    b.hidden = false;
    b.addEventListener("click", openTerm);
  });
  document.querySelectorAll("[data-intrusion]").forEach(function (b) {
    b.hidden = false;
    b.addEventListener("click", function () { DG.intrusion(); });
  });

  /* =========================================================== tilt + glow */
  function tilt(selector, max) {
    document.querySelectorAll(selector).forEach(function (card) {
      var raf = 0, ev = null;
      card.addEventListener("pointermove", function (e) {
        if (calm()) return;
        ev = e;
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = 0;
          var r = card.getBoundingClientRect();
          var x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
          card.style.setProperty("--mx", (x * 100).toFixed(1) + "%");
          card.style.setProperty("--my", (y * 100).toFixed(1) + "%");
          card.style.setProperty("--rx", ((0.5 - y) * max).toFixed(2) + "deg");
          card.style.setProperty("--ry", ((x - 0.5) * max).toFixed(2) + "deg");
          card.classList.add("is-tilting");
        });
      });
      card.addEventListener("pointerleave", function () {
        card.classList.remove("is-tilting");
        card.style.setProperty("--rx", "0deg"); card.style.setProperty("--ry", "0deg");
      });
    });
  }
  if (fine) {
    tilt(".project", 2.2);
    tilt(".tile", 6);
    ambient();
  }

  /* =========================================================== ambient cursor grid
     One fixed layer behind the whole page (mouse/trackpad only). A single passive mousemove
     listener records the cursor; one rAF per frame moves the glow box (transform) and shifts its
     grid (background-position) so the lit lines stay on the page's 48px grid while scrolling.
     Off under reduced motion, when the tab is hidden or the pointer leaves the window. */
  function ambient() {
    var wrap = el("div", "ambient"), glow = el("div", "ambient-glow");
    wrap.setAttribute("aria-hidden", "true");
    wrap.appendChild(glow);
    document.body.insertBefore(wrap, document.body.firstChild);
    var R = 300, G = 48, x = 0, y = 0, seen = false, raf = 0, lit = false;
    var mod = function (n) { return ((n % G) + G) % G; };
    var hide = function () { if (lit) { lit = false; wrap.classList.remove("on"); } };
    var paint = function () {
      raf = 0;
      if (!seen || calm() || document.hidden) { hide(); return; }
      var gx = Math.round(x - R), gy = Math.round(y - R), sy = Math.round(window.scrollY);
      glow.style.transform = "translate3d(" + gx + "px," + gy + "px,0)";
      var bx = -mod(gx) + "px ", by = -mod(gy + sy) + "px";
      glow.style.backgroundPosition = "0 0, " + bx + by + ", " + bx + by;
      if (!lit) { lit = true; wrap.classList.add("on"); }
    };
    var queue = function () { if (!raf) raf = requestAnimationFrame(paint); };
    addEventListener("mousemove", function (e) { x = e.clientX; y = e.clientY; seen = true; queue(); }, { passive: true });
    addEventListener("scroll", function () { if (lit) queue(); }, { passive: true });
    document.documentElement.addEventListener("mouseleave", function () { seen = false; hide(); });
    document.addEventListener("visibilitychange", function () { if (document.hidden) hide(); });
    if (mqReduce.addEventListener) mqReduce.addEventListener("change", function () { if (calm()) hide(); });
  }

  boot();
  if (params.has("intrusion")) setTimeout(DG.intrusion, 300);
})();
