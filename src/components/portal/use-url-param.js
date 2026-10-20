"use client";

import * as React from "react";

/**
 * A view choice (a tab, a filter, the open record) kept in the address as
 * ?key=value, so a refresh, Back or a shared link reopens the same view
 * instead of the default (2026-10-20 audit). Like useState; the value is a
 * string, and the fallback is left out of the address.
 *
 * The portals render only on the client (PortalSessionProvider waits for the
 * stored sign-in), so reading window on the first render is safe. Keys are
 * per page (e.g. "pa_tab") because the portal keeps other pages' parameters
 * in the address while it moves between pages (usePersistedPage).
 */
export function useUrlParam(key, fallback = "") {
  const [value, setValue] = React.useState(() => {
    try {
      return new URLSearchParams(window.location.search).get(key) ?? fallback;
    } catch {
      return fallback;
    }
  });

  const update = React.useCallback((next) => {
    setValue((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      try {
        const params = new URLSearchParams(window.location.search);
        if (resolved === fallback || resolved === "" || resolved === null || resolved === undefined) params.delete(key);
        else params.set(key, String(resolved));
        const query = params.toString();
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      } catch {
        // history unavailable: the choice still applies to this visit
      }
      return resolved;
    });
  }, [key, fallback]);

  return [value, update];
}
