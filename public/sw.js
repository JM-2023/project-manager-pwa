// v2: prunes superseded hashed build assets so the cache stops growing across
// deploys (v1 kept every /assets/name-HASH.ext forever).
const CACHE_NAME = "project-manager-shell-v2";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/theme-init.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// Vite emits hashed assets as /assets/<base>-<hash>.<ext>. When a new hash for
// the same base+ext lands in the cache, every older sibling is dead weight
// from a previous deploy and can be dropped.
const HASHED_ASSET = /^\/assets\/(.+)-[A-Za-z0-9_-]+\.(\w+)$/;

async function pruneSupersededAssets(cache, request) {
  const url = new URL(request.url);
  const match = url.pathname.match(HASHED_ASSET);
  if (!match) {
    return;
  }
  const [, base, ext] = match;
  const keys = await cache.keys();
  await Promise.all(
    keys.map((key) => {
      const keyUrl = new URL(key.url);
      if (keyUrl.pathname === url.pathname) {
        return undefined;
      }
      const keyMatch = keyUrl.pathname.match(HASHED_ASSET);
      if (keyMatch && keyMatch[1] === base && keyMatch[2] === ext) {
        return cache.delete(key);
      }
      return undefined;
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(async (cache) => {
          await cache.put(request, copy);
          await pruneSupersededAssets(cache, request);
        });
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
  );
});
