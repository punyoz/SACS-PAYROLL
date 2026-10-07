"use client";

import * as React from "react";
import { BriefcaseIcon, HeartHandshakeIcon, LandmarkIcon, PencilIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoList } from "@/components/portal/info-list";
import { useAccountDialogs } from "@/components/portal/app-shell";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch } from "@/lib/portal/api";
import { DIGIT_FIELD_SPECS, formatContactNumber, formatPiiForDisplay, initialsOf } from "@/lib/portal/format";

/* The Profile page (loadProfilePage, public/legacy/js/employee.js). */

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

export function ProfilePage() {
  const { ctx, updateContext } = usePortalSession();
  const { open } = useAccountDialogs();

  // The emergency contact is refreshed from the stored profile
  // (loadOwnEmergencyContact, app.js).
  React.useEffect(() => {
    let cancelled = false;
    apiFetch("/api/legacy-auth/update-profile", { method: "GET", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const stored = data?.profile;
        if (cancelled || !stored) return;
        const patch = {};
        EMERGENCY_KEYS.forEach((key) => { patch[key] = stored[key] || ""; });
        updateContext(patch);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [updateContext]);

  const name = ctx?.full_name || "Employee Name";

  return (
    <>
      <Card className="relative gap-0 overflow-hidden border-0 py-0 shadow-md">
        <div className="h-24 bg-gradient-to-br from-brand-green to-brand-green-dark" aria-hidden="true">
          <div className="h-full w-full bg-[radial-gradient(circle_at_85%_20%,color-mix(in_srgb,var(--brand-gold)_35%,transparent),transparent_55%)]" />
        </div>
        <div aria-hidden="true" className="h-1 bg-brand-gold" />
        <CardContent className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-end">
          <Avatar className="-mt-10 size-20 border-4 border-card shadow-md">
            <AvatarFallback className="bg-primary text-xl font-semibold text-primary-foreground">{initialsOf(ctx?.full_name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold">{name}</h2>
              <Badge variant="secondary" className="capitalize">{ctx?.role || "Employee"}</Badge>
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
            { label: "Employee ID", value: ctx?.employee_id },
            { label: "Contact number", value: formatContactNumber(ctx?.cp_number) },
            { label: "Sex", value: ctx?.sex },
            { label: "Civil status", value: ctx?.civil_status },
            { label: "Email address", value: ctx?.email, wide: true },
            { label: "Home address", value: ctx?.address, wide: true },
          ]} />
        </Section>

        <Section icon={BriefcaseIcon} title="Employment">
          <InfoList items={[
            { label: "Position", value: ctx?.position },
            { label: "Employee type", value: ctx?.employee_type },
            { label: "Employment", value: [ctx?.employment_type, ctx?.employment_status].filter(Boolean).join(" · ") },
            { label: "Date hired", value: ctx?.date_hired },
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

        <Section icon={ShieldCheckIcon} title="Government contributions">
          <InfoList items={[
            { label: "SSS number", value: ctx?.sss_number },
            { label: "PhilHealth number", value: ctx?.philhealth_number },
            { label: "Pag-IBIG number", value: ctx?.pagibig_number },
            { label: "TIN", value: formatPiiForDisplay(ctx?.tin_number, DIGIT_FIELD_SPECS.tin_number.groups) },
          ]} />
        </Section>

        <Section icon={LandmarkIcon} title="Bank information">
          <InfoList items={[
            { label: "Bank name", value: ctx?.bank_name },
            { label: "Bank account number", value: ctx?.bank_account_number },
          ]} />
          <p className="mt-4 text-xs text-muted-foreground">Government numbers and bank details are set by HR for payroll. Contact HR to change them.</p>
        </Section>
      </div>
    </>
  );
}
