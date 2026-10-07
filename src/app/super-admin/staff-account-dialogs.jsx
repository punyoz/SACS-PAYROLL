"use client";

import * as React from "react";
import { ArchiveIcon, ArchiveRestoreIcon, CheckIcon, CopyIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { PasswordInput } from "@/components/portal/account-dialogs";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DatePicker } from "@/components/portal/date-picker";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch, fetchJson, jsonBody } from "@/lib/portal/api";
import { digitsOnly, formatDigitField } from "@/lib/portal/format";
import {
  CIVIL_STATUSES,
  EMERGENCY_RELATIONSHIPS,
  NAME_SUFFIXES,
  SEXES,
  STAFF_ROLE_LABELS,
  STAFF_RULES,
  checkStaffFields,
  cleanStaffField,
  latestBirthDate,
} from "@/lib/portal/staff-rules";
import { cn } from "@/lib/utils";

/*
 * Add Staff Account (openSAStaffAccountModal / submitSAStaffAccount) and Edit
 * Account (openSAAdminUserModal / submitSAAdminUser / toggleArchiveSAAdminUser),
 * public/legacy/js/super-admin.js.
 *   Add:     POST  /api/admin/staff-accounts — the server builds the first-time
 *            password and returns it once.
 *   Edit:    PATCH /api/admin/users { id, action: "update", ... }, then an Admin
 *            moved to another branch goes through POST /api/admin/branch-employees.
 *   Archive: PATCH /api/admin/users { id, action: "archive" | "restore" }.
 */

const NONE = "__none__";

const LABELS = {
  first_name: "First name", middle_name: "Middle name", last_name: "Last name", suffix: "Suffix", email: "Email",
  role: "Role", employee_status: "Account status", branch_id: "Branch", date_of_birth: "Date of birth",
  date_hired: "Date hired", sex: "Sex", civil_status: "Civil status", cp_number: "Contact number", address: "Home address",
  emergency_contact_name: "Contact person", emergency_contact_relationship: "Relationship",
  emergency_contact_number: "Emergency contact number", emergency_contact_address: "Emergency contact address",
  password: "Reset password (optional)",
};

const EC_FIELDS = ["emergency_contact_name", "emergency_contact_relationship", "emergency_contact_number", "emergency_contact_address"];
const EDIT_FIELDS = ["first_name", "middle_name", "last_name", "suffix", "email", "role", "branch_id", ...EC_FIELDS, "password"];
const ADD_FIELDS = [
  "first_name", "middle_name", "last_name", "suffix", "email", "role", "employee_status", "branch_id",
  "date_of_birth", "date_hired", "sex", "civil_status", "cp_number", "address", ...EC_FIELDS,
];
const REQUIRED = new Set([
  "first_name", "last_name", "email", "role", "employee_status", "date_of_birth", "date_hired", "sex", "civil_status",
  "cp_number", "address",
]);

/**
 * Values, live filtering and on-the-spot messages for a staff form. A
 * message shows once its field has been touched, or after a submit attempt.
 */
function useStaffForm(fields, options) {
  const [values, setValues] = React.useState({});
  const [touched, setTouched] = React.useState(() => new Set());
  const [notes, setNotes] = React.useState({});
  const [submitted, setSubmitted] = React.useState(false);

  const reset = React.useCallback((next, { touchAll = false } = {}) => {
    setValues(next);
    setNotes({});
    setSubmitted(false);
    setTouched(touchAll ? new Set(fields) : new Set());
  }, [fields]);

  const touch = (name) => setTouched((current) => (current.has(name) ? current : new Set(current).add(name)));

  const set = (name, raw) => {
    let value = raw;
    const rule = STAFF_RULES[name];
    if (rule?.digits) {
      value = formatDigitField(raw, rule.digits);
    } else if (rule?.clean) {
      const cleaned = cleanStaffField(name, raw);
      value = cleaned.value;
      setNotes((current) => ({ ...current, [name]: cleaned.note }));
    }
    setValues((current) => {
      const next = { ...current, [name]: value };
      // Only Admin carries a branch; HR and Super Admin are never assigned one.
      if (name === "role" && value !== current.role) next.branch_id = "";
      return next;
    });
    touch(name);
  };

  // Leaving a field tidies its spaces (not the password's).
  const blur = (name) => {
    if (name !== "password") {
      setValues((current) => (typeof current[name] === "string" ? { ...current, [name]: current[name].trim().replace(/\s{2,}/g, " ") } : current));
    }
    touch(name);
  };

  const allErrors = checkStaffFields(fields, values, options);
  const shown = Object.fromEntries(fields.map((name) => [name, (submitted || touched.has(name)) ? allErrors[name] : ""]));
  const valid = fields.every((name) => !allErrors[name]);

  return { values, set, blur, reset, errors: shown, notes, valid, setSubmitted };
}

