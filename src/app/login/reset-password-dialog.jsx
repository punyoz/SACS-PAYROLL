"use client";

import * as React from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { toast } from "sonner";
import { CheckIcon, CircleIcon, EyeIcon, EyeOffIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN_LENGTH, evaluatePasswordShape, saveAuthContext } from "./auth-context";

/**
 * "Forgot password?" — three steps, all through POST /api/legacy-auth/reset-password,
 * exactly as the legacy dialog (public/legacy/js/app.js, sendResetOtp /
 * verifyResetOtp / completeResetPassword):
 *   1. "send"    Employee ID or email -> a 6-digit code (valid 5 minutes)
 *   2. "verify"  the code; only when it checks out does step 3 appear
 *   3. "reset"   new password + confirmation
 * The server keeps which step this browser is on in a signed cookie.
 */

const RESEND_SECONDS = 60;
const RESTART_CODES = ["otp_expired", "otp_locked_out", "grant_expired", "grant_used"];
const NETWORK_ERROR = "Unable to reach the server. Check your connection and try again.";

const RULES = [
  ["length", `At least ${PASSWORD_MIN_LENGTH} characters`],
  ["mix", "Contains both letters and numbers"],
  ["upper", "At least one uppercase letter"],
  ["symbol", "At least one symbol (e.g. ! @ # $)"],
  ["spaces", "No spaces"],
  ["match", "Passwords match"],
];

async function post(body) {
  const response = await fetch("/api/legacy-auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, result: await response.json().catch(() => ({})) };
}

function PasswordField({ id, label, value, onChange, placeholder }) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          autoComplete="new-password"
          maxLength={72}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 pr-11"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
        >
          {show ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </div>
    </div>
  );
}

