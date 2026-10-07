"use client";

import * as React from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { toast } from "sonner";
import {
  ArrowLeftIcon,
  EyeIcon,
  EyeOffIcon,
  InboxIcon,
  Loader2Icon,
  LockKeyholeIcon,
  MailCheckIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/theme";
import { ResetPasswordDialog } from "./reset-password-dialog";
import {
  LOGIN_REASON_MESSAGES,
  ROLE_ROUTES,
  clearAuthContext,
  readAuthContext,
  saveAuthContext,
} from "./auth-context";

/**
 * The sign-in screen: password, then (for the roles src/lib/auth/otp-policy.js
 * gates) the 6-digit code emailed to the account.
 *
 * Same API and same behaviour as the legacy screen in
 * public/legacy/js/app.js (login(), verifyLoginOtp(), resendLoginOtp()):
 *   POST /api/legacy-auth/login             -> { redirectTo } or { otp_required }
 *   POST /api/legacy-auth/verify-login-otp  -> { redirectTo }
 *   POST /api/legacy-auth/resend-login-otp
 * The server decides everything; this only presents it.
 */

const CODE_LENGTH = 6;
const CODE_TTL_SECONDS = 5 * 60;
const RESEND_SECONDS = 60;

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

const NETWORK_ERROR = "Unable to reach the server. Check your connection and try again.";

function useCountdown(target) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!target) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [target]);
  return target ? Math.max(0, Math.ceil((target - now) / 1000)) : 0;
}

function formatClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/* ── Brand panel ───────────────────────────────────────────────────────── */

function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-brand-green text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 15% 10%, rgba(232,199,102,.22), transparent 40%), radial-gradient(circle at 90% 85%, rgba(201,162,39,.18), transparent 45%), linear-gradient(160deg, #1B5E3C 0%, #0F3D28 100%)",
        }}
      />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1.5 bg-brand-gold" />

      <div className="relative flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/legacy/assets/logo-160.png" alt="" width="64" height="64" className="size-16 rounded-full bg-white/95 p-1 shadow-lg" />
        <div>
          <p className="text-lg font-semibold leading-tight">Shepherd Angels Christian School</p>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-gold-light">Antipolo City</p>
        </div>
      </div>

      <div className="relative max-w-md">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-brand-gold-light">Payroll Management System</p>
        <h1 className="mt-3 text-4xl font-semibold leading-tight">Attendance to payslip, in one place.</h1>
        <ul className="mt-8 space-y-3 text-sm text-white/85">
          <li className="flex items-center gap-3"><ShieldCheckIcon className="size-4 text-brand-gold-light" aria-hidden="true" />RFID attendance across all four branches</li>
          <li className="flex items-center gap-3"><LockKeyholeIcon className="size-4 text-brand-gold-light" aria-hidden="true" />Emailed sign-in codes for staff accounts</li>
          <li className="flex items-center gap-3"><MailCheckIcon className="size-4 text-brand-gold-light" aria-hidden="true" />Semi-monthly payroll and payslips</li>
        </ul>
      </div>

      <p className="relative text-xs text-white/60">© {new Date().getFullYear()} Shepherd Angels Christian School</p>
    </aside>
  );
}

function MobileBrand() {
  return (
    <div className="mb-6 flex flex-col items-center text-center lg:hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/legacy/assets/logo-160.png" alt="Shepherd Angels Christian School seal" width="72" height="72" className="size-18 rounded-full shadow-md ring-4 ring-brand-gold/40" />
      <p className="mt-3 text-base font-semibold text-foreground">Shepherd Angels Christian School</p>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gold-text">Payroll Management System</p>
    </div>
  );
}

/* ── Step 1: password ──────────────────────────────────────────────────── */

