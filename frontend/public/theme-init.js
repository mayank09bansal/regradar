// Runs before first paint so a saved dark theme does not flash light.
// A separate file because the Content-Security-Policy forbids inline scripts.
(function () {
  var theme = "light";
  try {
    theme = localStorage.getItem("regradar-theme") || "light";
  } catch (e) {
    /* storage blocked: keep the default */
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
