"use client";

import * as React from "react";
import { ArchiveIcon, ArchiveRestoreIcon, Loader2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/portal/confirm-dialog";
import { DatePicker } from "@/components/portal/date-picker";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch, jsonBody } from "@/lib/portal/api";
import { digitsOnly, formatDigitField } from "@/lib/portal/format";
import { cn } from "@/lib/utils";

/*
 * Add Employee / Edit Employee Information (openHrAddEmployeeModal,
 * openHrEditEmployeeModal, collectHrEmployeeForm, toggleArchiveHrEmployee,
 * public/legacy/js/hr.js). The rules mirror src/lib/employees/record.js and
 * emergency-contact.js so problems show before submitting; the server
 * applies the same rules and has the final say.
 *   Add:  POST  /api/admin/employees
 *   Edit: PATCH /api/hr/employees
 *   Archive / restore: PATCH /api/admin/employees { id, action }
 */

const MIN_WORKING_AGE = 15;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME = /^[A-Za-z\s]+$/;

const SUFFIXES = ["Jr.", "Sr.", "II", "III", "IV", "V"];
const SEXES = ["Male", "Female"];
const CIVIL = ["Single", "Married", "Widowed", "Legally Separated", "Annulled"];
const TYPES = ["Teaching", "Non-Teaching"];
const EMPLOYMENT_TYPES = ["Full-time", "Part-time"];
const EMPLOYMENT_STATUSES = ["Regular", "Probationary", "Contractual", "Substitute"];
const RELATIONSHIPS = ["Spouse", "Parent", "Child", "Sibling", "Guardian", "Relative", "Partner", "Friend", "Other"];
const NONE = "__none__";

const DIGIT_SPEC = {
  cp_number: "cp_number",
  emergency_contact_number: "emergency_contact_number",
  sss_number: "sss_number",
  philhealth_number: "philhealth_number",
  pagibig_number: "pagibig_number",
  tin_number: "tin_number",
  bank_account_number: "bank_account_number",
};

const LABELS = {
  first_name: "First name", middle_initial: "Middle name", last_name: "Last name", suffix: "Suffix", email: "Email",
  role: "Role", employee_status: "Account status", branch_id: "Branch", date_of_birth: "Date of birth", sex: "Sex",
  civil_status: "Civil status", employee_type: "Employee type", position: "Position", employment_type: "Employment type",
  employment_status: "Employment status", date_hired: "Date hired", basic_salary: "Basic salary", address: "Home address",
  cp_number: "Contact number", emergency_contact_name: "Contact person", emergency_contact_relationship: "Relationship",
  emergency_contact_number: "Emergency contact number", emergency_contact_address: "Emergency contact address",
  sss_number: "SSS number", philhealth_number: "PhilHealth number", pagibig_number: "Pag-IBIG number", tin_number: "TIN",
  bank_name: "Bank name", bank_account_number: "Bank account number",
};

const REQUIRED_COMMON = [
  "first_name", "last_name", "email", "employee_status", "date_of_birth", "sex", "civil_status", "employee_type", "position",
  "employment_type", "employment_status", "date_hired", "address", "cp_number", "sss_number", "philhealth_number",
  "pagibig_number", "tin_number", "bank_name", "bank_account_number",
];
const REQUIRED_CREATE = [
  ...REQUIRED_COMMON, "role", "branch_id", "basic_salary",
  "emergency_contact_name", "emergency_contact_relationship", "emergency_contact_number", "emergency_contact_address",
];

const positionForRole = (role) => (String(role || "").toLowerCase() === "accountant" ? "Accountant" : "Employee");

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function yearsBetween(earlier, later) {
  let years = later.getUTCFullYear() - earlier.getUTCFullYear();
  if (later.getUTCMonth() < earlier.getUTCMonth() || (later.getUTCMonth() === earlier.getUTCMonth() && later.getUTCDate() < earlier.getUTCDate())) years -= 1;
  return years;
}

/** Pick an option case-insensitively (setHrSelectValue). */
function pick(options, value) {
  const wanted = String(value || "").toLowerCase();
  return options.find((o) => o.toLowerCase() === wanted) || "";
}

