"use client";

import * as React from "react";
import {
  BellIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  ChevronsUpDownIcon,
  KeyRoundIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  RefreshCwIcon,
  SunIcon,
  UserRoundIcon,
} from "lucide-react";
import { UserAvatar } from "@/components/portal/user-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChangePasswordDialog, EditAccountDialog } from "@/components/portal/account-dialogs";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { HelpTour, useFirstTimeHelp } from "@/components/portal/help-tour";
import { usePortalSession, useSystemName } from "@/components/portal/session";
import { apiFetch, BACKGROUND, jsonBody } from "@/lib/portal/api";
import { useUiTheme } from "@/components/theme";
import { initialsOf } from "@/lib/portal/format";
import { cn } from "@/lib/utils";
import { vengeanceLineHover, vengeanceLineHoverHost } from "@/components/vengeance/line-hover";
import { NAVIGATE_EVENT } from "@/lib/portal/navigate";

/**
 * The frame every React portal shares: the green sidebar (collapsible to
 * icons on desktop, a sheet on phones) with the school seal and the role's
 * links, a top bar with the page title, refresh, notifications and theme, and
 * the account menu (profile, change password, appearance, sign out).
 *
 * nav: [{ section, items: [{ id, label, icon, module? }] }]. An item with a
 * `module` shows only when the session's permissions allow reading it.
 * badges: { [item id]: count } shows a count on that item (e.g. pending
 * payroll runs on HR's Payroll Approval).
 */

const ROLE_LABEL = {
  super_admin: "Super Admin",
  admin: "Administrator",
  hr: "Human Resources",
  accountant: "Accountant",
  employee: "Employee",
};

const AccountDialogsContext = React.createContext({ open: () => {} });

/** Open the shared Edit Account ("profile") or Change Password ("password") dialog. */
export function useAccountDialogs() {
  return React.useContext(AccountDialogsContext);
}

/**
 * A label cut short by the narrow sidebar ("…") shows its full text on hover
 * and keyboard focus (2026-11-08). Text that fits gets no tooltip.
 */
function titleIfCut(event) {
  const host = event.currentTarget;
  const cut = [...host.querySelectorAll("[data-fit]")].some((el) => el.scrollWidth > el.clientWidth + 1);
  const full = [...host.querySelectorAll("[data-fit]")].map((el) => el.textContent).join(" · ");
  if (cut) host.setAttribute("title", full);
  else host.removeAttribute("title");
}

/**
 * Collapsible menu groups (2026-11-09 Part E). A group with `collapsible`
 * gets a header button (aria-expanded) and starts as `defaultOpen` says; the
 * group holding the current page opens by itself; on phones only one group
 * is open at a time. Each person's open / closed groups are remembered in
 * this browser (per role and account); if that cannot be saved, a group
 * starts collapsed (unless defaultOpen). In the icon-only rail every link
 * stays reachable. Non-collapsible groups (the Dashboard on top) stay as
 * plain sections.
 */
function useOpenGroups(nav, page, isMobile) {
  const { ctx, role } = usePortalSession();
  const key = `sacs-nav-groups:${role || "portal"}:${String(ctx?.email || "").toLowerCase()}`;
  const groupOf = React.useCallback((id) => nav.find((g) => g.items.some((item) => item.id === id))?.section, [nav]);
  const [open, setOpen] = React.useState(() => {
    const initial = Object.fromEntries(nav.filter((g) => g.collapsible).map((g) => [g.section, Boolean(g.defaultOpen)]));
    try {
      const saved = JSON.parse(window.localStorage.getItem(key) || "null");
      if (saved && typeof saved === "object") Object.assign(initial, Object.fromEntries(Object.entries(saved).filter(([k]) => k in initial)));
    } catch { /* not saved: the defaults */ }
    return initial;
  });
  // The group with the current page opens automatically.
  React.useEffect(() => {
    const section = groupOf(page);
    if (!section || !(section in open) || open[section]) return;
    setOpen((current) => (isMobile ? { ...Object.fromEntries(Object.keys(current).map((k) => [k, false])), [section]: true } : { ...current, [section]: true }));
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(open)); } catch { /* blocked: defaults next time */ }
  }, [key, open]);
  const toggle = (section) => setOpen((current) => {
    const next = !current[section];
    if (isMobile && next) return { ...Object.fromEntries(Object.keys(current).map((k) => [k, false])), [section]: true };
    return { ...current, [section]: next };
  });
  return { open, toggle };
}

