"use client";

import * as React from "react";
import { HeartHandshakeIcon, LandmarkIcon, PencilIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoList } from "@/components/portal/info-list";
import { useAccountDialogs } from "@/components/portal/app-shell";
import { usePortalSession } from "@/components/portal/session";
import { apiFetch } from "@/lib/portal/api";
import { DIGIT_FIELD_SPECS, formatContactNumber, formatPiiForDisplay, initialsOf } from "@/lib/portal/format";

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

export function StaffProfilePage({ roleLabel, showPosition = false, showBank = false, employeeIdLabel = false }) {
  const { ctx, updateContext } = usePortalSession();
  const { open } = useAccountDialogs();

  React.useEffect(() => {
    let cancelled = false;
    apiFetch("/api/legacy-auth/update-profile", { method: "GET", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const stored = data?.profile;
        if (cancelled || !stored) return;
        const patch = {};
        REFRESH_KEYS.forEach((key) => {
          if (key === "staff_id") { if (stored.staff_id) patch.staff_id = stored.staff_id; } else patch[key] = stored[key] || "";
        });
        updateContext(patch);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [updateContext]);

  const name = ctx?.full_name || `${roleLabel} User`;

  return (
    <>
      <Card className="relative gap-0 overflow-hidden border-0 py-0 shadow-md">
        <div className="h-24 bg-gradient-to-br from-brand-green to-brand-green-dark" aria-hidden="true" />
        <div aria-hidden="true" className="h-1 bg-brand-gold" />
        <CardContent className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-end">
          <Avatar className="-mt-10 size-20 border-4 border-card shadow-md">
            <AvatarFallback className="bg-primary text-xl font-semibold text-primary-foreground">{initialsOf(ctx?.full_name, roleLabel.slice(0, 2).toUpperCase())}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold">{name}</h2>
              <Badge variant="secondary">{roleLabel}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{ctx?.position || ctx?.employee_type || roleLabel} · Shepherd Angels Christian School</p>
          </div>
          <Button variant="outline" onClick={() => open("profile")}><PencilIcon aria-hidden="true" />Edit account</Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section icon={UserRoundIcon} title="Personal information">
          <InfoList items={[
            { label: "Full name", value: ctx?.full_name },
            // Staff portals carry a STAFF-### ID; the Accountant has an employee ID.
            employeeIdLabel ? { label: "Employee ID", value: ctx?.employee_id } : { label: "ID", value: ctx?.staff_id },
            ...(showPosition ? [{ label: "Position", value: ctx?.position }, { label: "Employee type", value: ctx?.employee_type }] : []),
            { label: "Email address", value: ctx?.email, wide: true },
            ...(employeeIdLabel ? [] : [{ label: "Account role", value: ctx?.role }]),
            { label: "Contact number", value: formatContactNumber(ctx?.cp_number) },
            { label: "Home address", value: ctx?.address, wide: true },
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
        {showBank ? (
          <Section icon={LandmarkIcon} title="Bank information">
            <InfoList items={[
              { label: "Bank name", value: ctx?.bank_name },
              { label: "Bank account number", value: ctx?.bank_account_number },
            ]} />
          </Section>
        ) : null}
      </div>
    </>
  );
}