function emptyValues() {
  return {
    first_name: "", middle_initial: "", last_name: "", suffix: "", email: "", role: "employee", employee_status: "Active", branch_id: "",
    date_of_birth: "", sex: "", civil_status: "", employee_type: "", position: "Employee", employment_type: "", employment_status: "",
    date_hired: "", basic_salary: "", address: "", cp_number: "", emergency_contact_name: "", emergency_contact_relationship: "",
    emergency_contact_number: "", emergency_contact_address: "", sss_number: "", philhealth_number: "", pagibig_number: "",
    tin_number: "", bank_name: "", bank_account_number: "",
  };
}

function valuesFromEmployee(e) {
  const values = emptyValues();
  Object.assign(values, {
    first_name: e.first_name || "",
    middle_initial: e.middle_name || "",
    last_name: e.last_name || "",
    suffix: pick(SUFFIXES, e.suffix),
    email: e.email || "",
    date_of_birth: e.date_of_birth || "",
    sex: pick(SEXES, e.sex),
    civil_status: pick(CIVIL, e.civil_status),
    employee_type: pick(TYPES, e.employee_type),
    position: e.position || positionForRole(e.role),
    employment_type: pick(EMPLOYMENT_TYPES, e.employment_type),
    employment_status: pick(EMPLOYMENT_STATUSES, e.employment_status),
    employee_status: pick(["Active", "Pending", "On Leave", "Inactive"], e.employee_status || "Active") || "Active",
    date_hired: e.date_hired || "",
    address: e.address || "",
    bank_name: e.bank_name || "",
    emergency_contact_name: e.emergency_contact_name || "",
    emergency_contact_relationship: pick(RELATIONSHIPS, e.emergency_contact_relationship),
    emergency_contact_address: e.emergency_contact_address || "",
  });
  // A record from before the name parts were stored: best-effort split of full_name.
  if (!e.first_name && !e.last_name && e.full_name) {
    const parts = String(e.full_name).trim().split(/\s+/);
    values.first_name = parts[0] || "";
    values.last_name = parts.length > 1 ? parts[parts.length - 1] : "";
    values.middle_initial = parts.length > 2 ? parts.slice(1, -1).join(" ") : "";
  }
  Object.entries(DIGIT_SPEC).forEach(([key, spec]) => { values[key] = formatDigitField(e[key], spec); });
  return values;
}