function SectionTitle({ children }) {
  return (
    <div className="pt-2 sm:col-span-2">
      <Separator className="mb-3" />
      <p className="text-xs font-semibold tracking-wide text-gold-text uppercase">{children}</p>
    </div>
  );
}

/** The inputs both dialogs share, bound to a useStaffForm. */
function useFieldKit(form, prefix) {
  const { values, set, blur, errors, notes } = form;
  const id = (name) => `${prefix}-${name}`;
  const aria = (name) => ({
    id: id(name),
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": errors[name] || notes[name] ? `${id(name)}-msg` : undefined,
  });

  const field = (name, control, { wide = false, required = REQUIRED.has(name), hint, label = LABELS[name], bare = false } = {}) => (
    <div className={cn("space-y-2", wide && "sm:col-span-2")}>
      {bare ? null : <Label htmlFor={id(name)}>{label}{required ? <span className="text-destructive" aria-hidden="true"> *</span> : null}</Label>}
      {control}
      {errors[name] ? <p id={`${id(name)}-msg`} className="text-sm text-destructive">{errors[name]}</p>
        : notes[name] ? <p id={`${id(name)}-msg`} className="text-xs text-warning">{notes[name]}</p>
          : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );

  const text = (name, props = {}) => (
    <Input {...aria(name)} value={values[name] ?? ""} onChange={(e) => set(name, e.target.value)} onBlur={() => blur(name)} autoComplete="off" spellCheck={false} {...props} />
  );

  const select = (name, options, placeholder, { allowNone = false, disabled = false } = {}) => (
    <Select
      value={values[name] || (allowNone ? NONE : "")}
      onValueChange={(value) => set(name, value === NONE ? "" : value)}
      disabled={disabled}
    >
      <SelectTrigger {...aria(name)} className="w-full"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {allowNone ? <SelectItem value={NONE}>{placeholder}</SelectItem> : null}
        {options.map((option) => (typeof option === "string"
          ? <SelectItem key={option} value={option}>{option}</SelectItem>
          : <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>))}
      </SelectContent>
    </Select>
  );

  /** HR serves every branch and Super Admin reaches every branch, so only Admin picks one (saApplyStaffBranchRule). */
  const branch = (branches) => {
    const role = values.role;
    if (role === "hr" || role === "super_admin") {
      return field("branch_id", (
        <Select value={role === "hr" ? "__all__" : NONE} disabled>
          <SelectTrigger id={id("branch_id")} className="w-full opacity-60"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Branches</SelectItem>
            <SelectItem value={NONE}>No branch</SelectItem>
          </SelectContent>
        </Select>
      ), {
        required: false,
        hint: role === "hr" ? "HR serves every branch, so it is not assigned one." : "Super Admin reaches every branch, so it is not assigned one.",
      });
    }
    return field("branch_id", select("branch_id", branches.map((b) => ({ value: String(b.id), label: b.name })), branches.length ? "Select branch" : "No active branches"), { required: true });
  };

  return { field, text, select, branch, aria, id };
}

function roleOptions() {
  return Object.entries(STAFF_ROLE_LABELS).map(([value, label]) => ({ value, label }));
}

function Feedback({ feedback }) {
  if (!feedback.text) return null;
  return (
    <Alert variant={feedback.tone === "error" ? "destructive" : "default"} className={cn("sm:col-span-2", feedback.tone === "success" && "border-success/40")} role={feedback.tone === "error" ? "alert" : "status"}>
      <AlertDescription className={cn(feedback.tone === "success" && "text-success")}>{feedback.text}</AlertDescription>
    </Alert>
  );
}

function focusFirstInvalid(prefix, fields, errors) {
  const first = fields.find((name) => errors[name]);
  if (first) document.getElementById(`${prefix}-${first}`)?.focus();
}

/* ── Edit Account ── */

export function EditStaffDialog({ user, branches, open, onOpenChange, onSaved }) {
  const { ctx, notify } = usePortalSession();
  const ecOnFile = Boolean(user?.emergency_contact_name);
  const options = React.useMemo(() => ({ editing: true, ecOnFile }), [ecOnFile]);
  const form = useStaffForm(EDIT_FIELDS, options);
  const kit = useFieldKit(form, "sa-edit");
  const [feedback, setFeedback] = React.useState({ text: "", tone: "" });
  const [busy, setBusy] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const [confirmDialog, confirm] = useConfirm();
  const { reset } = form;

  React.useEffect(() => {
    if (!open || !user) return;
    setFeedback({ text: "", tone: "" });
    setBusy(false);
    setArchiving(false);
    // Everything is marked touched: a value saved before a rule existed shows its problem now.
    reset({
      first_name: user.first_name || "",
      middle_name: user.middle_name || "",
      last_name: user.last_name || "",
      suffix: NAME_SUFFIXES.includes(user.suffix) ? user.suffix : "",
      email: user.email || "",
      role: user.role || "admin",
      branch_id: user.branch_id ? String(user.branch_id) : "",
      emergency_contact_name: user.emergency_contact_name || "",
      emergency_contact_relationship: EMERGENCY_RELATIONSHIPS.includes(user.emergency_contact_relationship) ? user.emergency_contact_relationship : "",
      emergency_contact_address: user.emergency_contact_address || "",
      emergency_contact_number: formatDigitField(user.emergency_contact_number, "emergency_contact_number"),
      password: "",
    }, { touchAll: true });
  }, [open, user, reset]);

  // Active branches, plus the account's current one even if it was closed.
  const branchOptions = (branches || []).filter((b) => String(b.status || "Active").toLowerCase() === "active" || String(b.id) === String(user?.branch_id || ""));

  async function save(event) {
    event.preventDefault();
    if (busy || !user) return;
    form.setSubmitted(true);
    if (!form.valid) {
      setFeedback({ text: "Please correct the highlighted fields.", tone: "error" });
      focusFirstInvalid("sa-edit", EDIT_FIELDS, checkStaffFields(EDIT_FIELDS, form.values, options));
      return;
    }
    const v = (name) => String(form.values[name] || "").trim();
    const role = v("role");
    const branchId = role === "admin" ? v("branch_id") : "";
    const payload = {
      id: user.id,
      action: "update",
      first_name: v("first_name"),
      middle_name: v("middle_name"),
      last_name: v("last_name"),
      suffix: v("suffix"),
      email: v("email").toLowerCase(),
      role,
      emergency_contact_name: v("emergency_contact_name"),
      emergency_contact_relationship: v("emergency_contact_relationship"),
      emergency_contact_address: v("emergency_contact_address"),
      emergency_contact_number: digitsOnly(v("emergency_contact_number")),
    };
    if (v("password")) payload.password = v("password");
    const displayName = [payload.first_name, payload.middle_name, payload.last_name, payload.suffix].filter(Boolean).join(" ");

    setBusy(true);
    setFeedback({ text: "Saving…", tone: "" });
    try {
      await fetchJson("/api/admin/users", jsonBody("PATCH", payload));
      // Moving an Admin goes through branch-employees, which keeps
      // profiles.branch_id in step. Becoming HR or Super Admin clears it server-side.
      if (role === "admin" && branchId !== String(user.branch_id || "")) {
        try {
          await fetchJson("/api/admin/branch-employees", jsonBody("POST", { user_id: user.id, branch_id: branchId, assigned_by: String(ctx?.full_name || "Super Admin") }));
        } catch (error) {
          throw new Error(error.message && error.message !== "Request failed." ? error.message : "Account saved, but the branch could not be changed.");
        }
      }
      setFeedback({ text: "Account updated.", tone: "success" });
      notify("Account Updated", `${displayName}'s account was updated.`, "success");
      await onSaved();
      setTimeout(() => onOpenChange(false), 500);
    } catch (error) {
      setFeedback({ text: error.message || "Failed to save account.", tone: "error" });
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!user) return;
    const action = user.archived ? "restore" : "archive";
    const ok = await confirm(action === "archive"
      ? { title: "Archive this account?", description: "Archived accounts cannot sign in and are signed out immediately.", confirmLabel: "Archive", destructive: true }
      : { title: "Restore this account?", description: "This account will be able to sign in again.", confirmLabel: "Restore" });
    if (!ok) return;
    setArchiving(true);
    try {
      await fetchJson("/api/admin/users", jsonBody("PATCH", { id: user.id, action }));
      notify(action === "archive" ? "Account Archived" : "Account Restored", action === "archive" ? "The account has been archived." : "The account has been restored.", "info");
      await onSaved();
      onOpenChange(false);
    } catch (error) {
      setFeedback({ text: error.message || "Failed to update account.", tone: "error" });
    } finally {
      setArchiving(false);
    }
  }

  const { field, text, select } = kit;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit {STAFF_ROLE_LABELS[user?.role] || ""} account</DialogTitle>
            <DialogDescription>{user?.full_name}{user?.staff_id ? ` · ${user.staff_id}` : ""}. Fields marked * are required.</DialogDescription>
          </DialogHeader>
          <form onSubmit={save} noValidate className="grid items-start gap-4 sm:grid-cols-2">
            <p className="text-xs font-semibold tracking-wide text-gold-text uppercase sm:col-span-2">Account</p>
            {field("first_name", text("first_name", { placeholder: "e.g. Juan", autoCapitalize: "words" }))}
            {field("middle_name", text("middle_name", { placeholder: "e.g. Santos (optional)", autoCapitalize: "words" }))}
            {field("last_name", text("last_name", { placeholder: "e.g. Dela Cruz", autoCapitalize: "words" }))}
            {field("suffix", select("suffix", NAME_SUFFIXES, "None", { allowNone: true }))}
            {field("email", text("email", { type: "email", inputMode: "email", placeholder: "e.g. maria.hr@example.com", autoCapitalize: "none" }), { wide: true })}
            {field("role", select("role", roleOptions(), "Select role"))}
            {kit.branch(branchOptions)}

            <SectionTitle>Emergency contact</SectionTitle>
            {!ecOnFile ? <p className="-mt-2 text-xs text-muted-foreground sm:col-span-2">No emergency contact on file for this account yet. Fill in all four fields to add one.</p> : null}
            {field("emergency_contact_name", text("emergency_contact_name", { placeholder: "e.g. Maria Dela Cruz", autoCapitalize: "words" }), { required: false })}
            {field("emergency_contact_relationship", select("emergency_contact_relationship", EMERGENCY_RELATIONSHIPS, "Select relationship", { allowNone: true }), { required: false })}
            {field("emergency_contact_number", text("emergency_contact_number", { type: "tel", inputMode: "numeric", placeholder: "e.g. 0918 765 4321" }), { required: false })}
            {field("emergency_contact_address", text("emergency_contact_address", { placeholder: "e.g. 45 Rizal Ave, Pasig City" }), { required: false })}

            <SectionTitle>Password</SectionTitle>
            {field("password", (
              <PasswordInput
                id="sa-edit-password"
                label={LABELS.password}
                value={form.values.password ?? ""}
                onChange={(value) => form.set("password", value)}
                placeholder="Leave blank to keep the current password"
                invalid={Boolean(form.errors.password)}
              />
            ), { wide: true, bare: true, hint: "8-72 characters with an uppercase letter, a number and a symbol. If you set one, the account must replace it on its next sign-in." })}

            <Feedback feedback={feedback} />

            <DialogFooter className="gap-2 sm:col-span-2 sm:gap-2">
              {user ? (
                <Button type="button" variant={user.archived ? "secondary" : "destructive"} className="sm:mr-auto" onClick={toggleArchive} disabled={archiving || busy}>
                  {archiving ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : user.archived ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
                  {user.archived ? "Restore account" : "Archive account"}
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={busy || archiving}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Saving…</> : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}

/* ── Add Staff Account ── */

const EMPTY_ADD = {
  first_name: "", middle_name: "", last_name: "", suffix: "", email: "", role: "super_admin", employee_status: "Active",
  branch_id: "", date_of_birth: "", date_hired: "", sex: "", civil_status: "", cp_number: "", address: "",
  emergency_contact_name: "", emergency_contact_relationship: "", emergency_contact_address: "", emergency_contact_number: "",
};

function CreatedNotice({ created }) {
  const [copied, setCopied] = React.useState(false);
  if (!created) return null;
  const copy = () => {
    navigator.clipboard?.writeText(created.password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <Alert className="border-success/40 bg-success/5 sm:col-span-2" role="status">
      <KeyRoundIcon className="text-success" aria-hidden="true" />
      <AlertTitle className="text-success">Account created{created.staffId ? ` with ID ${created.staffId}` : ""}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>First-time password — give this to the account holder. They must change it when they first sign in. It is not shown again.</p>
        <div className="flex items-center gap-2">
          <code className="rounded-md border bg-background px-2 py-1 font-mono text-sm text-foreground">{created.password}</code>
          <Button type="button" variant="outline" size="sm" onClick={copy}>{copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}{copied ? "Copied" : "Copy"}</Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function AddStaffDialog({ branches, open, onOpenChange, onSaved }) {
  const { notify } = usePortalSession();
  const options = React.useMemo(() => ({ editing: false }), []);
  const form = useStaffForm(ADD_FIELDS, options);
  const kit = useFieldKit(form, "sa-add");
  const [feedback, setFeedback] = React.useState({ text: "", tone: "" });
  const [created, setCreated] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const { reset } = form;

  React.useEffect(() => {
    if (!open) return;
    setFeedback({ text: "", tone: "" });
    setCreated(null);
    setBusy(false);
    reset(EMPTY_ADD);
  }, [open, reset]);

  // A new account can only be placed in a branch that is open.
  const activeBranches = (branches || []).filter((b) => String(b.status || "Active").toLowerCase() === "active");

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    form.setSubmitted(true);
    if (!form.valid) {
      setFeedback({ text: "Please correct the highlighted fields.", tone: "error" });
      focusFirstInvalid("sa-add", ADD_FIELDS, checkStaffFields(ADD_FIELDS, form.values, options));
      return;
    }
    const v = (name) => String(form.values[name] || "").trim();
    const role = v("role");
    const payload = {
      first_name: v("first_name"),
      middle_name: v("middle_name"),
      last_name: v("last_name"),
      suffix: v("suffix"),
      email: v("email").toLowerCase(),
      role,
      branch_id: role === "admin" ? v("branch_id") : "",
      employee_status: v("employee_status"),
      date_of_birth: v("date_of_birth"),
      date_hired: v("date_hired"),
      sex: v("sex"),
      civil_status: v("civil_status"),
      cp_number: digitsOnly(v("cp_number")),
      address: v("address"),
      emergency_contact_name: v("emergency_contact_name"),
      emergency_contact_relationship: v("emergency_contact_relationship"),
      emergency_contact_address: v("emergency_contact_address"),
      emergency_contact_number: digitsOnly(v("emergency_contact_number")),
    };
    const displayName = [payload.first_name, payload.middle_name, payload.last_name, payload.suffix].filter(Boolean).join(" ");

    setBusy(true);
    setCreated(null);
    setFeedback({ text: "", tone: "" });
    try {
      const response = await apiFetch("/api/admin/staff-accounts", jsonBody("POST", payload));
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        setFeedback({ text: result.error || "Unable to create this account.", tone: "error" });
        return;
      }
      // Shown once, and only here.
      setCreated({ staffId: result.staff_id || "", password: result.temporary_password || "" });
      notify("Staff Account Created", `${displayName} can now sign in as ${STAFF_ROLE_LABELS[role] || role}.`, "success");
      reset(EMPTY_ADD);
      onSaved();
    } catch {
      setFeedback({ text: "Unable to reach the server. Check your connection and try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const { field, text, select, aria } = kit;
  const dateField = (name, props = {}) => (
    <DatePicker {...aria(name)} value={form.values[name] ?? ""} onChange={(value) => form.set(name, value)} {...props} />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add staff account</DialogTitle>
          <DialogDescription>
            Creates a Super Admin, Admin or HR login. Fields marked * are required. A first-time password is generated automatically and shown once after saving.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} noValidate className="grid items-start gap-4 sm:grid-cols-2">
          <CreatedNotice created={created} />

          <p className="text-xs font-semibold tracking-wide text-gold-text uppercase sm:col-span-2">Account</p>
          {field("first_name", text("first_name", { placeholder: "e.g. Juan", autoCapitalize: "words", autoFocus: true }))}
          {field("middle_name", text("middle_name", { placeholder: "e.g. Santos (optional)", autoCapitalize: "words" }))}
          {field("last_name", text("last_name", { placeholder: "e.g. Dela Cruz", autoCapitalize: "words" }))}
          {field("suffix", select("suffix", NAME_SUFFIXES, "None", { allowNone: true }))}
          {field("email", text("email", { type: "email", inputMode: "email", placeholder: "e.g. juan.delacruz@example.com", autoCapitalize: "none" }), { wide: true })}
          {field("role", select("role", roleOptions(), "Select role"))}
          {field("employee_status", select("employee_status", ["Active", "Pending"], "Select status"))}
          {kit.branch(activeBranches)}

          <SectionTitle>Personal information</SectionTitle>
          {field("date_of_birth", dateField("date_of_birth", { min: "1900-01-01", max: latestBirthDate() }), { hint: "Must be at least 18 years old. Used with the last name to build the first-time password." })}
          {field("date_hired", dateField("date_hired"))}
          {field("sex", select("sex", SEXES, "Select"))}
          {field("civil_status", select("civil_status", CIVIL_STATUSES, "Select"))}
          {field("cp_number", text("cp_number", { type: "tel", inputMode: "numeric", placeholder: "e.g. 0917 123 4567" }))}
          {field("address", text("address", { placeholder: "e.g. 12 Mabini St, Quezon City" }))}

          <SectionTitle>Emergency contact</SectionTitle>
          {field("emergency_contact_name", text("emergency_contact_name", { placeholder: "e.g. Maria Dela Cruz", autoCapitalize: "words" }), { required: true })}
          {field("emergency_contact_relationship", select("emergency_contact_relationship", EMERGENCY_RELATIONSHIPS, "Select relationship"), { required: true })}
          {field("emergency_contact_number", text("emergency_contact_number", { type: "tel", inputMode: "numeric", placeholder: "e.g. 0918 765 4321" }), { required: true })}
          {field("emergency_contact_address", text("emergency_contact_address", { placeholder: "e.g. 45 Rizal Ave, Pasig City" }), { required: true })}

          <Feedback feedback={feedback} />

          <DialogFooter className="gap-2 sm:col-span-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{created ? "Done" : "Cancel"}</Button>
            <Button type="submit" disabled={busy}>{busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />Creating…</> : "Create account"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
