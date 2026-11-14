"use client";

import { AlertTriangleIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { dateLabel } from "@/lib/portal/payroll-preview";
import { TESTING_MODE_BANNER } from "@/lib/payroll/window-enforcement";
import { InfoTip } from "@/components/portal/info-tip";

/**
 * The red "Testing mode" banner (src/lib/payroll/window-enforcement.js):
 * shown on Process Payroll, HR Payroll Approval and the Super Admin's System
 * Configuration while processing window enforcement is OFF. Nothing renders
 * while it is ON.
 * @param {{ enforcement?: { testing_mode?: boolean, enforced?: boolean, expires_on?: string|null } | null, detail?: string }} props
 */
export function TestingModeBanner({ enforcement, detail = "", compact = false }) {
  const off = Boolean(enforcement && (enforcement.testing_mode === true || enforcement.enforced === false));
  if (!off) return null;
  // compact (Process Payroll, 2026-11-14): one line, the rest behind ⓘ.
  if (compact) {
    return (
      <Alert className="border-destructive/40 bg-destructive/5" role="alert" data-testid="testing-mode-banner">
        <AlertTriangleIcon className="text-destructive" aria-hidden="true" />
        <AlertDescription>
          <p className="flex items-center gap-1"><strong className="text-destructive">{TESTING_MODE_BANNER}</strong>
            <InfoTip label="About testing mode">
              Payroll can be processed for any cutoff on any date. Payslips and runs made now are marked &quot;created in testing mode&quot;.
              {enforcement.expires_on ? ` Turns back ON automatically on ${dateLabel(enforcement.expires_on)}.` : ""}
              {detail ? ` ${detail}` : ""}
            </InfoTip>
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert className="border-destructive/40 bg-destructive/5" role="alert" data-testid="testing-mode-banner">
      <AlertTriangleIcon className="text-destructive" aria-hidden="true" />
      <AlertDescription>
        <p><strong className="text-destructive">{TESTING_MODE_BANNER}</strong></p>
        <p className="text-xs">
          Payroll can be processed for any cutoff on any date. Payslips and runs made now are marked &quot;created in testing mode&quot;.
          {enforcement.expires_on ? ` Turns back ON automatically on ${dateLabel(enforcement.expires_on)}.` : ""}
          {detail ? ` ${detail}` : ""}
        </p>
      </AlertDescription>
    </Alert>
  );
}
