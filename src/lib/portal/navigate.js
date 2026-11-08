/**
 * Open another page of the current portal from anywhere inside it (a
 * dashboard card's "View all"). AppShell listens for the event.
 */
export const NAVIGATE_EVENT = "sacs:navigate";

export function openPortalPage(pageId) {
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: pageId }));
}
