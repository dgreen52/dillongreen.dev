// /arcade/: play the web games in the page. Click-to-load only: until "Play here" is pressed a cabinet is
// just its picture (and muted gameplay clip); pressing it swaps a sandboxed <iframe> into the screen and
// unloads whatever game was running before, so only one plays at a time. Phones (and short landscape
// phones) never embed: the "Play in a new tab" link is their play button. Markup: tools/build_projects.py.
// Frames may only come from https://*.dillon-eu-green.workers.dev (frame-src in site/_headers).
(function () {
  "use strict";
  var root = document.querySelector(".arcade");
  var cabs = Array.prototype.slice.call(document.querySelectorAll("[data-cab]"));
  if (!root || !cabs.length) return;

  // Same query as the embed-mode block in arcade.css.
  var EMBED_MQ = "(min-width: 720px) and (pointer: fine), (min-width: 720px) and (min-height: 501px)";
  var HOST = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.dillon-eu-green\.workers\.dev\/?$/;
  var mq = window.matchMedia ? matchMedia(EMBED_MQ) : { matches: true };
  var calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var live = document.querySelector("[data-arcade-live]");
  var current = null; // { cab, frame }

  var fsEnabled = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  if (fsEnabled) root.classList.add("can-fs");

  function say(text) { if (live) { live.textContent = ""; live.textContent = text; } }
  function nameOf(cab) { return cab.getAttribute("data-name") || "the game"; }
  function srcOf(cab) {
    var u = cab.getAttribute("data-embed") || "";
    return HOST.test(u) ? u : null; // anything else would be refused by the CSP anyway
  }

  function stop(focusBack) {
    if (!current) return;
    var cab = current.cab, frame = current.frame, stage = cab.querySelector("[data-stage]");
    current = null;
    try { frame.src = "about:blank"; } catch (e) { /* ignore */ }
    stage.textContent = ""; // removing the frame unloads the game: audio, timers, everything
    stage.classList.remove("is-loaded");
    cab.classList.remove("is-playing");
    say("Stopped " + nameOf(cab) + ".");
    if (focusBack) { var b = cab.querySelector(".cab-play"); if (b) b.focus({ preventScroll: true }); }
  }

  function play(cab) {
    var src = srcOf(cab);
    if (!src) return;
    if (!mq.matches) { // a phone after all (rotated, resized): the new-tab link is the way in
      var a = cab.querySelector(".cab-open");
      if (a) a.click();
      return;
    }
    if (current && current.cab === cab) return;
    stop(false);
    var name = nameOf(cab), stage = cab.querySelector("[data-stage]");
    var loading = document.createElement("p");
    loading.className = "cab-loading";
    loading.setAttribute("aria-hidden", "true");
    loading.appendChild(document.createTextNode("Loading " + name + " …"));
    var small = document.createElement("small");
    small.textContent = "insert coin";
    loading.appendChild(small);

    var frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-pointer-lock allow-popups");
    frame.setAttribute("allow", "fullscreen; autoplay; gamepad");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("title", name + " (game)");
    frame.addEventListener("load", function () {
      if (!current || current.frame !== frame) return;
      stage.classList.add("is-loaded");
      try { frame.focus({ preventScroll: true }); } catch (e) { /* ignore */ } // keys go to the game; don't yank the page
    });
    frame.src = src;
    stage.textContent = "";
    stage.appendChild(loading);
    stage.appendChild(frame);
    current = { cab: cab, frame: frame };
    cab.classList.add("is-playing");
    say("Playing " + name + ". Use Stop to end it, or Fullscreen.");
    // the cabinet just grew to full width: bring the whole screen into view
    cab.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
  }

  function fullscreen(cab) {
    if (!current || current.cab !== cab) return;
    var f = current.frame;
    var req = f.requestFullscreen || f.webkitRequestFullscreen;
    if (!req) return;
    try {
      var p = req.call(f);
      if (p && p.catch) p.catch(function () { say("Fullscreen isn't available here."); });
    } catch (e) { say("Fullscreen isn't available here."); }
  }

  cabs.forEach(function (cab) {
    if (!srcOf(cab)) return;
    cab.addEventListener("click", function (e) {
      var t = e.target;
      if (t.closest("[data-play]")) { play(cab); return; }
      if (t.closest("[data-stop]")) { stop(true); return; }
      if (t.closest("[data-fullscreen]")) { fullscreen(cab); return; }
      // the picture itself is a big play button (pointer only; the real button is the keyboard way in)
      if (t.closest(".cab-poster") && mq.matches && !cab.classList.contains("is-playing")) play(cab);
    });
  });

  // switched into phone mode with a game running (window resized, device rotated): unload it
  var onMode = function () { if (!mq.matches) stop(false); };
  if (mq.addEventListener) mq.addEventListener("change", onMode);
  else if (mq.addListener) mq.addListener(onMode);

  // leaving the page (bfcache): don't keep a game running in a frozen page
  window.addEventListener("pagehide", function () { stop(false); });
})();
