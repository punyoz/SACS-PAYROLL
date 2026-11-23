/**
 * Part I (2026-11-23): one sidebar item per module, tabs inside the page.
 * A nav item may carry `tabs: [{ id, label, module? }]`; each tab is an
 * existing page (its own ?page= URL, permission and filters, unchanged), so
 * old links open the right tab. The item shows when any tab is allowed, opens
 * its first allowed tab, is active on any of them, and sums their badges.
 */

/** The item's tabs (an item without tabs is its own single tab). */
export const tabsOf = (item) => (Array.isArray(item?.tabs) && item.tabs.length ? item.tabs : [item]);

/** The tabs this role may open. */
export const allowedTabs = (item, can = () => true) => tabsOf(item).filter((t) => !t.module || can(t.module));

/** Every page of a nav (each tab once), with the sidebar item it belongs to. */
export function navPages(nav) {
  return (nav || []).flatMap((group) => group.items.flatMap((item) => tabsOf(item).map((tab) => ({ ...tab, icon: tab.icon || item.icon, parent: item }))));
}

/** True when this item holds the page. */
export const holdsPage = (item, id) => tabsOf(item).some((t) => t.id === id);

/** The sidebar item holding the page, or null. */
export function itemOfPage(nav, id) {
  for (const group of nav || []) for (const item of group.items) if (holdsPage(item, id)) return item;
  return null;
}

/** The item's badge: the sum of its allowed tabs' badges. */
export const itemBadge = (item, badges = {}, can) => allowedTabs(item, can).reduce((sum, t) => sum + (Number(badges[t.id]) || 0), 0);
