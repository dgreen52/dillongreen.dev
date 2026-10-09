// Gameplay clips on the game cards. Each card keeps its still screenshot; when the card is on screen
// this swaps in a short muted loop recorded from the real game (tools/capture_clips.js), and pauses it
// again when the card leaves. Markup (written by tools/build_projects.py, or by hand on the home page):
//   <div class="clip-box" data-clip-webm="/assets/clips/x.webm?v=…" data-clip-mp4="/assets/clips/x.mp4?v=…">
//     <img …>  <span class="clip-hud" aria-hidden="true">▶ LIVE CAPTURE</span>
//   </div>
// Nothing loads under prefers-reduced-motion or Save-Data, in tiny thumbnails, or without
// IntersectionObserver; the video sits absolutely over the poster, so it can never move the layout.
(function () {
  "use strict";
  var boxes = Array.prototype.slice.call(document.querySelectorAll("[data-clip-mp4]"));
  if (!boxes.length || !("IntersectionObserver" in window) || !window.matchMedia) return;
  var conn = navigator.connection || {};
  if (conn.saveData) return;
  var reduce = matchMedia("(prefers-reduced-motion: reduce)");
  var probe = document.createElement("video");
  if (!probe.canPlayType) return;
  var webm = /probably|maybe/.test(probe.canPlayType('video/webm; codecs="vp9"'));
  var mp4 = /probably|maybe/.test(probe.canPlayType('video/mp4; codecs="avc1.640028"'));
  if (!webm && !mp4) return;
  var MIN_W = 200; // smaller than this (the phone list thumbnails) the still says as much as the clip
  var visible = new Set();

  function make(box) {
    var v = document.createElement("video");
    v.className = "clip-video";
    v.muted = true; v.defaultMuted = true; v.setAttribute("muted", "");
    v.playsInline = true; v.setAttribute("playsinline", "");
    v.loop = true; v.preload = "auto";
    v.disablePictureInPicture = true; v.setAttribute("disablepictureinpicture", "");
    v.setAttribute("aria-hidden", "true"); v.tabIndex = -1;
    v.addEventListener("playing", function () { box.classList.add("is-live"); });
    v.addEventListener("error", function () { box.classList.remove("is-live"); v.remove(); box._clip = "dead"; });
    v.src = box.getAttribute(webm ? "data-clip-webm" : "data-clip-mp4");
    box.appendChild(v);
    return v;
  }
  function play(box) {
    if (reduce.matches || document.hidden || box._clip === "dead" || box.clientWidth < MIN_W) return;
    var v = box._clip || (box._clip = make(box));
    var p = v.play();
    if (p && p.catch) p.catch(function () {}); // autoplay refused (e.g. Low Power Mode): the still stays
  }
  function pause(box) { if (box._clip && box._clip !== "dead") box._clip.pause(); }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting && e.intersectionRatio >= 0.35) { visible.add(e.target); play(e.target); }
      else { visible.delete(e.target); pause(e.target); }
    });
  }, { threshold: [0, 0.35, 0.6] });
  boxes.forEach(function (b) { io.observe(b); });

  document.addEventListener("visibilitychange", function () {
    visible.forEach(document.hidden ? pause : play);
  });
  var onReduce = function () {
    if (!reduce.matches) { visible.forEach(play); return; }
    boxes.forEach(function (b) { pause(b); b.classList.remove("is-live"); }); // back to the still
  };
  if (reduce.addEventListener) reduce.addEventListener("change", onReduce);
})();
