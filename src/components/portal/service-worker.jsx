"use client";

import * as React from "react";

/**
 * Registers public/sw.js (alpha test D1) in production builds only: in
 * development a service worker would hold on to stale hot-reload files. The
 * worker caches the public app shell only, never /api/ data.
 */
export function ServiceWorkerRegister() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