function PasswordStep({ notice, onOtpRequired, onForgot }) {
  const [identity, setIdentity] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const navigating = React.useRef(false);

  async function submit(event) {
    event.preventDefault();
    // One request per press: Enter plus a click used to spend two of the
    // account's five throttled attempts (src/lib/auth/login-throttle.js).
    if (busy || navigating.current) return;
    const id = identity.trim();
    const pw = password.trim();
    if (!id || !pw) {
      setError(!id ? "Enter your username or email." : "Enter your password.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const { response, result } = await postJson("/api/legacy-auth/login", { employeeId: id, password: pw });
      if (!response.ok) {
        setError(result.error || "Unable to sign in.");
        return;
      }
      if (result.otp_required) {
        onOtpRequired({ maskedEmail: result.masked_email, resendAfter: Number(result.resend_after) || RESEND_SECONDS });
        return;
      }
      if (!result.redirectTo) {
        setError(result.error || "Unable to sign in.");
        return;
      }
      saveAuthContext(result, result.role || "employee", result.profile?.email);
      navigating.current = true;
      window.location.href = result.redirectTo;
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      // Stay "Signing in..." while the portal loads, so it cannot be pressed again.
      if (!navigating.current) setBusy(false);
    }
  }

  return (
    <Card className="border-border/80 shadow-xl shadow-brand-green/5">
      <CardHeader>
        <CardTitle className="text-2xl">Sign in</CardTitle>
        <CardDescription>Enter your credentials to open your portal.</CardDescription>
      </CardHeader>
      <form onSubmit={submit} noValidate>
        <CardContent className="space-y-4">
          {notice ? (
            <Alert className="border-brand-gold/60 bg-secondary text-secondary-foreground">
              <AlertDescription className="text-secondary-foreground">{notice}</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="login-identity">Username or email</Label>
            <Input
              id="login-identity"
              autoComplete="username"
              placeholder="Enter your username or email"
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              aria-invalid={Boolean(error) && !identity.trim()}
              className="h-11"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="login-password">Password</Label>
              <Button type="button" variant="link" size="xs" className="h-auto px-0 text-gold-text" onClick={onForgot}>
                Forgot password?
              </Button>
            </div>
            <div className="relative">
              <Input
                id="login-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(error) && !password.trim()}
                className="h-11 pr-11"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </Button>
            </div>
          </div>
        </CardContent>
        <CardFooter className="mt-6 flex-col gap-3">
          <Button type="submit" size="lg" className="h-11 w-full text-base" disabled={busy}>
            {busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Signing in...</> : "Sign in"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/* ── Step 2: emailed code ──────────────────────────────────────────────── */

function CodeStep({ maskedEmail, sentAt, resendAfter, onBack, onResent }) {
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [resendAt, setResendAt] = React.useState(() => Date.now() + resendAfter * 1000);
  const [resending, setResending] = React.useState(false);
  const [mailtm, setMailtm] = React.useState(false);
  const [reading, setReading] = React.useState(false);
  const navigating = React.useRef(false);

  const resendIn = useCountdown(resendAt);
  const expiresIn = useCountdown(sentAt + CODE_TTL_SECONDS * 1000);

  // Development only: is the mail.tm test inbox reader switched on?
  React.useEffect(() => {
    let live = true;
    fetch("/api/dev/mailtm")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (live) setMailtm(Boolean(data?.enabled)); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const verify = React.useCallback(async (value) => {
    if (busy || navigating.current) return;
    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(value)) {
      setFeedback({ text: `Enter the ${CODE_LENGTH}-digit code from your email.`, ok: false });
      return;
    }
    setBusy(true);
    setFeedback({ text: "", ok: false });
    try {
      const { response, result } = await postJson("/api/legacy-auth/verify-login-otp", { code: value });
      if (!response.ok || !result.redirectTo) {
        setFeedback({ text: result.error || "Unable to verify your code.", ok: false });
        setCode("");
        // A lockout or an expired pending sign-in cannot be retried here.
        if (result.code === "otp_locked_out" || result.code === "pending_login_expired") {
          toast.error(result.error || "Please sign in again.");
          setTimeout(onBack, 1800);
        }
        return;
      }
      saveAuthContext(result, result.role || "employee", result.profile?.email);
      navigating.current = true;
      setFeedback({ text: "Verified. Opening your portal...", ok: true });
      window.location.href = result.redirectTo;
    } catch {
      setFeedback({ text: NETWORK_ERROR, ok: false });
    } finally {
      if (!navigating.current) setBusy(false);
    }
  }, [busy, onBack]);

  async function resend() {
    if (resendIn > 0 || resending) return;
    setResending(true);
    setFeedback({ text: "", ok: false });
    try {
      const { response, result } = await postJson("/api/legacy-auth/resend-login-otp");
      if (!response.ok) {
        setFeedback({ text: result.error || "Unable to send a new code.", ok: false });
        if (response.status === 429) {
          const wait = Number(response.headers.get("Retry-After")) || RESEND_SECONDS;
          setResendAt(Date.now() + wait * 1000);
        }
        if (result.code === "pending_login_expired") setTimeout(onBack, 1800);
        return;
      }
      setCode("");
      setResendAt(Date.now() + (Number(result.resend_after) || RESEND_SECONDS) * 1000);
      onResent();
      toast.success(result.message || "A new code has been sent.");
    } catch {
      setFeedback({ text: NETWORK_ERROR, ok: false });
    } finally {
      setResending(false);
    }
  }

  async function readTestInbox() {
    setReading(true);
    try {
      const { response, result } = await postJson("/api/dev/mailtm", {
        action: "latest-otp",
        since: new Date(sentAt - 5000).toISOString(),
      });
      if (!response.ok || !result.code) {
        toast.error(result.error || "No code found in the test inbox.");
        return;
      }
      setCode(result.code);
      toast.success(`Code read from ${result.address}`);
    } catch {
      toast.error(NETWORK_ERROR);
    } finally {
      setReading(false);
    }
  }

  return (
    <Card className="border-border/80 shadow-xl shadow-brand-green/5">
      <CardHeader>
        <div className="mb-2 flex size-11 items-center justify-center rounded-full bg-secondary text-brand-green dark:text-brand-gold-light">
          <MailCheckIcon className="size-5" aria-hidden="true" />
        </div>
        <CardTitle className="text-2xl">Check your email</CardTitle>
        <CardDescription>
          Enter the {CODE_LENGTH}-digit code we sent to{" "}
          <span className="font-medium text-foreground">{maskedEmail || "your email"}</span>.
        </CardDescription>
      </CardHeader>
      <form onSubmit={(e) => { e.preventDefault(); verify(code); }} noValidate>
        <CardContent className="space-y-4">
          <div className="flex flex-col items-center gap-3">
            <Label htmlFor="login-code" className="sr-only">Verification code</Label>
            <InputOTP
              id="login-code"
              maxLength={CODE_LENGTH}
              pattern={REGEXP_ONLY_DIGITS}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={setCode}
              onComplete={verify}
              disabled={busy}
              aria-invalid={Boolean(feedback.text) && !feedback.ok}
              aria-describedby="login-code-help login-code-feedback"
            >
              <InputOTPGroup>
                {[0, 1, 2].map((i) => <InputOTPSlot key={i} index={i} className="h-12 w-11 bg-card font-mono text-lg sm:h-14 sm:w-12" />)}
              </InputOTPGroup>
              <InputOTPSeparator className="text-muted-foreground" />
              <InputOTPGroup>
                {[3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} className="h-12 w-11 bg-card font-mono text-lg sm:h-14 sm:w-12" />)}
              </InputOTPGroup>
            </InputOTP>
            <p id="login-code-help" className="text-xs text-muted-foreground" aria-live="polite">
              {expiresIn > 0 ? <>Code expires in <span className="font-mono">{formatClock(expiresIn)}</span></> : "This code has expired. Request a new one."}
            </p>
          </div>

          <p
            id="login-code-feedback"
            role="alert"
            aria-live="assertive"
            className={`min-h-5 text-center text-sm ${feedback.ok ? "text-success" : "text-destructive"}`}
          >
            {feedback.text}
          </p>

          {mailtm ? (
            <Button type="button" variant="outline" className="w-full border-dashed" onClick={readTestInbox} disabled={reading}>
              {reading ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <InboxIcon aria-hidden="true" />}
              {reading ? "Waiting for the email..." : "Read code from test inbox (mail.tm, dev only)"}
            </Button>
          ) : null}
        </CardContent>
        <CardFooter className="mt-2 flex-col gap-3">
          <Button type="submit" size="lg" className="h-11 w-full text-base" disabled={busy || code.length !== CODE_LENGTH}>
            {busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Verifying...</> : "Verify & sign in"}
          </Button>
          <div className="flex w-full items-center justify-between text-sm">
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={onBack}>
              <ArrowLeftIcon aria-hidden="true" />Different account
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-gold-text"
              onClick={resend}
              disabled={resendIn > 0 || resending}
            >
              {resending ? "Sending..." : resendIn > 0 ? `Resend code (${resendIn}s)` : "Resend code"}
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

/* ── Screen ────────────────────────────────────────────────────────────── */

export default function LoginScreen() {
  const [step, setStep] = React.useState("password");
  const [otp, setOtp] = React.useState({ maskedEmail: "", sentAt: 0, resendAfter: RESEND_SECONDS });
  const [notice, setNotice] = React.useState("");
  const [resetOpen, setResetOpen] = React.useState(false);

  // Arriving here because a sign-in ended elsewhere: say why and drop the
  // stale display context. Otherwise, if the browser still holds a context
  // AND the server agrees the session is live, go straight to the portal —
  // localStorage alone is never trusted (it outlives the session cookie).
  React.useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get("reason") || "";
    const message = LOGIN_REASON_MESSAGES[reason];
    if (message) {
      setNotice(message);
      clearAuthContext();
      return;
    }
    const ctx = readAuthContext();
    if (!ctx?.role || !ROLE_ROUTES[ctx.role]) return;
    fetch("/api/rbac/me")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((me) => {
        if (me?.user?.role === ctx.role) window.location.href = ROLE_ROUTES[ctx.role];
        else clearAuthContext();
      });
  }, []);

  const onOtpRequired = React.useCallback(({ maskedEmail, resendAfter }) => {
    // resend_after < 60 means the code was sent earlier and is still valid.
    const sentAt = Date.now() - Math.max(0, RESEND_SECONDS - resendAfter) * 1000;
    setOtp({ maskedEmail, sentAt, resendAfter });
    setStep("otp");
  }, []);

  const backToPassword = React.useCallback(() => setStep("password"), []);
  const onResent = React.useCallback(() => setOtp((o) => ({ ...o, sentAt: Date.now() })), []);

  return (
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <BrandPanel />
      <section
        className="relative flex min-h-dvh flex-col px-4 py-6 sm:px-8"
        style={{
          backgroundImage:
            "radial-gradient(circle at 100% 0%, color-mix(in oklab, var(--brand-gold) 14%, transparent), transparent 45%), radial-gradient(circle at 0% 100%, color-mix(in oklab, var(--brand-green) 10%, transparent), transparent 50%)",
        }}
      >
        <div className="flex justify-end">
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center py-6">
          <div className="w-full max-w-md">
            <MobileBrand />
            {step === "otp" ? (
              <CodeStep
                maskedEmail={otp.maskedEmail}
                sentAt={otp.sentAt}
                resendAfter={otp.resendAfter}
                onBack={backToPassword}
                onResent={onResent}
              />
            ) : (
              <PasswordStep notice={notice} onOtpRequired={onOtpRequired} onForgot={() => setResetOpen(true)} />
            )}
            <p className="mt-6 text-center text-xs text-muted-foreground">
              Trouble signing in? Contact your branch administrator.
            </p>
          </div>
        </div>
      </section>
      <ResetPasswordDialog open={resetOpen} onOpenChange={setResetOpen} />
    </main>
  );
}
