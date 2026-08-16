"use client";

import { useEffect, useState } from "react";

/**
 * Registers the service worker and shows a bar when the connection drops.
 *
 * The bar matters more than it looks: offline, Discover and search genuinely
 * stop working, and without an explanation that reads as the app being broken
 * rather than the wifi being out.
 */
export function Offline() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      if (process.env.NODE_ENV === "production") {
        navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
          // No service worker means no offline support, not a broken app.
        });
      } else {
        // In dev, /_next/static chunks aren't content-hashed, so the worker's
        // cache-first rule for them pins the browser to whichever build was
        // cached first — you keep seeing an old UI while the server serves a
        // new one. Tear it down rather than merely skipping registration: an
        // already-installed worker keeps serving until it's unregistered.
        void navigator.serviceWorker
          .getRegistrations()
          .then((regs) => Promise.all(regs.map((r) => r.unregister())))
          .then(() => caches?.keys())
          .then((keys) => Promise.all((keys ?? []).map((k) => caches.delete(k))))
          .catch(() => {});
      }
    }

    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-50 bg-ink px-4 py-2 text-center text-base text-paper"
      style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top))" }}
    >
      Offline — your saved recipes still work
    </div>
  );
}

/**
 * How long to wait after the last save before re-walking the library.
 *
 * Each walk is three sequential requests per saved recipe — 174 at a library of
 * 58, and it grows linearly. Firing that on every right swipe meant a rapid
 * save streak queued several full walks against a browser connection pool of
 * six, competing with the deck's own refills and swipe writes.
 *
 * A few seconds is the right trade: the cache exists for the drive home, not
 * for the second after a tap, and nothing reads it in between.
 */
const PRECACHE_DEBOUNCE_MS = 5000;
let precacheTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tells the worker to re-walk the library. Call after anything that changes
 * what's saved, so a recipe you just kept is available on the drive home.
 *
 * Debounced: a streak of saves produces one walk, not one per save.
 */
export function refreshOfflineCache() {
  if (typeof navigator === "undefined") return;
  if (precacheTimer) clearTimeout(precacheTimer);
  precacheTimer = setTimeout(() => {
    precacheTimer = null;
    navigator.serviceWorker?.ready
      .then((reg) => reg.active?.postMessage("PRECACHE_LIBRARY"))
      .catch(() => {});
  }, PRECACHE_DEBOUNCE_MS);
}
