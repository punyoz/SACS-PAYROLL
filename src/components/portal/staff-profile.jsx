"use client";

import * as React from "react";
import { BriefcaseIcon, HeartHandshakeIcon, KeyRoundIcon, PencilIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { ProfilePhotoButton } from "@/components/portal/profile-photo-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoList } from "@/components/portal/info-list";
import { useAccountDialogs } from "@/components/portal/app-shell";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch } from "@/lib/portal/api";
import { DIGIT_FIELD_SPECS, formatContactNumber, formatPiiForDisplay, initialsOf } from "@/lib/portal/format";
import { dateLabel } from "@/lib/portal/payroll-preview";

/*
 * The Profile page of the staff portals (Admin / HR / Super Admin):
 * loadAdminProfile in public/legacy/js/admin.js with loadOwnStaffId,
 * renderOwnContactAndGovIds and loadOwnEmergencyContact from app.js. The
 * staff ID and the emergency contact are refreshed from the stored profile.
 */

const REFRESH_KEYS = [
  "staff_id", "emergency_contact_name", "emergency_contact_relationship",
  "emergency_contact_address", "emergency_contact_number",
];

function Section({ icon: Icon, title, children }) {
  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Icon className="size-4 text-gold-text" aria-hidden="true" />{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * 2026-11-26: the two payroll sections of every on-payroll profile (employee, HR, Accountant), from
 * GET /api/legacy-auth/update-profile (`employment`, the masked government numbers). Hidden for an
 * account not on payroll.
 */
export function EmploymentSection({ employment }) {
  const e = employment || {};
  return (
    <Section icon={BriefcaseIcon} title="Employment">
      <div data-testid="profile-employment">
        <InfoList items={[
          { label: "Employee ID", value: e.employee_id },
          { label: "Category", value: e.category },
          { label: "Employment status", value: e.employment_status },
          { label: "Position", value: e.position },
          { label: "Branch", value: e.branch },
          { label: "Date hired", value: e.date_hired ? dateLabel(e.date_hired) : "" },
        ]} />
      </div>
    </Section>
  );
}

export function GovernmentSection({ numbers, note = null }) {
  const n = numbers || {};
  return (
    <Section icon={ShieldCheckIcon} title="Government contributions">
      <div data-testid="profile-government">
        <InfoList items={[
          { label: "SSS number", value: n.sss_number },
          { label: "PhilHealth number", value: n.philhealth_number },
          { label: "Pag-IBIG number", value: n.pagibig_number },
          { label: "TIN", value: formatPiiForDisplay(n.tin_number, DIGIT_FIELD_SPECS.tin_number.groups) },
        ]} />
      </div>
      {note ? <p className="mt-4 text-xs text-muted-foreground">{note}</p> : null}
    </Section>
  );
}

/** The stored profile (GET /api/legacy-auth/update-profile), or null until it loads. */
export function useStoredProfile(onLoad) {
  const [stored, setStored] = React.useState(null);
  const loaded = React.useRef(onLoad);
  React.useEffect(() => { loaded.current = onLoad; });
  React.useEffect(() => {
    let cancelled = false;
    apiFetch("/api/legacy-auth/update-profile", { method: "GET", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.profile) return;
        setStored(data.profile);
        loaded.current?.(data.profile);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return stored;
}

/** Each government number: the stored (masked) one, else the session's. */
export const governmentNumbers = (stored, ctx) => Object.fromEntries(["sss_number", "philhealth_number", "pagibig_number", "tin_number"].map((k) => [k, stored?.[k] || ctx?.[k] || ""]));

/**
 * accountOnly: the Super Admin's account has no employee record (loadSAProfile,
 * super-admin.js) — name, role, email, ID and emergency contact only, with
 * Change Password in place of Edit Account.
 */
export function StaffProfilePage({ roleLabel, showPosition = false, employeeIdLabel = false, accountOnly = false }) {
  const { ctx, updateContext } = usePortalSession();
  const { open } = useAccountDialogs();
  // 2026-11-24: an account not on payroll (Admin, Super Admin, kept system accounts) has no government
  // contributions, salary, date hired or tenure to show. Unknown until the profile loads: hidden meanwhile.
  // 2026-11-26: on payroll (HR, Accountant): Employment and Government contributions, as for an employee.
  const stored = useStoredProfile(React.useCallback((p) => {
    const patch = {};
    REFRESH_KEYS.forEach((key) => {
      if (key === "staff_id") { if (p.staff_id) patch.staff_id = p.staff_id; } else patch[key] = p[key] || "";
    });
    updateContext(patch);
  }, [updateContext]));
  const onPayroll = stored ? stored.on_payroll !== false : null;

  const name = ctx?.full_name || `${roleLabel} User`;

  return (
    <>
      <Card className="relative gap-0 overflow-hidden border-0 py-0 shadow-md">
        <div className="h-24 bg-gradient-to-br from-brand-green to-brand-green-dark" aria-hidden="true" />
        <div aria-hidden="true" className="h-1 bg-brand-gold" />
        <CardContent className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-end">
          <ProfilePhotoButton name={ctx?.full_name || roleLabel} className="-mt-10 size-20 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold">{name}</h2>
              <Badge variant="secondary">{roleLabel}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{ctx?.position || ctx?.employee_type || roleLabel} · Shepherd Angels Christian School</p>
          </div>
          {accountOnly
            ? <Button variant="outline" onClick={() => open("password")}><KeyRoundIcon aria-hidden="true" />Change password</Button>
            : <Button variant="outline" onClick={() => open("profile")}><PencilIcon aria-hidden="true" />Edit account</Button>}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section icon={UserRoundIcon} title="Personal information">
          <InfoList items={[
            { label: "Full name", value: ctx?.full_name },
            // Staff portals carry a STAFF-### ID; the Accountant has an employee ID.
            employeeIdLabel ? { label: "Employee ID", value: ctx?.employee_id } : { label: "ID", value: ctx?.staff_id },
            // On payroll, position and category are under Employment (not twice).
            ...(showPosition && onPayroll === false ? [{ label: "Position", value: ctx?.position }, { label: "Category", value: ctx?.employee_type }] : []),
            { label: "Email address", value: ctx?.email, wide: true },
            ...(employeeIdLabel ? [] : [{ label: "Account role", value: ctx?.role }]),
            ...(accountOnly ? [] : [
              { label: "Contact number", value: formatContactNumber(ctx?.cp_number) },
              { label: "Home address", value: ctx?.address, wide: true },
            ]),
          ]} />
        </Section>
        <Section icon={HeartHandshakeIcon} title="Emergency contact">
          <InfoList items={[
            { label: "Contact person", value: ctx?.emergency_contact_name },
            { label: "Relationship", value: ctx?.emergency_contact_relationship },
            { label: "Contact number", value: formatContactNumber(ctx?.emergency_contact_number) },
            { label: "Address", value: ctx?.emergency_contact_address, wide: true },
          ]} />
        </Section>
        {accountOnly || onPayroll !== true ? null : <EmploymentSection employment={stored.employment} />}
        {accountOnly || onPayroll !== true ? null : <GovernmentSection numbers={governmentNumbers(stored, ctx)} />}
      </div>
    </>
  );
}
