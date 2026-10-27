"use client";

import * as React from "react";
import { ArrowLeftIcon, CheckIcon, CloudOffIcon, Loader2Icon, LockKeyholeIcon, LogOutIcon, NfcIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PasswordInput } from "@/components/portal/account-dialogs";
import { hardNavigate } from "@/lib/portal/api";
import { cn } from "@/lib/utils";

/*
 * RFID Attendance Terminal, the kiosk page opened by HR, a branch Admin or the
 * Super Admin (no registered terminals since 2026-10-27; a branch Admin's kiosk takes its own branch's cards). It shares the signed-in user's session but
 * adds its own password lock: opening and leaving the terminal both need
 * that user's password again.
 *   GET  /api/rbac/me, /api/admin/branches
 *   POST /api/admin/attendance/verify-password { password, purpose: "unlock" | "exit" }
 *   POST /api/admin/attendance { rfid_code, device, offline_tapped_at? } with x-sacs-kiosk
 * Plain fetch, not apiFetch: a 401 here locks the kiosk instead of leaving it.
 *
 * RFID readers type the card's UID and Enter, so the scan field keeps focus
 * whenever the kiosk screen shows.
 */

const PENDING_KEY = "sacs-kiosk-pending";
/** Who may run a terminal, and where "Back" / "Exit" goes. */
const RUNNERS = {
  hr: { homePath: "/hr", portalLabel: "HR" },
  admin: { homePath: "/admin", portalLabel: "Administration" },
  super_admin: { homePath: "/super-admin", portalLabel: "Super Admin" },
};
/** Why the server locked the kiosk (src/lib/auth/kiosk-session.js kioskRefusal). */
const LOCK_REASONS = {
};
const TAP_WORDS = { time_in: "Time In", time_out: "Time Out", after_correction: "Recorded (day under review)", duplicate: "Already recorded" };
const PENDING_MAX = 500;
const LIGHT_MS = 2500;
const MESSAGE_MS = 5000;
const IDLE_TEXT = "Tap your RFID card";
// A tap the server has not answered by then is saved and resent with its own
// time; the server ignores the resend if the first one did get through.
const TAP_TIMEOUT_MS = 10 * 1000;

function readPending() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writePending(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-PENDING_MAX))); } catch { /* storage blocked */ }
}

function manilaClock() {
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(new Date());
}

function manilaDate() {
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());
}

function Brand({ inverse = false }) {
  return (
    <div className="flex items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/logo-160.png" alt="Shepherd Angels Christian School seal" width={48} height={48} className="size-12 rounded-full bg-white/95 p-0.5 shadow" />
      <div className="leading-tight">
        <p className={cn("font-semibold", inverse ? "text-white" : "text-foreground")}>Shepherd Angels Christian School</p>
        <p className={cn("text-xs font-semibold tracking-[0.16em] uppercase", inverse ? "text-brand-gold-light" : "text-gold-text")}>RFID Attendance Terminal</p>
      </div>
    </div>
  );
}

/**
 * The kiosk's signal: green accepted, red refused, amber saved for later or
 * already recorded. Since 2026-10-21 an accepted tap also shows the name,
 * the time and Time In / Time Out, and a refusal says why (card not
 * recognized, inactive, another branch). Solid colours, so they read from across a room on the
 * green screen; the word underneath means colour is never the only cue.
 */
const STATES = {
  idle: { ring: "border-brand-gold bg-white/10 text-brand-gold-light", icon: NfcIcon, pulse: true, word: "" },
  in: { ring: "border-white/80 bg-[#16a34a] text-white", icon: CheckIcon, word: "Accepted" },
  error: { ring: "border-white/80 bg-[#dc2626] text-white", icon: XIcon, word: "Not accepted — please tap again" },
  saved: { ring: "border-white/80 bg-[#d97706] text-white", icon: CloudOffIcon, word: "" },
  // The same tap again within a few minutes: counted once (amber, not red).
  dup: { ring: "border-white/80 bg-[#d97706] text-white", icon: CheckIcon, word: "Already recorded" },
};

function initials(name) {
  return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

function manilaTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: true }).format(date);
}