/** Field errors and a summary line (collectHrEmployeeForm). Returns { errors, summary, payload }. */
function validate(values, { creating, ecOnFile }) {
  const errors = {};
  const required = creating ? REQUIRED_CREATE : REQUIRED_COMMON;
  const missing = required.filter((key) => !String(values[key] ?? "").trim());
  missing.forEach((key) => { errors[key] = "This field is required."; });
  if (missing.length) {
    return { errors, summary: `Please complete the required field${missing.length > 1 ? "s" : ""}: ${missing.map((k) => LABELS[k]).join(", ")}.` };
  }

  const v = (key) => String(values[key] ?? "").trim();
  const fail = (key, message) => ({ errors: { [key]: message }, summary: message });

  if (!NAME.test(v("first_name"))) return fail("first_name", "First name must contain letters and spaces only.");
  if (v("middle_initial") && !NAME.test(v("middle_initial"))) return fail("middle_initial", "Middle name must contain letters and spaces only.");
  if (!NAME.test(v("last_name"))) return fail("last_name", "Last name must contain letters and spaces only.");
  if (!EMAIL.test(v("email"))) return fail("email", "Enter a valid email address.");

  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const birth = parseDate(v("date_of_birth"));
  if (!birth) return fail("date_of_birth", "Date of birth is not a valid date.");
  if (birth >= today) return fail("date_of_birth", "Date of birth must be in the past.");
  if (yearsBetween(birth, today) < MIN_WORKING_AGE) return fail("date_of_birth", `The employee must be at least ${MIN_WORKING_AGE} years old.`);
  const hired = parseDate(v("date_hired"));
  if (!hired) return fail("date_hired", "Date hired is not a valid date.");
  if (yearsBetween(birth, hired) < MIN_WORKING_AGE) return fail("date_hired", `Date hired must be on or after the employee's ${MIN_WORKING_AGE}th birthday.`);

  let basicSalary;
  if (creating) {
    basicSalary = Number(v("basic_salary"));
    if (!(basicSalary > 0) || basicSalary > 9999999.99) return fail("basic_salary", "Basic salary must be greater than 0 and at most ₱9,999,999.99.");
  }
  if (v("address").length < 5) return fail("address", "Enter the complete home address.");

  const cp = digitsOnly(v("cp_number"));
  if (!/^09\d{9}$/.test(cp)) return fail("cp_number", "Contact number must be an 11-digit PH mobile number starting with 09.");
  const sss = digitsOnly(v("sss_number"));
  if (sss.length !== 10) return fail("sss_number", "SSS number must be exactly 10 digits.");
  const philhealth = digitsOnly(v("philhealth_number"));
  if (philhealth.length !== 12) return fail("philhealth_number", "PhilHealth number must be exactly 12 digits.");
  const pagibig = digitsOnly(v("pagibig_number"));
  if (pagibig.length !== 12) return fail("pagibig_number", "Pag-IBIG number must be exactly 12 digits.");
  const tin = digitsOnly(v("tin_number"));
  if (tin.length !== 9 && tin.length !== 12) return fail("tin_number", "TIN must be 9 digits, or 12 digits including the branch code.");
  const bank = digitsOnly(v("bank_account_number"));
  if (bank.length < 6 || bank.length > 20) return fail("bank_account_number", "Bank account number must be 6 to 20 digits.");

  // Required on Add. On Edit a record with none on file may stay blank, but
  // once any field is filled, or one is already on file, all four must be valid.
  const ecNumber = digitsOnly(v("emergency_contact_number"));
  const ecTouched = ["emergency_contact_name", "emergency_contact_relationship", "emergency_contact_address"].some((k) => v(k)) || Boolean(ecNumber);
  if (creating || ecTouched || ecOnFile) {
    if (!v("emergency_contact_name")) return fail("emergency_contact_name", "Emergency contact person is required.");
    if (!NAME.test(v("emergency_contact_name"))) return fail("emergency_contact_name", "Emergency contact name must contain letters and spaces only.");
    if (!v("emergency_contact_relationship")) return fail("emergency_contact_relationship", "Select the emergency contact's relationship.");
    if (v("emergency_contact_address").length < 5) return fail("emergency_contact_address", "Enter the emergency contact's complete address.");
    if (!/^09\d{9}$/.test(ecNumber)) return fail("emergency_contact_number", "Emergency contact number must be an 11-digit PH mobile number starting with 09.");
    if (ecNumber === cp) return fail("emergency_contact_number", "Emergency contact number must be different from the employee's own number.");
  }

  const payload = {
    first_name: v("first_name"), middle_initial: v("middle_initial"), last_name: v("last_name"), suffix: v("suffix"), email: v("email"),
    date_of_birth: v("date_of_birth"), sex: v("sex"), civil_status: v("civil_status"), employee_type: v("employee_type"),
    position: v("position"), employment_type: v("employment_type"), employment_status: v("employment_status"),
    employee_status: v("employee_status"), date_hired: v("date_hired"), address: v("address"), cp_number: cp,
    sss_number: sss, philhealth_number: philhealth, pagibig_number: pagibig, tin_number: tin, bank_name: v("bank_name"),
    bank_account_number: bank,
  };
  if (creating) {
    payload.role = v("role");
    payload.branch_id = v("branch_id");
    payload.basic_salary = basicSalary;
  }
  payload.emergency_contact_name = v("emergency_contact_name");
  payload.emergency_contact_relationship = v("emergency_contact_relationship");
  payload.emergency_contact_address = v("emergency_contact_address");
  payload.emergency_contact_number = ecNumber;
  return { errors: {}, summary: "", payload };
}

function Section({ children }) {
  return (
    <div className="pt-2 sm:col-span-2">
      <Separator className="mb-3" />
      <p className="text-xs font-semibold tracking-wide text-gold-text uppercase">{children}</p>
    </div>
  );
}

