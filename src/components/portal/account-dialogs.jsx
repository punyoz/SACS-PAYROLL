"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { CheckIcon, CircleIcon, EyeIcon, EyeOffIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { usePortalSession } from "@/components/portal/session";
import { PASSWORD_MIN_LENGTH } from "@/app/login/auth-context";
import { apiFetch, jsonBody } from "@/lib/portal/api";
import { digitsOnly, formatDigitField, isMaskedPii } from "@/lib/portal/format";

/* ════════════════════════════════════════════════════════════════════════
   Edit Account — the legacy Settings modal's "profile" view
   (public/legacy/js/app.js populateSettingsModalProfile / saveProfileInfo).
   Same endpoint (POST /api/legacy-auth/update-profile), same payload, same
   rules: first and last name required, names letters only, read-only boxes
   and still-masked numbers left out of the request.
   ════════════════════════════════════════════════════════════════════════ */

const SUFFIXES = ["Jr.", "Sr.", "II", "III", "IV", "V"];
const RELATIONSHIPS = ["Spouse", "Parent", "Child", "Sibling", "Guardian", "Relative", "Partner", "Friend", "Other"];
const NONE = "__none__";

// Profile key, its digit mask (DIGIT_FIELD_SPECS), and whether it is a
// government / bank number (read-only where HR sets them).
const ACCOUNT_FIELDS = [
  { key: "cp_number", spec: "cp_number" },
  { key: "address" },
  { key: "emergency_contact_name" },
  { key: "emergency_contact_relationship" },
  { key: "emergency_contact_number", spec: "emergency_contact_number" },
  { key: "emergency_contact_address" },
  { key: "sss_number", spec: "sss_number", payroll: true },
  { key: "philhealth_number", spec: "philhealth_number", payroll: true },
  { key: "pagibig_number", spec: "pagibig_number", payroll: true },
  { key: "tin_number", spec: "tin_number", payroll: true },
  { key: "bank_name", payroll: true },
  { key: "bank_account_number", spec: "bank_account_number", payroll: true },
];

const namePart = (label, required) => z.string().trim().superRefine((value, issue) => {
  if (!value) {
    if (required) issue.addIssue({ code: "custom", message: `${label} is required.` });
    return;
  }
  if (!/^[A-Za-z\s]+$/.test(value)) issue.addIssue({ code: "custom", message: `${label} must contain only letters.` });
});

const accountSchema = z.object({
  first_name: namePart("First name", true),
  middle_name: namePart("Middle name", false),
  last_name: namePart("Last name", true),
  suffix: z.string(),
  ...Object.fromEntries(ACCOUNT_FIELDS.map(({ key }) => [key, z.string()])),
});

function displayValue(field, raw) {
  if (isMaskedPii(raw)) return String(raw);
  if (field.spec) return formatDigitField(raw, field.spec);
  return String(raw || "");
}

function valuesFrom(source) {
  const values = {
    first_name: source?.first_name || "",
    middle_name: source?.middle_name || "",
    last_name: source?.last_name || "",
    suffix: SUFFIXES.includes(source?.suffix) ? source.suffix : "",
  };
  ACCOUNT_FIELDS.forEach((field) => { values[field.key] = displayValue(field, source?.[field.key]); });
  return values;
}

/** Plain join, as on portals without admin.js's composeFullName(); title case where it applies. */
function composeName({ first_name, middle_name, last_name, suffix }, titleCase) {
  const tc = (value) => String(value || "").trim().toLowerCase().split(/\s+/).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  if (!titleCase) return [first_name, middle_name, last_name, suffix].filter(Boolean).join(" ");
  return [[tc(first_name), tc(middle_name), tc(last_name)].filter(Boolean).join(" "), String(suffix || "").trim().slice(0, 16)]
    .filter(Boolean).join(" ");
}

/** A digit box that keeps the dash / space grouping while typing, and shows a stored mask until edited. */
function DigitInput({ field, spec, readOnly, masked, ...props }) {
  return (
    <Input
      {...props}
      {...field}
      inputMode="numeric"
      readOnly={readOnly}
      className={readOnly ? "bg-muted text-muted-foreground" : undefined}
      onFocus={() => { if (!readOnly && masked && field.value === masked) field.onChange(""); }}
      onBlur={() => { if (masked && !field.value) field.onChange(masked); field.onBlur(); }}
      onChange={(event) => field.onChange(formatDigitField(event.target.value, spec))}
    />
  );
}

