"use client";

import * as React from "react";
import {
  BellIcon,
  ChevronsUpDownIcon,
  KeyRoundIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  RefreshCwIcon,
  SunIcon,
  UserRoundIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { usePortalSession } from "@/components/portal/session";
import { useUiTheme } from "@/components/theme";
import { initialsOf } from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/**
 * The frame every React portal shares: the green sidebar (collapsible to
 * icons on desktop, a sheet on phones) with the school seal and the role's
 * links, a top bar with the page title, refresh, notifications and theme, and
 * the account menu (profile, change password, appearance, sign out).
 *
 * nav: [{ section, items: [{ id, label, icon, module? }] }]. An item with a
 * `module` shows only when the session's permissions allow reading it.
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

function NavLinks({ nav, page, onNavigate }) {
  const { can } = usePortalSession();
  const { isMobile, setOpenMobile } = useSidebar();

  return nav.map((group) => {
    const items = group.items.filter((item) => !item.module || can(item.module));
    if (!items.length) return null;
    return (
      <SidebarGroup key={group.section}>
        <SidebarGroupLabel className="text-[11px] tracking-wider text-sidebar-foreground/70 uppercase">{group.section}</SidebarGroupLabel>
        <SidebarGroupContent>
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
                    onClick={() => {
                      onNavigate(item.id);
                      if (isMobile) setOpenMobile(false);
                    }}
                    className={cn(
                      "relative font-medium text-sidebar-foreground hover:bg-white/10 hover:text-white",
                      "data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
                      "data-[active=true]:before:absolute data-[active=true]:before:top-1/2 data-[active=true]:before:left-0 data-[active=true]:before:h-4 data-[active=true]:before:w-[3px] data-[active=true]:before:-translate-y-1/2 data-[active=true]:before:rounded-r data-[active=true]:before:bg-sidebar-primary",
                    )}
                  >
                    {Icon ? <Icon aria-hidden="true" /> : null}
                    <span>{item.label}</span>
                  </SidebarMenuButton>
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
              className="text-sidebar-foreground hover:bg-white/10 hover:text-white data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
                  {initialsOf(name)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold text-white">{name}</span>
                <span className="truncate text-xs">{ROLE_LABEL[role]}</span>
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

/** The bell: a live summary for this portal, then this session's notices. */
function NotificationsMenu({ summary = [] }) {
  const { notifications, unread, markRead } = usePortalSession();
  return (
    <DropdownMenu onOpenChange={(isOpen) => { if (isOpen) markRead(); }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}>
          <BellIcon />
          {unread ? <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive ring-2 ring-background" aria-hidden="true" /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {summary.map((item) => (
          <div key={item.title} className="px-2 py-1.5">
            <p className="text-sm font-medium">{item.title}</p>
            {item.description ? <p className="text-xs text-muted-foreground">{item.description}</p> : null}
          </div>
        ))}
        {notifications.length ? <DropdownMenuSeparator /> : null}
        <div className="max-h-72 overflow-y-auto">
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
        {!summary.length && !notifications.length ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">You&apos;re all caught up.</p>
        ) : null}
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
  children,
}) {
  const { role } = usePortalSession();
  const [dialog, setDialog] = React.useState(null);
  const dialogs = React.useMemo(() => ({ open: setDialog }), []);

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
            <SidebarHeader className="border-b border-sidebar-border">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="lg"
                    tooltip="Refresh this page"
                    onClick={onRefresh}
                    className="text-white hover:bg-white/10 hover:text-white"
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
                      <span className="truncate text-sm font-semibold">SACS Payroll</span>
                      <span className="truncate text-xs text-sidebar-primary">{ROLE_LABEL[role]}</span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
              <NavLinks nav={nav} page={page} onNavigate={onNavigate} />
            </SidebarContent>
            <SidebarFooter className="border-t border-sidebar-border">
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
              <NotificationsMenu summary={notificationSummary} />
              <ThemeIconButton />
            </header>

            <main id="portal-main" tabIndex={-1} className="flex flex-1 flex-col gap-4 p-4 outline-none sm:p-6">
              {description ? <p className="-mt-1 text-sm text-muted-foreground">{description}</p> : null}
              {children}
            </main>
          </SidebarInset>
        </SidebarProvider>

        <EditAccountDialog open={dialog === "profile"} onOpenChange={(isOpen) => setDialog(isOpen ? "profile" : null)} {...accountOptions} />
        <ChangePasswordDialog open={dialog === "password"} onOpenChange={(isOpen) => setDialog(isOpen ? "password" : null)} />
      </TooltipProvider>
    </AccountDialogsContext.Provider>
  );
}
