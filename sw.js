const CACHE_NAME = "scan-dcs-v5";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(
        CORE_ASSETS.map(async (asset) => {
          const response = await fetch(asset, { cache: "reload" });
          if (!response.ok) {
            throw new Error(`Cache install failed: ${asset}`);
          }
          await cache.put(asset, response);
        })
      );
    })
  );

  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          return key === CACHE_NAME
            ? Promise.resolve(false)
            : caches.delete(key);
        })
      )
    )
  );

  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  const isNetworkFirst =
    request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css");

  if (isNetworkFirst) {
    event.respondWith(networkFirst_(request));
    return;
  }

  event.respondWith(cacheFirst_(request));
});

async function networkFirst_(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });

    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }

    return response;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;

    if (request.mode === "navigate") {
      const fallback = await caches.match("./index.html");
      if (fallback) return fallback;
    }

    return new Response("Offline", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }
}

async function cacheFirst_(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);

    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }

    return response;
  } catch (_) {
    return new Response("Offline", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }
}
