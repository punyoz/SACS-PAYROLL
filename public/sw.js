/*
 * SACS Payroll service worker (alpha test D1, 2026-11-09).
 *
 * Caches ONLY the public app shell: Next.js build files (/_next/static/,
 * fingerprinted), the brand images and icons, and the offline page. It never
 * caches, stores or replays anything from /api/ (payroll, payslips,
 * attendance, accounts) or any page HTML: those always go to the network,
 * so no payroll data is kept on the device. With no connection a page
 * navigation shows /offline.html.
 */
const CACHE = "sacs-shell-v1";
const SHELL = ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png", "/brand/logo-160.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isShellAsset(url) {
  return url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname.startsWith("/brand/") || url.pathname === "/offline.html";
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never touch the API or anything private: straight to the network.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/monitoring")) return;

  // Pages: always the network (fresh, signed-in data). Offline: the offline page.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }

  // Fingerprinted build files, brand images, icons: cache first.
  if (isShellAsset(url)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })),
    );
  }
});
