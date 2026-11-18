// App-shell service worker. Never touches /api/ or non-GET requests: sync is the app's job (sync.js).
// Bump CACHE when the list of shell files changes; old caches are deleted on activate.
const CACHE = "interrupt-stack-v4";
const SHELL = [
  "/",
  "/app.js",
  "/sync.js",
  "/idb.js",
  "/events.js",
  "/refresh.js",
  "/today.js",
  "/version.js",
  "/style.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

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
  const live = url.pathname.startsWith("/api/") || url.pathname === "/metrics" || url.pathname === "/healthz";
  if (req.method !== "GET" || url.origin !== location.origin || live) return;

  // Cache first so the app opens instantly and offline; refresh the cached copy in the background.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === "navigate" ? "/" : req;
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
