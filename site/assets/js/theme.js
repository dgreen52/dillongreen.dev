// Runs in <head> before first paint: apply a saved theme choice, if any.
// Without one the site uses its night palette (the default); daylight is opt-in.
(function () {
  // "js" lets CSS collapse long mobile copy behind "More" buttons only when the buttons can work.
  document.documentElement.classList.add("js");
  try {
    var t = localStorage.getItem("theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    if (t === "light") {
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute("content", "#eef3f4");
    }
  } catch (e) { /* storage blocked: stay on the default night palette */ }
})();