export function ResetPasswordDialog({ open, onOpenChange }) {
  const [stage, setStage] = React.useState("identity");
  const [identity, setIdentity] = React.useState("");
  const [code, setCode] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [resendAt, setResendAt] = React.useState(0);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!resendAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resendAt]);
  const resendIn = resendAt ? Math.max(0, Math.ceil((resendAt - now) / 1000)) : 0;

  // Every opening starts from step 1.
  React.useEffect(() => {
    if (!open) return;
    setStage("identity");
    setIdentity("");
    setCode("");
    setNext("");
    setConfirm("");
    setBusy(false);
    setFeedback({ text: "", ok: false });
    setResendAt(0);
  }, [open]);

  const rules = evaluatePasswordShape(next.trim(), confirm.trim());

  function restart(message) {
    setStage("identity");
    setCode("");
    setNext("");
    setConfirm("");
    setFeedback({ text: message, ok: false });
  }

  async function send() {
    const id = identity.trim();
    if (!id) {
      setFeedback({ text: "Enter your Employee ID or email address.", ok: false });
      return;
    }
    setBusy(true);
    setFeedback({ text: "", ok: false });
    try {
      const { response, result } = await post({ action: "send", identity: id });
      if (!response.ok) {
        setFeedback({ text: result.error || "Unable to send the code. Please try again.", ok: false });
        if (response.status === 429) {
          setResendAt(Date.now() + (Number(response.headers.get("Retry-After")) || RESEND_SECONDS) * 1000);
        }
        return;
      }
      setStage("otp");
      setCode("");
      setFeedback({ text: result.message || "If the account exists, a code has been sent.", ok: true });
      setResendAt(Date.now() + (Number(result.resend_after) || RESEND_SECONDS) * 1000);
    } catch {
      setFeedback({ text: NETWORK_ERROR, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function verify(value = code) {
    if (!/^\d{6}$/.test(value)) {
      setFeedback({ text: "Enter the 6-digit code from your email.", ok: false });
      return;
    }
    setBusy(true);
    setFeedback({ text: "", ok: false });
    try {
      const { response, result } = await post({ action: "verify", code: value });
      if (!response.ok) {
        if (RESTART_CODES.includes(result.code)) restart(result.error || "Request a new code.");
        else {
          setCode("");
          setFeedback({ text: result.error || "Unable to verify the code. Please try again.", ok: false });
        }
        return;
      }
      setStage("password");
      setFeedback({ text: result.message || "Code verified. Choose your new password.", ok: true });
    } catch {
      setFeedback({ text: NETWORK_ERROR, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    const password = next.trim();
    const confirmation = confirm.trim();
    const failed = RULES.find(([key]) => !rules[key]);
    if (failed) {
      setFeedback({ text: failed[0] === "match" ? "Passwords do not match." : `New password: ${failed[1].toLowerCase()}.`, ok: false });
      return;
    }
    setBusy(true);
    setFeedback({ text: "", ok: false });
    try {
      const { response, result } = await post({ action: "reset", password, confirm_password: confirmation });
      if (!response.ok) {
        if (RESTART_CODES.includes(result.code)) restart(result.error || "Request a new code.");
        else setFeedback({ text: result.error || "Unable to reset your password. Please try again.", ok: false });
        setBusy(false);
        return;
      }
      // The reset also signs the account in (same reply as a sign-in).
      if (result.redirectTo) {
        setFeedback({ text: "Password updated. Opening your account...", ok: true });
        saveAuthContext(result, result.role || "employee", result.profile?.email);
        window.location.href = result.redirectTo;
        return;
      }
      toast.success(result.message || "Your password has been reset.");
      // A full reload on purpose: a fresh sign-in screen showing the notice.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      setTimeout(() => { window.location.href = "/login?reason=password_reset"; }, 1200);
    } catch {
      setFeedback({ text: NETWORK_ERROR, ok: false });
      setBusy(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (stage === "otp") verify();
    else if (stage === "password") reset();
    else send();
  }

  const label = { identity: "Send code", otp: "Verify code", password: "Reset password" }[stage];
  const busyLabel = { identity: "Sending...", otp: "Verifying...", password: "Resetting..." }[stage];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Enter your Employee ID (e.g. <strong className="text-foreground">SACS-001</strong>) or your registered email.
            A 6-digit code, valid for 5 minutes, will be sent to your email.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} noValidate className="space-y-4">
          <p className="rounded-lg border bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            The code goes to the email address registered on your account. If that address is wrong or
            you can no longer open it, contact the administrator.
          </p>

          <div className="space-y-2">
            <Label htmlFor="reset-identity">Employee ID or email</Label>
            <Input
              id="reset-identity"
              autoComplete="off"
              placeholder="e.g. SACS-001 or your@email.com"
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              readOnly={stage !== "identity"}
              className="h-10"
              autoFocus
            />
          </div>

          {stage === "otp" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="reset-code">Code from your email</Label>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto px-0 text-gold-text"
                  onClick={send}
                  disabled={busy || resendIn > 0}
                >
                  {resendIn > 0 ? `Resend (${resendIn}s)` : "Resend code"}
                </Button>
              </div>
              <InputOTP
                id="reset-code"
                maxLength={6}
                pattern={REGEXP_ONLY_DIGITS}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={setCode}
                onComplete={(value) => verify(value)}
                disabled={busy}
                containerClassName="justify-center"
              >
                <InputOTPGroup>
                  {[0, 1, 2].map((i) => <InputOTPSlot key={i} index={i} className="h-11 w-10 font-mono text-base" />)}
                </InputOTPGroup>
                <InputOTPSeparator className="text-muted-foreground" />
                <InputOTPGroup>
                  {[3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} className="h-11 w-10 font-mono text-base" />)}
                </InputOTPGroup>
              </InputOTP>
            </div>
          ) : null}

          {stage === "password" ? (
            <div className="space-y-3">
              <PasswordField id="reset-new" label="New password" value={next} onChange={setNext} placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`} />
              <PasswordField id="reset-confirm" label="Confirm password" value={confirm} onChange={setConfirm} placeholder="Re-enter new password" />
              <ul className="grid gap-1 text-xs sm:grid-cols-2" aria-label="Password requirements">
                {RULES.map(([key, text]) => (
                  <li key={key} className={`flex items-center gap-1.5 ${rules[key] ? "text-success" : "text-muted-foreground"}`}>
                    {rules[key] ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <CircleIcon className="size-3" aria-hidden="true" />}
                    {text}
                    <span className="sr-only">{rules[key] ? "(met)" : "(not met)"}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p role="alert" aria-live="polite" className={`min-h-5 text-sm ${feedback.ok ? "text-success" : "text-destructive"}`}>
            {feedback.text}
          </p>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            <Button type="submit" disabled={busy}>
              {busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />{busyLabel}</> : label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
