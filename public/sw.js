/**
 * Offline support. One requirement drives every decision here: cook mode has
 * to keep working when the kitchen wifi drops mid-recipe.
 *
 * SAVED RECIPES ONLY. The corpus is ~14,000 rows and none of it belongs on a
 * phone, so /api/discover and /api/search are never cached — they're
 * network-only and simply fail offline, which is correct. You don't browse for
 * new recipes with no signal; you cook the one already open.
 *
 * Bump CACHE_VERSION to invalidate everything after changing this file.
 */
const CACHE_VERSION = "v2";
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const DATA_CACHE = `data-${CACHE_VERSION}`;
const IMAGE_CACHE = `images-${CACHE_VERSION}`;

/** Never cached: corpus-scale, or state-changing, or both. */
const NETWORK_ONLY = [
  "/api/discover",
  "/api/search",
  "/api/swipe",
  "/api/import",
  "/api/import-ui",
  "/api/preferences",
];

self.addEventListener("install", (event) => {
  // Take over immediately rather than waiting for every tab to close — this is
  // a single-user app on a phone, and a stale worker helps nobody.
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(["/library"]).catch(() => {}))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL_CACHE, DATA_CACHE, IMAGE_CACHE];
      for (const key of await caches.keys()) {
        if (!keep.includes(key)) await caches.delete(key);
      }
      await self.clients.claim();
      await precacheLibrary();
    })()
  );
});

/** Re-run the precache when the app asks — after an import or a swipe-save. */
self.addEventListener("message", (event) => {
  if (event.data === "PRECACHE_LIBRARY") {
    event.waitUntil(precacheLibrary());
  }
});

/**
 * Walks the library and caches each recipe's detail JSON and hero image.
 *
 * Driven from the worker rather than the page so there's exactly one place
 * that decides what goes offline, and it can run without a tab open.
 */
async function precacheLibrary() {
  try {
    const res = await fetch("/api/recipes", { credentials: "same-origin" });
    if (!res.ok) return;
    const { recipes = [] } = await res.json();

    const dataCache = await caches.open(DATA_CACHE);
    await dataCache.put("/api/recipes", res.clone());

    const imageCache = await caches.open(IMAGE_CACHE);

    for (const recipe of recipes) {
      try {
        const detailUrl = `/api/recipes/${recipe.id}`;
        const detail = await fetch(detailUrl, { credentials: "same-origin" });
        if (detail.ok) await dataCache.put(detailUrl, detail.clone());

        // Also cache the page itself so a cold open works offline.
        const page = await fetch(`/recipe/${recipe.id}`, { credentials: "same-origin" });
        if (page.ok) {
          const shell = await caches.open(SHELL_CACHE);
          await shell.put(`/recipe/${recipe.id}`, page.clone());
        }

        if (recipe.image_url) {
          const img = await fetch(recipe.image_url, { mode: "no-cors" });
          if (img) await imageCache.put(recipe.image_url, img.clone());
        }
      } catch {
        // One recipe failing to cache shouldn't abort the rest.
      }
    }
  } catch {
    // Offline during precache is fine — it runs again next activate/message.
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && NETWORK_ONLY.some((p) => url.pathname.startsWith(p))) {
    return; // straight to the network; failing offline is the honest outcome
  }

  // Hashed build assets are immutable — cache-first is safe and makes a cold
  // offline open fast.
  if (sameOrigin && url.pathname.startsWith("/_next/static")) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  if (sameOrigin && url.pathname.startsWith("/api/recipes")) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(navigationHandler(request));
    return;
  }

  if (request.destination === "image") {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  if (sameOrigin) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) (await caches.open(cacheName)).put(request, res.clone());
    return res;
  } catch {
    return cached ?? Response.error();
  }
}

/**
 * Fresh when online, cached when not. The reverse would show a stale library
 * for as long as the cache lived, and a recipe you just saved not appearing is
 * a worse bug than a slightly slower load.
 */
async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res.ok) (await caches.open(cacheName)).put(request, res.clone());
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error("offline and not cached");
  }
}

async function navigationHandler(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Fall back to the library rather than a browser error page — it's the
    // one screen guaranteed to be cached and it links to everything saved.
    const shell = await caches.match("/library");
    if (shell) return shell;
    return new Response(
      "<h1>Offline</h1><p>This page isn't saved for offline use.</p>",
      { headers: { "Content-Type": "text/html" }, status: 503 }
    );
  }
}