function SectionLabel({ children, note }) {
  return (
    <div className="pt-2">
      <p className="text-xs font-semibold tracking-wide text-gold-text uppercase">{children}</p>
      {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

export function EditAccountDialog({ open, onOpenChange, payrollReadOnly = true, titleCaseName = false, showBank = true }) {
  const { ctx, updateContext, notify } = usePortalSession();
  const [masks, setMasks] = React.useState({});
  const [serverError, setServerError] = React.useState("");

  const form = useForm({ resolver: zodResolver(accountSchema), defaultValues: valuesFrom(ctx) });

  const rememberMasks = React.useCallback((source) => {
    const next = {};
    ACCOUNT_FIELDS.forEach(({ key }) => { if (isMaskedPii(source?.[key])) next[key] = String(source[key]); });
    setMasks((current) => ({ ...current, ...next }));
  }, []);

  // Fill from the sign-in context, then from the stored profile so a change HR
  // made since sign-in shows. A box already typed in is left alone.
  React.useEffect(() => {
    if (!open) return undefined;
    setServerError("");
    form.reset(valuesFrom(ctx));
    rememberMasks(ctx);
    let cancelled = false;
    apiFetch("/api/legacy-auth/update-profile", { method: "GET", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const stored = data?.profile;
        if (cancelled || !stored) return;
        const fresh = valuesFrom({ ...ctx, ...stored });
        Object.entries(fresh).forEach(([key, value]) => {
          if (stored[key] === undefined && !["first_name", "middle_name", "last_name", "suffix"].includes(key)) return;
          if (!form.getFieldState(key).isDirty) form.setValue(key, value);
        });
        rememberMasks(stored);
        const patch = {};
        ACCOUNT_FIELDS.forEach(({ key }) => { if (stored[key] !== undefined) patch[key] = stored[key] || ""; });
        ["first_name", "middle_name", "last_name", "suffix"].forEach((key) => { if (stored[key]) patch[key] = stored[key]; });
        updateContext(patch);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // Re-run only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onSubmit(values) {
    setServerError("");
    const email = String(ctx?.email || "").trim();
    if (!email) {
      setServerError("Unable to identify account. Please sign in again.");
      return;
    }
    const extra = {};
    ACCOUNT_FIELDS.forEach((field) => {
      if (field.payroll && payrollReadOnly) return;
      // A box this portal's dialog does not show is left out, so nothing on file is wiped.
      if (!showBank && (field.key === "bank_name" || field.key === "bank_account_number")) return;
      const value = values[field.key];
      if (masks[field.key] && value === masks[field.key]) return; // unchanged mask
      extra[field.key] = field.spec ? digitsOnly(value) : String(value || "").trim();
    });
    const names = {
      first_name: values.first_name.trim(),
      middle_name: values.middle_name.trim(),
      last_name: values.last_name.trim(),
      suffix: values.suffix,
    };
    const fullName = composeName(names, titleCaseName);

    try {
      const response = await apiFetch("/api/legacy-auth/update-profile", jsonBody("POST", { email, full_name: fullName, ...names, ...extra }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Failed to update profile.");

      // What the server stored, not what was sent (an employee's bank fields
      // are ignored server-side).
      const saved = result.profile || {};
      const patch = {
        full_name: saved.full_name || fullName,
        first_name: saved.first_name ?? names.first_name,
        middle_name: saved.middle_name ?? names.middle_name,
        last_name: saved.last_name ?? names.last_name,
        suffix: saved.suffix ?? names.suffix,
      };
      ACCOUNT_FIELDS.forEach(({ key }) => { if (saved[key] !== undefined) patch[key] = saved[key] || ""; });
      updateContext(patch);
      notify("Profile Updated", "Your information has been saved.", "success");
      onOpenChange(false);
    } catch (error) {
      setServerError(error.message);
    }
  }

  const textField = (name, label, props = {}) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl><Input {...field} {...props} /></FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const digitField = (name, label, placeholder, readOnly) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <DigitInput field={field} spec={ACCOUNT_FIELDS.find((f) => f.key === name).spec} readOnly={readOnly} masked={masks[name]} placeholder={placeholder} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const selectField = (name, label, options, placeholder) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select value={field.value || NONE} onValueChange={(value) => field.onChange(value === NONE ? "" : value)}>
            <FormControl>
              <SelectTrigger className="w-full"><SelectValue placeholder={placeholder} /></SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value={NONE}>{placeholder}</SelectItem>
              {options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const payrollNote = payrollReadOnly ? "Set by HR for payroll. Contact HR to change these." : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit Account</DialogTitle>
          <DialogDescription>Update your personal details and emergency contact.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
            <SectionLabel>Personal information</SectionLabel>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              {textField("first_name", "First name", { placeholder: "e.g. Juan", autoComplete: "given-name" })}
              {textField("middle_name", "Middle name", { placeholder: "e.g. Santos", autoComplete: "additional-name" })}
              {textField("last_name", "Last name", { placeholder: "e.g. Dela Cruz", autoComplete: "family-name" })}
              {selectField("suffix", "Suffix", SUFFIXES, "None")}
            </div>
            {digitField("cp_number", "Contact number", "e.g. 0917 123 4567", false)}
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Home address</FormLabel>
                  <FormControl><Textarea rows={2} maxLength={200} placeholder="e.g. 123 Rizal St., Barangay San Isidro, Antipolo City, Rizal" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator />
            <SectionLabel>Emergency contact</SectionLabel>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              {textField("emergency_contact_name", "Contact person", { maxLength: 100, placeholder: "e.g. Maria Dela Cruz", autoComplete: "off" })}
              {selectField("emergency_contact_relationship", "Relationship", RELATIONSHIPS, "Select relationship")}
            </div>
            {digitField("emergency_contact_number", "Contact number", "e.g. 0918 765 4321", false)}
            <FormField
              control={form.control}
              name="emergency_contact_address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address</FormLabel>
                  <FormControl><Textarea rows={2} maxLength={200} placeholder="House no., street, barangay, city/municipality, province" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator />
            <SectionLabel note={payrollNote}>Government contributions</SectionLabel>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              {digitField("sss_number", "SSS number", "e.g. 12-3456789-0", payrollReadOnly)}
              {digitField("philhealth_number", "PhilHealth number", "e.g. 12-345678901-2", payrollReadOnly)}
              {digitField("pagibig_number", "Pag-IBIG number", "e.g. 1234-5678-9012", payrollReadOnly)}
              {digitField("tin_number", "TIN", "e.g. 123-456-789-000", payrollReadOnly)}
            </div>

            {showBank ? <SectionLabel note={payrollNote}>Bank information</SectionLabel> : null}
            {showBank ? <div className="grid items-start gap-4 sm:grid-cols-2">
              {textField("bank_name", "Bank name", {
                maxLength: 50,
                placeholder: "e.g. BPI, BDO, Landbank",
                readOnly: payrollReadOnly,
                className: payrollReadOnly ? "bg-muted text-muted-foreground" : undefined,
              })}
              {digitField("bank_account_number", "Bank account number", "Bank account number", payrollReadOnly)}
            </div> : null}

            {serverError ? <p role="alert" className="text-sm text-destructive">{serverError}</p> : null}

            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save information"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Change Password — the legacy three-step flow (app.js
   mountPasswordChangeSteps / advancePasswordChangeFlow /
   requestPasswordChange):
     1. current password -> a 6-digit code to the registered email
        (POST /api/legacy-auth/change-password-otp {action:"start"})
     2. the code         (… {action:"verify"}; "resend" on a 60 s cooldown)
     3. new password     (POST /api/legacy-auth/change-password)
   An account the server exempts from the code (otp_required: false) goes
   straight from step 1 to step 3.
   ════════════════════════════════════════════════════════════════════════ */

const RESTART_CODES = ["otp_expired", "otp_locked_out", "otp_not_verified"];
const DEFAULT_PASSWORD_SYMBOL = "!";
const NETWORK_ERROR = "Unable to reach the server. Check your connection and try again.";

const PASSWORD_RULES = [
  ["length", `At least ${PASSWORD_MIN_LENGTH} characters`],
  ["mix", "Contains both letters and numbers"],
  ["upper", "At least one uppercase letter"],
  ["symbol", "At least one symbol (e.g. ! @ # $)"],
  ["spaces", "No spaces"],
  ["different", "Different from your current password"],
  ["notDefault", "Not your last name + birth date"],
  ["match", "New passwords match"],
];

function lastNameCandidates(fullName) {
  const suffixes = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);
  const tokens = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  while (tokens.length && suffixes.has(tokens[tokens.length - 1].toLowerCase())) tokens.pop();
  const candidates = [];
  for (let start = tokens.length - 1; start >= 1; start -= 1) candidates.push(tokens.slice(start).join("").toLowerCase());
  return candidates;
}

/** looksLikeDefaultPassword (app.js): last name + MMDDYYYY + "!". */
function looksLikeDefaultPassword(password, ctx) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ctx?.date_of_birth || ""));
  if (!match || !password) return false;
  const suffix = `${match[2]}${match[3]}${match[1]}${DEFAULT_PASSWORD_SYMBOL}`;
  if (!password.endsWith(suffix)) return false;
  const prefix = password.slice(0, -suffix.length).toLowerCase();
  return Boolean(prefix) && lastNameCandidates(ctx?.full_name).includes(prefix);
}

function evaluateRules(current, next, confirm, ctx) {
  return {
    length: next.length >= PASSWORD_MIN_LENGTH && next.length <= 72,
    mix: /[A-Za-z]/.test(next) && /\d/.test(next),
    upper: /[A-Z]/.test(next),
    symbol: /[^A-Za-z0-9\s]/.test(next),
    spaces: next.length > 0 && !/\s/.test(next),
    different: next.length > 0 && next !== current,
    notDefault: next.length > 0 && !looksLikeDefaultPassword(next, ctx),
    match: next.length > 0 && next === confirm,
  };
}

/** The first unmet rule's message, in requestPasswordChange()'s order. */
function firstRuleError(rules) {
  if (!rules.length) return `New password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (!rules.spaces) return "New password cannot contain spaces.";
  if (!rules.mix) return "New password must contain both letters and numbers.";
  if (!rules.upper) return "New password must contain at least one uppercase letter.";
  if (!rules.symbol) return "New password must contain at least one symbol (e.g. ! @ # $).";
  if (!rules.different) return "New password must be different from your current password.";
  if (!rules.notDefault) return "New password cannot be your default password (last name + birth date).";
  if (!rules.match) return "New passwords do not match.";
  return "";
}

export function PasswordInput({ id, label, value, onChange, autoComplete = "new-password", placeholder, readOnly, autoFocus, invalid }) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          autoComplete={autoComplete}
          maxLength={72}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={readOnly}
          autoFocus={autoFocus}
          aria-invalid={invalid || undefined}
          className="pr-11"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
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

export function ChangePasswordDialog({ open, onOpenChange }) {
  const { ctx, updateContext, notify } = usePortalSession();
  const [stage, setStage] = React.useState("current"); // current | otp | verified
  const [current, setCurrent] = React.useState("");
  const [code, setCode] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState({ text: "", ok: false });
  const [resendIn, setResendIn] = React.useState(0);
  const [expiresAt, setExpiresAt] = React.useState(0);
  const [now, setNow] = React.useState(Date.now());

  const rules = evaluateRules(current, next, confirm, ctx);

  React.useEffect(() => {
    if (!open) return;
    setStage("current");
    setCurrent("");
    setCode("");
    setNext("");
    setConfirm("");
    setFeedback({ text: "", ok: false });
    setResendIn(0);
    setExpiresAt(0);
  }, [open]);

  React.useEffect(() => {
    if (stage !== "otp") return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
      setResendIn((n) => (n > 0 ? n - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [stage]);

  const report = (text, ok = false) => setFeedback({ text, ok });

  function restart(message) {
    setStage("current");
    setCode("");
    setNext("");
    setConfirm("");
    report(message);
  }

  async function step(payload) {
    try {
      const response = await apiFetch("/api/legacy-auth/change-password-otp", jsonBody("POST", payload));
      return { response, result: await response.json().catch(() => ({})) };
    } catch {
      report(NETWORK_ERROR);
      return null;
    }
  }

  async function start() {
    if (!current.trim()) {
      report("Enter your current password.");
      return;
    }
    setBusy(true);
    report("");
    const reply = await step({ action: "start", current_password: current.trim() });
    setBusy(false);
    if (!reply) return;
    if (!reply.response.ok) {
      report(reply.result.error || "Unable to send the OTP. Please try again.");
      return;
    }
    if (reply.result.otp_required === false) {
      setStage("verified");
      report("Enter and confirm your new password.", true);
      return;
    }
    setStage("otp");
    setResendIn(Number(reply.result.resend_after) || 60);
    setExpiresAt(Date.now() + 5 * 60 * 1000);
    setNow(Date.now());
    report(reply.result.message || "An OTP has been sent to your email.", true);
  }

  async function verify(value = code) {
    if (!/^\d{6}$/.test(value)) {
      report("Enter the 6-digit code from your email.");
      return;
    }
    setBusy(true);
    report("");
    const reply = await step({ action: "verify", code: value });
    setBusy(false);
    if (!reply) return;
    if (!reply.response.ok) {
      if (RESTART_CODES.includes(reply.result.code)) restart(reply.result.error || "Please start again.");
      else {
        setCode("");
        report(reply.result.error || "Unable to verify the OTP. Please try again.");
      }
      return;
    }
    setStage("verified");
    report(reply.result.message || "OTP verified. Enter your new password.", true);
  }

  async function resend() {
    if (busy || resendIn > 0) return;
    setBusy(true);
    const reply = await step({ action: "resend" });
    setBusy(false);
    if (!reply) return;
    if (!reply.response.ok) {
      report(reply.result.error || "Unable to send a new OTP.");
      if (RESTART_CODES.includes(reply.result.code)) restart(reply.result.error || "Please start again.");
      else if (reply.response.status === 429) setResendIn(Number(reply.response.headers.get("Retry-After")) || 60);
      return;
    }
    setCode("");
    setResendIn(Number(reply.result.resend_after) || 60);
    setExpiresAt(Date.now() + 5 * 60 * 1000);
    report(reply.result.message || "A new OTP has been sent.", true);
  }

  async function change() {
    const c = current.trim();
    const n = next.trim();
    const k = confirm.trim();
    if (!c || !n || !k) {
      report("All password fields are required.");
      return;
    }
    const problem = firstRuleError(evaluateRules(c, n, k, ctx));
    if (problem) {
      report(problem);
      return;
    }
    setBusy(true);
    report("");
    try {
      const response = await apiFetch("/api/legacy-auth/change-password", jsonBody("POST", {
        current_password: c,
        new_password: n,
        confirm_password: k,
      }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (RESTART_CODES.includes(result.code)) restart(result.error || "Please start again.");
        else report(result.error || "Failed to update password.");
        return;
      }
      updateContext({ must_change_password: false });
      report(result.message || "Password updated successfully.", true);
      notify("Password Changed", "Your account password has been updated successfully.", "success");
      setTimeout(() => onOpenChange(false), 1200);
    } catch {
      report("Network error — your password was not changed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (stage === "current") start();
    else if (stage === "otp") verify();
    else change();
  }

  const label = stage === "current" ? "Send code" : stage === "otp" ? "Verify code" : "Update password";
  const busyLabel = stage === "current" ? "Sending…" : stage === "otp" ? "Verifying…" : "Updating…";
  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            {stage === "current" && "Enter your current password. We’ll email a 6-digit code to confirm it’s you."}
            {stage === "otp" && "Enter the 6-digit code sent to your registered email."}
            {stage === "verified" && "Choose a new password that meets every rule below."}
          </DialogDescription>
        </DialogHeader>

        <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
          {["Current password", "Email code", "New password"].map((text, index) => {
            const at = ["current", "otp", "verified"].indexOf(stage);
            return (
              <li key={text} className="flex items-center gap-2" aria-current={index === at ? "step" : undefined}>
                <span className={`flex size-5 items-center justify-center rounded-full text-[11px] font-semibold ${index <= at ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  {index < at ? <CheckIcon className="size-3" aria-hidden="true" /> : index + 1}
                </span>
                <span className={index === at ? "font-medium" : "text-muted-foreground"}>{text}</span>
                {index < 2 ? <span className="h-px w-3 bg-border" aria-hidden="true" /> : null}
              </li>
            );
          })}
        </ol>

        <form onSubmit={submit} noValidate className="space-y-4">
          <PasswordInput
            id="cp-current"
            label="Current password"
            autoComplete="current-password"
            placeholder="Enter current password"
            value={current}
            onChange={setCurrent}
            readOnly={stage !== "current"}
            autoFocus
          />

          {stage === "otp" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="cp-code">Code from your email</Label>
                <Button type="button" variant="link" size="xs" className="h-auto px-0 text-gold-text" onClick={resend} disabled={busy || resendIn > 0}>
                  {resendIn > 0 ? `Resend (${resendIn}s)` : "Resend code"}
                </Button>
              </div>
              <InputOTP
                id="cp-code"
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
              <p className="text-center text-xs text-muted-foreground" aria-live="off">
                {secondsLeft > 0
                  ? `Code expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
                  : "This code has expired. Request a new one."}
              </p>
            </div>
          ) : null}

          {stage === "verified" ? (
            <div className="space-y-3">
              <PasswordInput id="cp-new" label="New password" placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`} value={next} onChange={setNext} autoFocus />
              <PasswordInput id="cp-confirm" label="Confirm new password" placeholder="Re-enter new password" value={confirm} onChange={setConfirm} />
              <ul className="grid gap-1 text-xs sm:grid-cols-2" aria-label="Password requirements">
                {PASSWORD_RULES.map(([key, text]) => (
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />{busyLabel}</> : label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