export function RfidTerminal() {
  const [identity, setIdentity] = React.useState(null); // { name, isSuperAdmin, homePath, portalLabel, branchName }
  const [locked, setLocked] = React.useState(true);
  const [lockPassword, setLockPassword] = React.useState("");
  const [lockBusy, setLockBusy] = React.useState(false);
  const [lockError, setLockError] = React.useState("");
  const [exitOpen, setExitOpen] = React.useState(false);
  const [exitPassword, setExitPassword] = React.useState("");
  const [exitBusy, setExitBusy] = React.useState(false);
  const [exitError, setExitError] = React.useState("");
  const [status, setStatus] = React.useState({ state: "idle", text: "" });
  const [pendingCount, setPendingCount] = React.useState(0);
  const [clock, setClock] = React.useState({ time: "", date: "" });
  const [scan, setScan] = React.useState("");
  const [scanReadOnly, setScanReadOnly] = React.useState(true);
  const [kiosk, setKiosk] = React.useState(null);   // { branch_name } once unlocked (no registered terminals since 2026-10-27)
  const [online, setOnline] = React.useState(true);

  const scanRef = React.useRef(null);
  const inFlight = React.useRef(false);
  const queue = React.useRef([]);
  const flushing = React.useRef(false);
  const resultTimer = React.useRef(null);
  const idleTimer = React.useRef(null);
  const lockedRef = React.useRef(true);
  const exitOpenRef = React.useRef(false);
  const branchRef = React.useRef("—");

  React.useEffect(() => { lockedRef.current = locked; }, [locked]);
  React.useEffect(() => { exitOpenRef.current = exitOpen; }, [exitOpen]);

  const refreshPending = React.useCallback(() => setPendingCount(readPending().length), []);

  const focusScan = React.useCallback(() => {
    if (!lockedRef.current && !exitOpenRef.current) scanRef.current?.focus({ preventScroll: true });
  }, []);

  // Who is signed in: HR, an Administrator or a Super Admin (rfid_devices),
  // (no terminal to choose since 2026-10-27).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      let user;
      try {
        const res = await fetch("/api/rbac/me");
        if (!res.ok) throw new Error("session");
        user = (await res.json()).user;
      } catch {
        hardNavigate("/login");
        return;
      }
      if (!user || !RUNNERS[user.role]) {
        hardNavigate("/login");
        return;
      }
      if (cancelled) return;
      setIdentity({ name: user.full_name || "", ...RUNNERS[user.role], branchName: "—" });
    })();
    return () => { cancelled = true; };
  }, []);

  // Clock, the saved-tap count, and the session keep-alive while unlocked.
  React.useEffect(() => {
    const tick = () => setClock({ time: manilaClock(), date: manilaDate() });
    tick();
    refreshPending();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [refreshPending]);

  const showLight = React.useCallback((state, text, ms, who = null) => {
    clearTimeout(resultTimer.current);
    setStatus({ state, text, who });
    resultTimer.current = setTimeout(() => setStatus({ state: "idle", text: "" }), ms);
  }, []);

  const lockAgain = React.useCallback((message) => {
    setLocked(true);
    setExitOpen(false);
    setLockError(message || "The terminal was signed out. Enter your password to continue.");
  }, []);

  const sendTap = React.useCallback((code, offlineTappedAt) => fetch("/api/admin/attendance", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sacs-kiosk": "1" },
    ...(typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(TAP_TIMEOUT_MS) } : {}),
    // Every tap is stored with the reader it came from (Tap History).
    body: JSON.stringify({
      rfid_code: code,
      device: `RFID Terminal · ${branchRef.current}`,
      ...(offlineTappedAt ? { offline_tapped_at: offlineTappedAt } : {}),
    }),
  }), []);

  const keepForLater = React.useCallback((code, tappedAt) => {
    writePending([...readPending(), { code, tapped_at: tappedAt }]);
    refreshPending();
  }, [refreshPending]);

  // Saved taps, oldest first. One the server answered (recorded or refused) is done.
  const flushPending = React.useCallback(async () => {
    if (flushing.current || lockedRef.current || !readPending().length) return;
    flushing.current = true;
    try {
      for (;;) {
        const list = readPending();
        if (!list.length) break;
        let res;
        try {
          res = await sendTap(list[0].code, list[0].tapped_at);
        } catch {
          setOnline(false);
          break; // still offline
        }
        setOnline(true);
        if (res.status === 401) { lockAgain(LOCK_REASONS[(await res.json().catch(() => ({}))).code]); break; }
        if (res.status >= 500) break;
        writePending(readPending().slice(1));
        refreshPending();
      }
    } finally {
      flushing.current = false;
    }
  }, [sendTap, lockAgain, refreshPending]);

  const submitScan = React.useCallback(async (code, tappedAt = null) => {
    if (!code) return;
    // A tap during another's request waits its turn instead of mixing digits with it.
    if (inFlight.current) {
      queue.current.push({ code, tappedAt: new Date().toISOString() });
      return;
    }
    inFlight.current = true;
    setScan("");
    const at = tappedAt || new Date().toISOString();
    // A tap that waited in the queue more than a moment is sent with its time.
    const late = Date.now() - new Date(at).getTime() > 30 * 1000 ? at : null;
    try {
      const res = await sendTap(code, late);
      const data = await res.json().catch(() => ({}));
      setOnline(true);
      if (res.status === 401) {
        keepForLater(code, at);
        lockAgain(LOCK_REASONS[data.code]);
      } else if (res.status >= 500) {
        keepForLater(code, at);
        showLight("saved", "Tap saved. It will be sent when the connection is back.", MESSAGE_MS);
      } else if (res.ok && data.record) {
        // Who tapped, when, and whether it was Time In or Time Out (2026-10-21).
        const who = { name: data.employee?.name || data.record.employee_name || "", time: manilaTime(data.tapped_at), tap: TAP_WORDS[data.tap] || "Recorded" };
        showLight(data.tap === "duplicate" ? "dup" : "in", who.tap, MESSAGE_MS, who);
        flushPending();
      } else {
        // Say why, so the person knows whether tapping again could help.
        const message = data.on_leave ? data.error
          : data.code === "card_unknown" ? "Card not recognized"
            : data.code === "card_inactive" ? "Card inactive. Please see HR."
              : data.code === "wrong_branch" ? "This card belongs to another branch"
                : data.code === "employee_inactive" ? "This employee is not active"
                  : data.code === "too_early" ? "Too early to time in. Please see HR."
                  : "";
        showLight("error", message, message ? MESSAGE_MS : LIGHT_MS);
        flushPending();
      }
    } catch {
      setOnline(false);
      keepForLater(code, at);
      showLight("saved", "Tap saved. It will be sent when the connection is back.", MESSAGE_MS);
    } finally {
      inFlight.current = false;
      setScan("");
      focusScan();
      const next = queue.current.shift();
      if (next) submitScan(next.code, next.tappedAt);
    }
  }, [sendTap, keepForLater, lockAgain, showLight, flushPending, focusScan]);

  // Keep the scan field focused, keep the session alive while unlocked, and resend saved taps.
  React.useEffect(() => {
    if (locked) return undefined;
    const refocus = setInterval(() => { if (!exitOpenRef.current && document.activeElement !== scanRef.current) focusScan(); }, 1500);
    const keepAlive = setInterval(() => {
      fetch("/api/legacy-auth/session", { headers: { "x-sacs-activity": "1" }, cache: "no-store" }).catch(() => {});
    }, 4 * 60 * 1000);
    const resend = setInterval(() => flushPending(), 20 * 1000);
    const onOnline = () => { setOnline(true); flushPending(); };
    const onOffline = () => setOnline(false);
    window.addEventListener("offline", onOffline);
    if (typeof navigator !== "undefined" && navigator.onLine === false) setOnline(false);
    const onClick = (event) => { if (!event.target.closest?.("[data-kiosk-exit]")) focusScan(); };
    window.addEventListener("online", onOnline);
    document.addEventListener("click", onClick);
    setTimeout(focusScan, 0);
    return () => {
      clearInterval(refocus);
      clearInterval(keepAlive);
      clearInterval(resend);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("click", onClick);
    };
  }, [locked, focusScan, flushPending]);

  React.useEffect(() => () => { clearTimeout(resultTimer.current); clearTimeout(idleTimer.current); }, []);

  async function verifyPassword(password, purpose) {
    const res = await fetch("/api/admin/attendance/verify-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, purpose }),
    });
    if (res.status === 401) {
      // The user's own sign-in has ended: sign in again first.
      hardNavigate("/login");
      throw new Error("Your session has ended. Please sign in again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not verify password.");
    if (purpose === "unlock" && data.kiosk) {
      setKiosk(data.kiosk);
      branchRef.current = data.kiosk.branch_name || "—";
    }
    return Boolean(data.valid);
  }

  async function unlock(event) {
    event.preventDefault();
    const password = lockPassword.trim();
    if (!password) { setLockError("Enter your password."); return; }
    setLockBusy(true);
    setLockError("");
    try {
      // "unlock" also starts the terminal's own kiosk session, so taps keep
      // recording after the user's sign-in ends.
      if (!(await verifyPassword(password, "unlock"))) { setLockError("Incorrect password."); return; }
      setLockPassword("");
      setScan("");
      setLocked(false);
      lockedRef.current = false;
      flushPending();
    } catch (error) {
      setLockError(error.message);
    } finally {
      setLockBusy(false);
    }
  }

  async function exit(event) {
    event.preventDefault();
    const password = exitPassword.trim();
    if (!password) { setExitError("Enter your password."); return; }
    setExitBusy(true);
    setExitError("");
    try {
      if (!(await verifyPassword(password, "exit"))) { setExitError("Incorrect password."); return; }
      hardNavigate(identity?.homePath || "/admin");
    } catch (error) {
      setExitError(error.message);
    } finally {
      setExitBusy(false);
    }
  }

  function onScanChange(event) {
    // Card UIDs are numbers only; the kiosk does not take employee IDs.
    const digits = event.target.value.replace(/\D/g, "");
    setScan(digits);
    clearTimeout(idleTimer.current);
    // Some readers never send Enter after a tap: submit once digits stop for a beat.
    if (/^\d{6,}$/.test(digits)) idleTimer.current = setTimeout(() => submitScan(digits), 400);
  }

  function onScanKeyDown(event) {
    // Read-only until the first key, so the browser never autofills the
    // account's saved email into it right after the password was typed.
    // Cleared on the element itself so this very keystroke lands.
    if (scanReadOnly) {
      event.currentTarget.readOnly = false;
      setScanReadOnly(false);
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    clearTimeout(idleTimer.current);
    const value = scan.trim();
    if (value) submitScan(value);
  }

  if (locked) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8" style={{ backgroundImage: "radial-gradient(circle at 100% 0%, color-mix(in oklab, var(--brand-gold) 16%, transparent), transparent 45%), radial-gradient(circle at 0% 100%, color-mix(in oklab, var(--brand-green) 12%, transparent), transparent 50%)" }}>
        <Card className="w-full max-w-md shadow-lg">
          <CardHeader className="space-y-4">
            <Brand />
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-2xl"><LockKeyholeIcon className="size-5 text-gold-text" aria-hidden="true" />Unlock terminal</CardTitle>
              <CardDescription>
                {identity
                  ? `Enter the ${identity.portalLabel} password${identity.name ? ` for ${identity.name}` : ""} to open the terminal.`
                  : "Enter your password to open the terminal."}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={unlock} noValidate className="space-y-4">
              <PasswordInput
                id="rt-lock-password"
                label="Your password"
                autoComplete="current-password"
                placeholder="Password"
                value={lockPassword}
                onChange={(v) => { setLockPassword(v); if (lockError) setLockError(""); }}
                invalid={Boolean(lockError)}
                autoFocus
              />
              {lockError ? <Alert variant="destructive" role="alert"><AlertDescription>{lockError}</AlertDescription></Alert> : null}
              <Button type="submit" size="lg" className="w-full" disabled={lockBusy || !identity}>
                {lockBusy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Checking…</> : "Unlock terminal"}
              </Button>
            </form>
            <Button variant="link" className="mt-3 h-auto px-0 text-muted-foreground" onClick={() => hardNavigate(identity?.homePath || "/admin")}>
              <ArrowLeftIcon aria-hidden="true" />Back to {identity?.portalLabel || "Administration"}
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const look = STATES[status.state] || STATES.idle;
  const Icon = look.icon;
  const idleText = pendingCount ? `${IDLE_TEXT} · ${pendingCount} tap${pendingCount === 1 ? "" : "s"} waiting to send` : IDLE_TEXT;
  const text = status.state === "idle" ? idleText : status.text || look.word;
  const srText = {
    idle: idleText,
    in: status.who ? `${status.who.name}: ${status.who.tap} at ${status.who.time}` : "Tap accepted",
    dup: status.who ? `${status.who.name}: already recorded` : "Already recorded",
    error: status.text || "Tap refused. Please tap again.",
    saved: status.text,
  }[status.state];

  return (
    <main className="flex min-h-dvh flex-col bg-linear-to-br from-brand-green to-brand-green-dark text-white">
      <header className="flex flex-wrap items-center gap-4 border-b border-white/10 px-4 py-3 sm:px-8">
        <Brand inverse />
        <div className="ml-auto flex flex-wrap items-center gap-4 sm:gap-6">
          <div className="text-right leading-tight">
            <p className="text-[11px] font-semibold tracking-wider text-white/60 uppercase">RFID Terminal</p>
            <p className="font-semibold">{kiosk?.branch_name || "—"}</p>
          </div>
          <p className="font-mono text-xl font-semibold tabular-nums sm:text-2xl" aria-label="Current time">{clock.time}</p>
          <Button
            data-kiosk-exit
            variant="outline"
            className="border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={() => { setExitPassword(""); setExitError(""); setExitOpen(true); }}
          >
            <LogOutIcon aria-hidden="true" />Exit terminal
          </Button>
        </div>
      </header>

      {!online || pendingCount ? (
        <div role="alert" className="flex items-center justify-center gap-2 bg-[#d97706] px-4 py-2 text-sm font-semibold text-white">
          <CloudOffIcon className="size-4" aria-hidden="true" />
          {online ? `${pendingCount} saved tap${pendingCount === 1 ? "" : "s"} waiting to send…`
            : `Connection lost. Taps are saved on this screen${pendingCount ? ` (${pendingCount} waiting)` : ""} and sent automatically when it is back.`}
        </div>
      ) : null}
      <section className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-10 text-center">
        <p className="text-sm font-medium text-white/70">{clock.date}</p>
        <div
          className={cn(
            "relative flex size-56 items-center justify-center rounded-full border-8 shadow-2xl transition-colors duration-200 sm:size-72",
            look.ring,
          )}
          aria-hidden="true"
        >
          {look.pulse ? <span className="absolute inset-0 animate-ping rounded-full border-4 border-brand-gold/40 [animation-duration:2.4s]" /> : null}
          <Icon className="size-24 sm:size-32" strokeWidth={status.state === "idle" ? 1.5 : 2.5} />
        </div>
        {status.who?.name ? (
          <div className="flex items-center gap-4 rounded-2xl bg-white/10 px-5 py-3 text-left">
            <span className="flex size-14 items-center justify-center rounded-full bg-white text-xl font-bold text-brand-green" aria-hidden="true">{initials(status.who.name)}</span>
            <div>
              <p className="text-2xl font-semibold sm:text-3xl">{status.who.name}</p>
              <p className="text-lg text-white/80">{status.who.tap} · {status.who.time}</p>
            </div>
          </div>
        ) : (
          <p className="min-h-8 max-w-xl text-2xl font-semibold sm:text-3xl">{text}</p>
        )}
        <p className="sr-only" role="status" aria-live="polite">{srText}</p>
        <div className="w-full max-w-sm">
          <label htmlFor="rt-scan-input" className="sr-only">RFID card number</label>
          <input
            id="rt-scan-input"
            ref={scanRef}
            value={scan}
            onChange={onScanChange}
            onKeyDown={onScanKeyDown}
            readOnly={scanReadOnly}
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Tap RFID card"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="h-12 w-full rounded-lg border border-white/20 bg-white/10 px-4 text-center font-mono text-lg tracking-widest text-white placeholder:text-white/50 focus:border-brand-gold focus:outline-none focus:ring-2 focus:ring-brand-gold/50"
          />
        </div>
      </section>

      <Dialog open={exitOpen} onOpenChange={(open) => { setExitOpen(open); if (!open) setTimeout(focusScan, 50); }}>
        <DialogContent className="sm:max-w-sm" data-kiosk-exit>
          <DialogHeader>
            <DialogTitle>Exit RFID terminal</DialogTitle>
            <DialogDescription>Enter your {identity?.portalLabel || "Administration"} password to close the terminal.</DialogDescription>
          </DialogHeader>
          <form onSubmit={exit} noValidate className="space-y-4">
            <PasswordInput
              id="rt-exit-password"
              label="Your password"
              autoComplete="current-password"
              placeholder="Password"
              value={exitPassword}
              onChange={(v) => { setExitPassword(v); if (exitError) setExitError(""); }}
              invalid={Boolean(exitError)}
              autoFocus
            />
            {exitError ? <Alert variant="destructive" role="alert"><AlertDescription>{exitError}</AlertDescription></Alert> : null}
            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={() => setExitOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={exitBusy}>{exitBusy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Checking…</> : "Exit"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