function NavLinks({ nav, page, onNavigate, badges = {} }) {
  const { can } = usePortalSession();
  const { isMobile, setOpenMobile, state } = useSidebar();
  const { open, toggle } = useOpenGroups(nav, page, isMobile);
  const iconRail = !isMobile && state === "collapsed";

  return nav.map((group) => {
    const items = group.items.filter((item) => !item.module || can(item.module));
    // A group that would be empty for this role is hidden.
    if (!items.length) return null;
    const collapsible = Boolean(group.collapsible);
    const expanded = !collapsible || iconRail || Boolean(open[group.section]);
    const contentId = `nav-group-${String(group.section).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const waiting = collapsible && !expanded ? items.reduce((sum, item) => sum + (Number(badges[item.id]) || 0), 0) : 0;
    return (
      <SidebarGroup key={group.section} className="px-1.5 py-1" data-nav-group={group.section} data-state={expanded ? "open" : "closed"}>
        {collapsible ? (
          <SidebarGroupLabel asChild className="h-7 px-1.5 text-[10px] tracking-wider text-sidebar-foreground/70 uppercase">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={contentId}
              onClick={() => toggle(group.section)}
              className="flex w-full items-center gap-1 rounded-md text-left outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
              <span className="flex-1 truncate">{group.section}</span>
              {waiting ? <span className="rounded-full bg-warning px-1.5 text-[10px] font-semibold text-white normal-case" aria-label={`${waiting} waiting`}>{waiting > 99 ? "99+" : waiting}</span> : null}
            </button>
          </SidebarGroupLabel>
        ) : (
          <SidebarGroupLabel className="h-7 px-1.5 text-[10px] tracking-wider text-sidebar-foreground/70 uppercase">{group.section}</SidebarGroupLabel>
        )}
        <SidebarGroupContent id={contentId} hidden={!expanded}>
          <SidebarMenu>
            {items.map((item) => {
              const Icon = item.icon;
              const active = item.id === page;
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={item.label}
                    aria-current={active ? "page" : undefined}
                    onPointerEnter={titleIfCut}
                    onFocus={titleIfCut}
                    onClick={() => {
                      onNavigate(item.id);
                      if (isMobile) setOpenMobile(false);
                    }}
                    className={cn(
                      "relative font-medium text-sidebar-foreground hover:bg-white/10 hover:text-white",
                      // 36 px a row (40 px on touch screens), a tighter icon gap for the narrower sidebar.
                      "h-9 gap-1.5 px-2 pointer-coarse:h-10 group-data-[collapsible=icon]:size-9!",
                      "data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
                      "data-[active=true]:before:absolute data-[active=true]:before:top-1/2 data-[active=true]:before:left-0 data-[active=true]:before:h-4 data-[active=true]:before:w-[3px] data-[active=true]:before:-translate-y-1/2 data-[active=true]:before:rounded-r data-[active=true]:before:bg-sidebar-primary",
                      vengeanceLineHoverHost,
                    )}
                  >
                    {Icon ? <Icon aria-hidden="true" /> : null}
                    <span data-fit className={vengeanceLineHover}>{item.label}</span>
                  </SidebarMenuButton>
                  {badges[item.id] ? (
                    <SidebarMenuBadge className="rounded-full bg-warning px-1.5 text-[11px] font-semibold text-white peer-data-[active=true]/menu-button:text-white" aria-label={`${badges[item.id]} waiting`}>
                      {badges[item.id] > 99 ? "99+" : badges[item.id]}
                    </SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  });
}

function AppearanceItems() {
  const { theme, setTheme } = useUiTheme();
  return (
    <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
      <DropdownMenuRadioItem value="light"><SunIcon aria-hidden="true" />Light</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="dark"><MoonIcon aria-hidden="true" />Dark</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="system"><MonitorIcon aria-hidden="true" />Device setting</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

/**
 * Your picture at the top right (alpha test B4): a menu with Profile, Change
 * password, Help and Sign out, for every role.
 */
function HeaderAvatar({ onProfile, onHelp }) {
  const { ctx, role, logout } = usePortalSession();
  const { open } = useAccountDialogs();
  const [confirmDialog, confirm] = useConfirm();
  const name = ctx?.full_name || ROLE_LABEL[role];
  const signOut = () => setTimeout(async () => {
    const ok = await confirm({
      title: "Sign out?",
      description: "You will need your password (and an emailed code, if your account uses one) to sign in again. Anything you have not saved on this page will be lost.",
      confirmLabel: "Sign out",
      destructive: true,
    });
    if (ok) logout();
  }, 0);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="rounded-full" aria-label="Your account menu" data-testid="header-avatar">
            <UserAvatar userId="me" name={name} className="size-7" fallbackClassName="text-[10px]" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuLabel className="font-normal">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{ctx?.email || ROLE_LABEL[role]}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {onProfile ? <DropdownMenuItem onSelect={onProfile}><UserRoundIcon aria-hidden="true" />Profile</DropdownMenuItem> : null}
          <DropdownMenuItem onSelect={() => open("password")}><KeyRoundIcon aria-hidden="true" />Change password</DropdownMenuItem>
          {onHelp ? <DropdownMenuItem onSelect={onHelp}><CircleHelpIcon aria-hidden="true" />Help</DropdownMenuItem> : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={signOut}><LogOutIcon aria-hidden="true" />Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmDialog}
    </>
  );
}

function UserMenu({ onProfile }) {
  const { ctx, role, logout } = usePortalSession();
  const { open } = useAccountDialogs();
  const { isMobile } = useSidebar();
  const [confirmDialog, confirm] = useConfirm();
  const name = ctx?.full_name || ROLE_LABEL[role];

  // Asked once the menu has closed, so the dialog takes focus cleanly.
  const signOut = () => setTimeout(async () => {
    const ok = await confirm({
      title: "Sign out?",
      description: "You will need your password (and an emailed code, if your account uses one) to sign in again. Anything you have not saved on this page will be lost.",
      confirmLabel: "Sign out",
      destructive: true,
    });
    if (ok) logout();
  }, 0);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              onPointerEnter={titleIfCut}
              onFocus={titleIfCut}
              className="gap-1.5 px-1.5 text-sidebar-foreground hover:bg-white/10 hover:text-white data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <UserAvatar userId="me" name={name} className="size-8" fallbackClassName="bg-sidebar-primary text-xs text-sidebar-primary-foreground" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span data-fit className="truncate font-semibold text-white">{name}</span>
                <span data-fit className="truncate text-xs">{ROLE_LABEL[role]}</span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56 rounded-lg" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
            <DropdownMenuLabel className="font-normal">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="truncate text-xs text-muted-foreground">{ctx?.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {onProfile ? (
                <DropdownMenuItem onSelect={onProfile}><UserRoundIcon aria-hidden="true" />Profile</DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => open("password")}><KeyRoundIcon aria-hidden="true" />Change password</DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><SunIcon aria-hidden="true" className="size-4 text-muted-foreground" />Appearance</DropdownMenuSubTrigger>
                <DropdownMenuSubContent><AppearanceItems /></DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={signOut}><LogOutIcon aria-hidden="true" />Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {confirmDialog}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function formatNotifTime(date) {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
}

/**
 * Stored notifications (GET /api/notifications): e.g. a payroll run waiting
 * for HR, or HR's decision for the Accountant. Live (alpha test D2): a new
 * one sends a content-free Supabase Realtime "ping" to this account's own
 * channel and the list reloads at once through the API; still read every
 * minute in case the socket is down.
 */
function useStoredNotifications() {
  const [state, setState] = React.useState({ list: [], unread: 0 });
  const [live, setLive] = React.useState(null);
  const load = React.useCallback(async () => {
    try {
      const response = await apiFetch("/api/notifications", BACKGROUND);
      if (!response.ok) return;
      const data = await response.json();
      setState({ list: Array.isArray(data.notifications) ? data.notifications : [], unread: Number(data.unread) || 0 });
      if (data.live?.topic && data.live?.token) {
        setLive((current) => (current?.topic === data.live.topic && current?.token === data.live.token ? current : { topic: data.live.topic, token: data.live.token }));
      }
    } catch { /* offline: keep what we have */ }
  }, []);
  React.useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);
  React.useEffect(() => subscribeLiveBell(live, load), [live, load]);
  const markAllRead = React.useCallback(async () => {
    setState((c) => ({ list: c.list.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })), unread: 0 }));
    try { await apiFetch("/api/notifications", jsonBody("PATCH", {})); } catch { /* retried on the next open */ }
  }, []);
  return { ...state, markAllRead, reload: load };
}

/**
 * Listen on this account's live-bell channel; returns the cleanup. The
 * message carries nothing: it only says "reload". Never throws.
 */
function subscribeLiveBell(live, onPing) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const topic = live?.topic;
  // A private channel (decision 2026-11-09 #11): only this account may join it.
  if (!topic || !live?.token || !url || !key || typeof window === "undefined") return undefined;
  let closed = false;
  let cleanup = () => {};
  import("@supabase/supabase-js").then(({ createClient }) => {
    if (closed) return;
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    client.realtime.setAuth(live.token);
    const channel = client.channel(`bell-${topic}`, { config: { private: true } }).on("broadcast", { event: "ping" }, () => onPing()).subscribe();
    cleanup = () => { client.removeChannel(channel).catch(() => {}); };
  }).catch(() => {});
  return () => { closed = true; cleanup(); };
}

/** The bell: a live summary for this portal, stored notices, then this session's notices. */
function NotificationsMenu({ summary = [], onNavigate }) {
  const { notifications, unread, markRead } = usePortalSession();
  const stored = useStoredNotifications();
  const anyUnread = unread || stored.unread;
  return (
    <DropdownMenu onOpenChange={(isOpen) => { if (isOpen) { markRead(); if (stored.unread) stored.markAllRead(); } }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={anyUnread ? `Notifications, ${unread + stored.unread} new` : "Notifications"}>
          <BellIcon />
          {anyUnread ? <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive ring-2 ring-background" aria-hidden="true" /> : null}
        </Button>
      </DropdownMenuTrigger>
      {/* One scroll area (alpha test D2): the menu itself does not scroll. */}
      <DropdownMenuContent align="end" className="flex w-80 max-w-[calc(100vw-2rem)] flex-col overflow-y-hidden" data-testid="notifications-menu">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="max-h-[min(28rem,calc(var(--radix-dropdown-menu-content-available-height)-4rem))] min-h-0 overflow-y-auto overscroll-contain" data-testid="notifications-scroll">
        {summary.map((item) => (
          <div key={item.title} className="px-2 py-1.5">
            <p className="text-sm font-medium">{item.title}</p>
            {item.description ? <p className="text-xs text-muted-foreground">{item.description}</p> : null}
          </div>
        ))}
        {stored.list.length ? (
          <>
            {summary.length ? <DropdownMenuSeparator /> : null}
            <div>
              {stored.list.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  className="flex-col items-stretch gap-0.5 px-2 py-1.5"
                  onSelect={() => { if (item.link_page && onNavigate) onNavigate(item.link_page); }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className={cn("text-sm", item.read_at ? "font-normal" : "font-semibold")}>{item.title}</p>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{formatNotifTime(new Date(item.created_at))}</span>
                  </div>
                  {item.body ? <p className="text-xs text-muted-foreground">{item.body}</p> : null}
                </DropdownMenuItem>
              ))}
            </div>
          </>
        ) : null}
        {notifications.length ? <DropdownMenuSeparator /> : null}
        <div>
          {notifications.map((item, index) => (
            <div key={`${item.time.getTime()}-${index}`} className="px-2 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{item.title}</p>
                <span className="shrink-0 text-[11px] text-muted-foreground">{formatNotifTime(item.time)}</span>
              </div>
              {item.description ? <p className="text-xs text-muted-foreground">{item.description}</p> : null}
            </div>
          ))}
        </div>
        {!summary.length && !notifications.length && !stored.list.length ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">You&apos;re all caught up.</p>
        ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeIconButton() {
  const { theme, setTheme } = useUiTheme();
  const next = { light: "dark", dark: "system", system: "light" };
  const label = { light: "Light", dark: "Dark", system: "Device setting" };
  const Icon = theme === "light" ? SunIcon : theme === "dark" ? MoonIcon : MonitorIcon;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(next[theme])}
      aria-label={`Appearance: ${label[theme]}. Switch to ${label[next[theme]]}.`}
      title={`Appearance: ${label[theme]}`}
    >
      <Icon />
    </Button>
  );
}

export function AppShell({
  nav,
  page,
  onNavigate,
  title,
  description,
  onRefresh,
  refreshing = false,
  notificationSummary,
  profilePage,
  accountOptions,
  badges,
  children,
}) {
  const { role } = usePortalSession();
  const systemTitle = useSystemName();
  const [dialog, setDialog] = React.useState(null);
  const dialogs = React.useMemo(() => ({ open: setDialog }), []);
  // First-time tour per role; Help in the avatar menu reopens it (alpha test B6).
  const help = useFirstTimeHelp(role);
  const setHelpOpen = help.setOpen;

  // Any card can open another page of this portal ("View all" on a dashboard
  // card): window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: "page-id" })).
  React.useEffect(() => {
    const go = (event) => { if (typeof event.detail === "string" && nav.some((g) => g.items.some((i) => i.id === event.detail))) onNavigate(event.detail); };
    window.addEventListener(NAVIGATE_EVENT, go);
    return () => window.removeEventListener(NAVIGATE_EVENT, go);
  }, [nav, onNavigate]);

  return (
    <AccountDialogsContext.Provider value={dialogs}>
      <TooltipProvider delayDuration={300}>
        <SidebarProvider className="bg-background">
          <a
            href="#portal-main"
            className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
          >
            Skip to content
          </a>
          <Sidebar collapsible="icon" className="border-r-2 border-r-brand-gold [&_[data-sidebar=sidebar]]:bg-sidebar">
            <SidebarHeader className="border-b border-sidebar-border px-1.5">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="lg"
                    tooltip="Refresh this page"
                    onClick={onRefresh}
                    onPointerEnter={titleIfCut}
                    className="gap-1.5 px-1.5 text-white hover:bg-white/10 hover:text-white"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/brand/logo-160.png"
                      alt="Shepherd Angels Christian School seal"
                      width={32}
                      height={32}
                      className="size-8 shrink-0 rounded-full bg-white/95 p-0.5"
                    />
                    <div className="grid flex-1 text-left leading-tight">
                      <span data-fit className="truncate text-sm font-semibold">{systemTitle}</span>
                      <span data-fit className="truncate text-xs text-sidebar-primary">{ROLE_LABEL[role]}</span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
              <NavLinks nav={nav} page={page} onNavigate={onNavigate} badges={badges} />
            </SidebarContent>
            <SidebarFooter className="border-t border-sidebar-border px-1.5">
              <UserMenu onProfile={profilePage ? () => onNavigate(profilePage) : null} />
            </SidebarFooter>
            <SidebarRail />
          </Sidebar>

          <SidebarInset className="min-w-0">
            <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:px-4">
              <SidebarTrigger className="-ml-1" aria-label="Toggle navigation" />
              <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-base font-semibold">{title}</h1>
              </div>
              {onRefresh ? (
                <Button variant="ghost" size="icon" onClick={onRefresh} disabled={refreshing} aria-label="Refresh">
                  <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
                </Button>
              ) : null}
              <NotificationsMenu summary={notificationSummary} onNavigate={onNavigate} />
              <ThemeIconButton />
              <HeaderAvatar onProfile={profilePage ? () => onNavigate(profilePage) : null} onHelp={() => setHelpOpen(true)} />
            </header>

            <main id="portal-main" tabIndex={-1} className="flex flex-1 flex-col gap-4 p-4 outline-none sm:p-6">
              {description ? <p className="-mt-1 text-sm text-muted-foreground">{description}</p> : null}
              {children}
            </main>
          </SidebarInset>
        </SidebarProvider>

        <EditAccountDialog open={dialog === "profile"} onOpenChange={(isOpen) => setDialog(isOpen ? "profile" : null)} {...accountOptions} />
        <ChangePasswordDialog open={dialog === "password"} onOpenChange={(isOpen) => setDialog(isOpen ? "password" : null)} />
        <HelpTour role={role} open={help.open} onClose={help.close} />
      </TooltipProvider>
    </AccountDialogsContext.Provider>
  );
}