export function EmployeeFormDialog({ mode, employee, branches, defaultBranch, branchName, open, onOpenChange, onSaved }) {
  const { notify } = usePortalSession();
  const creating = mode === "add";
  const [values, setValues] = React.useState(emptyValues);
  const [errors, setErrors] = React.useState({});
  const [hints, setHints] = React.useState({});
  const [feedback, setFeedback] = React.useState({ text: "", tone: "" });
  const [busy, setBusy] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const [confirmDialog, confirm] = useConfirm();
  const activeBranches = (branches || []).filter((b) => String(b.status || "Active").toLowerCase() === "active");

  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setHints({});
    setBusy(false);
    setArchiving(false);
    if (creating) {
      const next = emptyValues();
      if (defaultBranch && activeBranches.some((b) => b.id === defaultBranch)) next.branch_id = defaultBranch;
      setValues(next);
      setFeedback({ text: "", tone: "" });
    } else if (employee) {
      const next = valuesFromEmployee(employee);
      setValues(next);
      const missing = REQUIRED_COMMON.filter((key) => !String(next[key] ?? "").trim());
      setFeedback(missing.length
        ? { text: `This record is incomplete: ${missing.map((k) => LABELS[k]).join(", ")}. Fill these in to save.`, tone: "info" }
        : { text: "", tone: "" });
    }
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee, creating]);

  const set = (key, value) => {
    setValues((current) => {
      const next = { ...current, [key]: value };
      if (key === "role") next.position = positionForRole(value);
      return next;
    });
    if (errors[key] && String(value || "").trim()) setErrors((current) => ({ ...current, [key]: "" }));
  };

  const setName = (key, raw) => {
    const cleaned = raw.replace(/[^A-Za-z\s]/g, "");
    setHints((current) => ({ ...current, [key]: cleaned !== raw ? "Only letters and spaces are allowed." : "" }));
    set(key, cleaned);
  };

  async function submit(event) {
    event.preventDefault();
    const result = validate(creating ? values : { ...values, position: values.position }, {
      creating,
      ecOnFile: !creating && Boolean(employee?.emergency_contact_name),
    });
    setErrors(result.errors);
    if (!result.payload) {
      setFeedback({ text: result.summary, tone: "error" });
      const first = Object.keys(result.errors)[0];
      document.getElementById(`emp-form-${first}`)?.focus();
      return;
    }
    setBusy(true);
    setFeedback({ text: creating ? "Creating employee…" : "Saving…", tone: "info" });
    try {
      const response = creating
        ? await apiFetch("/api/admin/employees", jsonBody("POST", result.payload))
        : await apiFetch("/api/hr/employees", jsonBody("PATCH", { ...result.payload, id: employee.id }));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || (creating ? "Failed to create employee." : "Update failed."));
      if (creating) {
        const created = data.employee || {};
        setFeedback({ text: `${created.full_name || "Employee"} created (${created.employee_id || "ID pending"}). They will be asked to change their default password on first sign-in.`, tone: "success" });
        notify("Employee Created", `${created.full_name || "New employee"} has been added.`, "success");
        setTimeout(() => { onOpenChange(false); onSaved(); }, 1200);
      } else {
        setFeedback({ text: "Employee updated successfully.", tone: "success" });
        notify("Employee Updated", `${result.payload.first_name} ${result.payload.last_name}'s record was saved.`, "success");
        setTimeout(() => { onOpenChange(false); onSaved(); }, 700);
      }
    } catch (error) {
      setFeedback({ text: error.message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!employee) return;
    const action = employee.archived ? "restore" : "archive";
    const name = employee.full_name || "this employee";
    const ok = await confirm(action === "archive"
      ? { title: "Archive this employee?", description: `${name} will be signed out, will not be able to sign in or tap RFID, and will move to the Archived list. Payroll and attendance history is kept.`, confirmLabel: "Archive", destructive: true }
      : { title: "Restore this employee?", description: `${name} will be able to sign in and tap RFID again.`, confirmLabel: "Restore" });
    if (!ok) return;
    setArchiving(true);
    try {
      const response = await apiFetch("/api/admin/employees", jsonBody("PATCH", { id: employee.id, action }));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Failed to ${action} employee.`);
      notify(action === "archive" ? "Employee Archived" : "Employee Restored", action === "archive" ? `${name} was moved to Archived.` : `${name} is active again.`, action === "archive" ? "info" : "success");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      setFeedback({ text: error.message, tone: "error" });
      setArchiving(false);
    }
  }

  const field = (key, children, { wide = false, required = false, hint } = {}) => (
    <div className={cn("space-y-2", wide && "sm:col-span-2")}>
      <Label htmlFor={`emp-form-${key}`}>{LABELS[key]}{required ? <span className="text-destructive" aria-hidden="true"> *</span> : null}</Label>
      {children}
      {errors[key] ? <p id={`emp-form-${key}-error`} className="text-sm text-destructive">{errors[key]}</p>
        : hints[key] ? <p className="text-xs text-warning">{hints[key]}</p>
          : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );

  const aria = (key) => ({ id: `emp-form-${key}`, "aria-invalid": errors[key] ? true : undefined, "aria-describedby": errors[key] ? `emp-form-${key}-error` : undefined });

  const text = (key, props = {}) => <Input {...aria(key)} value={values[key]} onChange={(e) => set(key, e.target.value)} {...props} />;
  const name = (key, props = {}) => <Input {...aria(key)} value={values[key]} onChange={(e) => setName(key, e.target.value)} maxLength={30} autoComplete="off" {...props} />;
  const digits = (key, props = {}) => <Input {...aria(key)} inputMode="numeric" value={values[key]} onChange={(e) => set(key, formatDigitField(e.target.value, DIGIT_SPEC[key]))} {...props} />;
  const readOnly = (key, value) => <Input id={`emp-form-${key}`} value={value} readOnly tabIndex={-1} className="bg-muted text-muted-foreground" />;
  const select = (key, options, placeholder, { allowNone = false } = {}) => (
    <Select value={values[key] || (allowNone ? NONE : "")} onValueChange={(value) => set(key, value === NONE ? "" : value)}>
      <SelectTrigger {...aria(key)} className="w-full"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {allowNone ? <SelectItem value={NONE}>{placeholder}</SelectItem> : null}
        {options.map((option) => (typeof option === "string"
          ? <SelectItem key={option} value={option}>{option}</SelectItem>
          : <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>))}
      </SelectContent>
    </Select>
  );
  const date = (key) => <DatePicker {...aria(key)} value={values[key]} onChange={(value) => set(key, value)} />;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{creating ? "Add employee" : "Edit employee information"}</DialogTitle>
            <DialogDescription>
              {creating
                ? "Creates an Employee or Accountant account and their 201 record. Fields marked * are required."
                : "Update this employee's 201 record. Fields marked * are required."}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} noValidate className="grid items-start gap-4 sm:grid-cols-2">
            <p className="text-xs font-semibold tracking-wide text-gold-text uppercase sm:col-span-2">Account</p>
            {field("first_name", name("first_name", { placeholder: "e.g. Juan" }), { required: true })}
            {field("middle_initial", name("middle_initial", { placeholder: "e.g. Santos" }))}
            {field("last_name", name("last_name", { placeholder: "e.g. Dela Cruz" }), { required: true })}
            {field("suffix", select("suffix", SUFFIXES, "None", { allowNone: true }))}
            {field("email", text("email", { type: "email", maxLength: 100, placeholder: "e.g. juan.delacruz@example.com", autoComplete: "off" }), { wide: true, required: true })}
            {creating ? (
              <>
                {field("role", select("role", [{ value: "employee", label: "Employee" }, { value: "accountant", label: "Accountant" }], "Select role"), { required: true })}
                {field("employee_status", select("employee_status", ["Active", "Pending"], "Select status"), { required: true })}
                {field("branch_id", select("branch_id", activeBranches.map((b) => ({ value: b.id, label: b.name })), activeBranches.length ? "Select branch" : "No active branches — ask the Super Admin to add one"), { wide: true, required: true })}
              </>
            ) : (
              <>
                <div className="space-y-2"><Label htmlFor="emp-form-employee_id">Employee ID</Label>{readOnly("employee_id", employee?.employee_id || "—")}</div>
                <div className="space-y-2"><Label htmlFor="emp-form-role_label">Role</Label>{readOnly("role_label", employee?.role === "accountant" ? "Accountant" : "Employee")}</div>
                <div className="space-y-2 sm:col-span-2"><Label htmlFor="emp-form-branch_label">Branch</Label>{readOnly("branch_label", branchName(employee?.branch_id) || "Unassigned")}</div>
              </>
            )}

            <Section>Personal information</Section>
            {field("date_of_birth", date("date_of_birth"), { required: true })}
            {field("sex", select("sex", SEXES, "Select sex"), { required: true })}
            {field("civil_status", select("civil_status", CIVIL, "Select civil status"), { wide: true, required: true })}

            <Section>Employment</Section>
            {field("employee_type", select("employee_type", TYPES, "Select type"), { required: true })}
            {field("position", readOnly("position", values.position), { required: true })}
            {field("employment_type", select("employment_type", EMPLOYMENT_TYPES, "Select employment type"), { required: true })}
            {field("employment_status", select("employment_status", EMPLOYMENT_STATUSES, "Select employment status"), { required: true })}
            {field("date_hired", date("date_hired"), { required: true })}
            {creating
              ? field("basic_salary", text("basic_salary", { type: "number", min: "0.01", max: "9999999.99", step: "0.01", inputMode: "decimal", placeholder: "e.g. 18500" }), { required: true, hint: "Monthly, in pesos." })
              : field("employee_status", select("employee_status", ["Active", "Pending", "On Leave", "Inactive"], "Select status"), { required: true })}

            <Section>Address &amp; contact</Section>
            {field("address", <Textarea {...aria("address")} rows={2} maxLength={200} placeholder="House no., street, barangay, city/municipality, province" value={values.address} onChange={(e) => set("address", e.target.value)} />, { wide: true, required: true })}
            {field("cp_number", digits("cp_number", { type: "tel", placeholder: "e.g. 0917 123 4567" }), { wide: true, required: true })}

            <Section>Emergency contact</Section>
            {!creating && !employee?.emergency_contact_name ? (
              <p className="-mt-2 text-xs text-muted-foreground sm:col-span-2">No emergency contact on file for this employee yet. Fill in all four fields to add one.</p>
            ) : null}
            {field("emergency_contact_name", name("emergency_contact_name", { maxLength: 100, placeholder: "e.g. Maria Dela Cruz" }), { required: creating })}
            {field("emergency_contact_relationship", select("emergency_contact_relationship", RELATIONSHIPS, "Select relationship", { allowNone: !creating }), { required: creating })}
            {field("emergency_contact_number", digits("emergency_contact_number", { type: "tel", placeholder: "e.g. 0918 765 4321" }), { wide: true, required: creating })}
            {field("emergency_contact_address", <Textarea {...aria("emergency_contact_address")} rows={2} maxLength={200} placeholder="House no., street, barangay, city/municipality, province" value={values.emergency_contact_address} onChange={(e) => set("emergency_contact_address", e.target.value)} />, { wide: true, required: creating })}

            <Section>Government ID numbers</Section>
            {field("sss_number", digits("sss_number", { placeholder: "e.g. 12-3456789-0" }), { required: true })}
            {field("philhealth_number", digits("philhealth_number", { placeholder: "e.g. 12-345678901-2" }), { required: true })}
            {field("pagibig_number", digits("pagibig_number", { placeholder: "e.g. 1234-5678-9012" }), { required: true })}
            {field("tin_number", digits("tin_number", { placeholder: "e.g. 123-456-789-000" }), { required: true })}

            <Section>Bank account (payroll)</Section>
            {field("bank_name", text("bank_name", { maxLength: 50, placeholder: "e.g. BDO, BPI, Landbank", autoComplete: "off" }), { required: true })}
            {field("bank_account_number", digits("bank_account_number", { placeholder: "e.g. 001234567890", autoComplete: "off" }), { required: true })}

            {feedback.text ? (
              <Alert variant={feedback.tone === "error" ? "destructive" : "default"} className={cn("sm:col-span-2", feedback.tone === "success" && "border-success/40 text-success")}>
                <AlertDescription className={cn(feedback.tone === "success" && "text-success")}>{feedback.text}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter className="gap-2 sm:col-span-2 sm:gap-2">
              {!creating && employee ? (
                <Button type="button" variant={employee.archived ? "secondary" : "destructive"} className="sm:mr-auto" onClick={toggleArchive} disabled={archiving || busy}>
                  {archiving ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : employee.archived ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
                  {employee.archived ? "Restore employee" : "Archive employee"}
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={busy || archiving}>
                {busy ? <><Loader2Icon className="animate-spin" aria-hidden="true" />{creating ? "Creating…" : "Saving…"}</> : creating ? "Create employee" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}
