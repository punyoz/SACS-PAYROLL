/**
 * Open another page of the current portal from anywhere inside it (a
 * dashboard card's "View all"). AppShell listens for the event.
 */
export const NAVIGATE_EVENT = "sacs:navigate";

export function openPortalPage(pageId) {
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: pageId }));
}

/** The address of a page of the current portal, with its filters: "?page=hr-attendance&hr_att_status=Late". */
export function portalHref(pageId, params = {}) {
  return `?${new URLSearchParams({ page: pageId, ...params })}`;
}

/** A plain left click (or Enter); Ctrl / Shift / middle click keep the browser's own "open in new tab". */
export function isPlainClick(event) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Open a portal link in place, without a reload: the new address becomes a
 * history entry and usePersistedPage (which listens for popstate, as for
 * Back) shows the page it names, under the same permission check as always.
 * The page then reads its filters from the address as on a refresh.
 */
export function followPortalLink(event) {
  if (!isPlainClick(event)) return;
  event.preventDefault();
  window.history.pushState(null, "", event.currentTarget.href);
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  window.scrollTo?.({ top: 0 });
}

/** This same page's address with some filters changed (a summary card above its own table). */
export function currentPageHref(params) {
  const p = new URLSearchParams(window.location.search);
  Object.entries(params).forEach(([key, value]) => p.set(key, value));
  return `?${p}`;
}
