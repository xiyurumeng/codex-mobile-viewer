(() => {
  const storageKey = "cmv.theme";
  let stored = null;
  try { stored = localStorage.getItem(storageKey); } catch {}
  const prefersDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const theme = stored === "dark" || stored === "light" ? stored : (prefersDark ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  document.querySelector("meta[name='theme-color']")
    ?.setAttribute("content", theme === "dark" ? "#161816" : "#f5f5f2");
})();
