const STATIC_CACHE = "ecoverde-static-v6";
const RUNTIME_CACHE = "ecoverde-runtime-v6";

const PRECACHE_URLS = [
  "./",
  "index.html",
  "css/style.css",
  "assets/favicon.svg",
  "data/ecoverde.geojson",
  "js/main.js",
  "js/map-controller.js",
  "js/graph.js",
  "js/style.js",
  "js/utils.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) return;

  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin) {
    if (request.destination === "image") {
      event.respondWith(cacheFirst(request));
    }
    return;
  }

  const isMapData = url.pathname.endsWith("/data/ecoverde.geojson") || url.pathname.endsWith("data/ecoverde.geojson");

  if (isMapData) {
    event.respondWith(networkFirstMapData(request));
    return;
  }

  if (request.destination === "document") {
    event.respondWith(networkFirstDocument(request));
    return;
  }

  if (request.destination === "script" || request.destination === "style") {
    event.respondWith(networkFirstAsset(request));
    return;
  }

  if (request.destination === "image") {
    event.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request, { cache: "no-store" });
  const cache = await caches.open(RUNTIME_CACHE);
  cache.put(request, response.clone());
  return response;
}

async function networkFirstAsset(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request, { cache: "no-store" });
    cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error("Asset unavailable");
  }
}

async function networkFirstDocument(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request, { cache: "no-store" });
    cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const byRequest = await cache.match(request);
    if (byRequest) return byRequest;
    const fallback = await caches.match("index.html");
    if (fallback) return fallback;
    throw new Error("Document unavailable");
  }
}

async function networkFirstMapData(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request, { cache: "no-store" });
    cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error("Map data unavailable");
  }
}
