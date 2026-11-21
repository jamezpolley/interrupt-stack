// App-shell service worker. Never touches /api/ or non-GET requests: sync is the app's job (sync.js).
// Bump CACHE when the list of shell files changes; old caches are deleted on activate.
const CACHE = "interrupt-stack-v20";
// Everything is relative to where this file is served from, so the app works under any path or host.
const BASE = new URL("./", self.location).href;
const BASE_PATH = new URL(BASE).pathname;
const SHELL = [
  "",
  "app.js",
  "core.js",
  "sync.js",
  "queue.js",
  "version-line.js",
  "links.js",
  "times.js",
  "edit.js",
  "pane.js",
  "idb.js",
  "events.js",
  "refresh.js",
  "today.js",
  "again.js",
  "install.js",
  "status-text.js",
  "debug-text.js",
  "config.js",
  "version.js",
  "style.css",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
].map((p) => BASE + p);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Never cached (navigations to /login included, so the sign-in redirect always reaches the network): the server's own endpoints, and the static version's version.json (how it learns of an update).
  const live = url.pathname.startsWith(BASE_PATH + "api/") || ["metrics", "healthz", "login", "version.json"].some((n) => url.pathname === BASE_PATH + n);
  if (req.method !== "GET" || url.origin !== location.origin || live) return;

  // Cache first so the app opens instantly and offline; refresh the cached copy in the background.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === "navigate" ? BASE : req;
      const cached = await cache.match(key);
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => undefined);
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      return (await refresh) ?? new Response("offline", { status: 503 });
    }),
  );
});
