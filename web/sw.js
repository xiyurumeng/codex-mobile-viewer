const SHELL_CACHE_PREFIX = "codex-mobile-viewer-shell-";
const CACHE = `${SHELL_CACHE_PREFIX}v5`;
const SHELL = ["./", "index.html", "theme-init.js", "styles.css", "app.js", "ui-utils.js", "network-utils.js", "app.webmanifest"];
const SHELL_PATHS = new Set(SHELL.map((entry) => new URL(entry, self.location.href).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  const pathname = new URL(event.request.url).pathname;
  if (!SHELL_PATHS.has(pathname)) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
