"use client";

import * as React from "react";
import { CheckIcon, CircleIcon, KeyRoundIcon, Loader2Icon, LogOutIcon, ShieldAlertIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { GreenAuthLayout } from "@/app/login/login-screen";
import { PASSWORD_MIN_LENGTH } from "@/app/login/auth-context";
import { PASSWORD_RULES, PasswordInput, evaluateRules, firstRuleError } from "@/components/portal/account-dialogs";
import { apiFetch, hardNavigate, jsonBody } from "@/lib/portal/api";
import { cn } from "@/lib/utils";

/**
 * The mandatory change-password screen: an account still on the password it
 * was issued sees only this until it is replaced (the API refuses every
 * other call meanwhile, src/proxy.js). Same as the legacy screen
 * (public/legacy/pages/change-password.html, initPasswordChangeScreen and
 * requestPasswordChange in js/app.js): one step, no second emailed code —
 * it only appears right after a sign-in whose code was already verified.
 *   POST /api/legacy-auth/change-password
 * On success the stored flag is cleared and the page reloads into the portal.
 *
 * Rendered by PortalSessionProvider outside its context, so the session
 * pieces it needs come in as props.
 */
export function PasswordGate({ ctx, updateContext, logout }) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [feedback, setFeedback] = React.useState({ text: "", ok: false, field: "" });

  const rules = evaluateRules(current.trim(), next.trim(), confirm.trim(), ctx);
  const firstName = String(ctx?.full_name || "").trim().split(/\s+/)[0];

  const edit = (setter) => (value) => {
    setter(value);
    if (!feedback.ok && feedback.text) setFeedback({ text: "", ok: false, field: "" });
  };

  async function submit(event) {
    event.preventDefault();
    if (busy || done) return;
    const c = current.trim();
    const n = next.trim();
    const k = confirm.trim();
    if (!c || !n || !k) {
      setFeedback({ text: "Fill in all three password fields.", ok: false, field: !c ? "current" : !n ? "new" : "confirm" });
      return;
    }
    if (n !== k) {
      setFeedback({ text: "New passwords do not match.", ok: false, field: "confirm" });
      return;
    }
    const problem = firstRuleError(evaluateRules(c, n, k, ctx));
    if (problem) {
      setFeedback({ text: problem, ok: false, field: "new" });
      return;
    }
    setBusy(true);
    setFeedback({ text: "", ok: false, field: "" });
    try {
      const response = await apiFetch("/api/legacy-auth/change-password", jsonBody("POST", { current_password: c, new_password: n, confirm_password: k }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = result.error || "Failed to update password.";
        setFeedback({ text: message, ok: false, field: /current password/i.test(message) ? "current" : /^new password/i.test(message) ? "new" : "" });
        setBusy(false);
        return;
      }
      setDone(true);
      setFeedback({ text: "Password updated. Opening your portal…", ok: true, field: "" });
      setCurrent("");
      setNext("");
      setConfirm("");
      // Then a fresh load, as the legacy screen did: the portal boots with the new session.
      setTimeout(() => {
        updateContext({ must_change_password: false });
        hardNavigate(window.location.href);
      }, 900);
    } catch {
      setFeedback({ text: "Network error — your password was not changed. Please try again.", ok: false, field: "" });
      setBusy(false);
    }
  }

  return (
    <GreenAuthLayout>
      <Card className="shadow-lg">
        <CardHeader>
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-gold-text uppercase">
            <KeyRoundIcon className="size-3.5" aria-hidden="true" />First sign-in · Secure your account
          </p>
          <CardTitle className="text-2xl">Change your password</CardTitle>
          <CardDescription>
            {firstName ? `Welcome, ${firstName}! ` : "Welcome! "}Before you continue, set a new password for your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} noValidate className="space-y-4">
            <Alert className="border-warning/40 bg-warning/5">
              <ShieldAlertIcon className="text-warning" aria-hidden="true" />
              <AlertDescription>
                You signed in with the default password you were given (your last name and date of birth). Anyone who knows those details could use it, so it must be replaced before you can use the system.
              </AlertDescription>
            </Alert>

            <PasswordInput
              id="cp-current"
              label="Current password"
              autoComplete="current-password"
              placeholder="Password you signed in with"
              value={current}
              onChange={edit(setCurrent)}
              invalid={feedback.field === "current"}
              readOnly={done}
              autoFocus
            />
            <PasswordInput
              id="cp-new"
              label="New password"
              placeholder={`At least ${PASSWORD_MIN_LENGTH} characters, with uppercase, number and symbol`}
              value={next}
              onChange={edit(setNext)}
              invalid={feedback.field === "new"}
              readOnly={done}
            />
            <PasswordInput
              id="cp-confirm"
              label="Confirm new password"
              placeholder="Type the new password again"
              value={confirm}
              onChange={edit(setConfirm)}
              invalid={feedback.field === "confirm"}
              readOnly={done}
            />

            <ul className="grid gap-1 rounded-md border bg-muted/40 p-3 text-xs" aria-label="Password requirements">
              {PASSWORD_RULES.map(([key, text]) => (
                <li key={key} className={cn("flex items-center gap-1.5", rules[key] ? "text-success" : "text-muted-foreground")}>
                  {rules[key] ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <CircleIcon className="size-3" aria-hidden="true" />}
                  {text}
                  <span className="sr-only">{rules[key] ? "(met)" : "(not met)"}</span>
                </li>
              ))}
            </ul>

            {feedback.text ? (
              <Alert variant={feedback.ok ? "default" : "destructive"} className={cn(feedback.ok && "border-success/40")} role={feedback.ok ? "status" : "alert"}>
                <AlertDescription className={cn(feedback.ok && "text-success")}>{feedback.text}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" size="lg" className="w-full" disabled={busy || done}>
              {done ? <><CheckIcon aria-hidden="true" />Done</> : busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Updating…</> : "Update password & continue"}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t text-xs text-muted-foreground">
          <span className="truncate">{ctx?.email ? `Signed in as ${ctx.email}` : ""}</span>
          <Button type="button" variant="ghost" size="sm" onClick={logout}><LogOutIcon aria-hidden="true" />Sign out</Button>
        </CardFooter>
      </Card>
    </GreenAuthLayout>
  );
}
