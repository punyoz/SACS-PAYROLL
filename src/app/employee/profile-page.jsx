"use client";

import * as React from "react";
import { HeartHandshakeIcon, PencilIcon, UserRoundIcon } from "lucide-react";
import { ProfilePhotoButton } from "@/components/portal/profile-photo-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoList } from "@/components/portal/info-list";
import { useAccountDialogs } from "@/components/portal/app-shell";
import { usePortalSession } from "@/components/portal/session";
import { EmploymentSection, GovernmentSection, governmentNumbers, useStoredProfile } from "@/components/portal/staff-profile";
import { formatContactNumber } from "@/lib/portal/format";

/*
 * The Profile page (loadProfilePage, public/legacy/js/employee.js).
 * 2026-11-26: also the HR and Accountant Profile page (they are employees too): the same
 * sections, with their role on the badge. Admin and Super Admin keep StaffProfilePage.
 */

const EMERGENCY_KEYS = [
  "emergency_contact_name", "emergency_contact_relationship",
  "emergency_contact_address", "emergency_contact_number",
];

function Section({ icon: Icon, title, children }) {
  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-gold-text" aria-hidden="true" />{title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function ProfilePage({ roleLabel = null }) {
  const { ctx, updateContext } = usePortalSession();
  const { open } = useAccountDialogs();

  // The emergency contact is refreshed from the stored profile
  // (loadOwnEmergencyContact, app.js); Employment and Government contributions come from it too (2026-11-26).
  const stored = useStoredProfile(React.useCallback((p) => {
    const patch = {};
    EMERGENCY_KEYS.forEach((key) => { patch[key] = p[key] || ""; });
    updateContext(patch);
  }, [updateContext]));
  const onPayroll = stored ? stored.on_payroll !== false : null;

  const name = ctx?.full_name || "Employee Name";

  return (
    <>
      <Card className="relative gap-0 overflow-hidden border-0 py-0 shadow-md">
        <div className="h-24 bg-gradient-to-br from-brand-green to-brand-green-dark" aria-hidden="true">
          <div className="h-full w-full bg-[radial-gradient(circle_at_85%_20%,color-mix(in_srgb,var(--brand-gold)_35%,transparent),transparent_55%)]" />
        </div>
        <div aria-hidden="true" className="h-1 bg-brand-gold" />
        <CardContent className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-end">
          <ProfilePhotoButton name={ctx?.full_name} className="-mt-10 size-20 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold">{name}</h2>
              <Badge variant="secondary" className={roleLabel ? undefined : "capitalize"}>{roleLabel || ctx?.role || "Employee"}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {ctx?.position || ctx?.employee_type || ""}{ctx?.position || ctx?.employee_type ? " · " : ""}Shepherd Angels Christian School
            </p>
          </div>
          <Button variant="outline" onClick={() => open("profile")}>
            <PencilIcon aria-hidden="true" />Edit account
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section icon={UserRoundIcon} title="Personal information">
          <InfoList items={[
            { label: "Full name", value: ctx?.full_name },
            { label: "Employee ID", value: ctx?.employee_id || stored?.employment?.employee_id },
            { label: "Contact number", value: formatContactNumber(ctx?.cp_number) },
            { label: "Sex", value: ctx?.sex },
            { label: "Civil status", value: ctx?.civil_status },
            { label: "Email address", value: ctx?.email, wide: true },
            { label: "Home address", value: ctx?.address, wide: true },
          ]} />
        </Section>

        {onPayroll === true ? <EmploymentSection employment={stored.employment} /> : null}

        <Section icon={HeartHandshakeIcon} title="Emergency contact">
          <InfoList items={[
            { label: "Contact person", value: ctx?.emergency_contact_name },
            { label: "Relationship", value: ctx?.emergency_contact_relationship },
            { label: "Contact number", value: formatContactNumber(ctx?.emergency_contact_number) },
            { label: "Address", value: ctx?.emergency_contact_address, wide: true },
          ]} />
        </Section>

        {onPayroll === true ? <GovernmentSection numbers={governmentNumbers(stored, ctx)} note="Government numbers are set by HR for payroll. Contact HR to change them." /> : null}
      </div>
    </>
  );
}
