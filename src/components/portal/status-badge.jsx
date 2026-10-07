import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { normalizeAttendanceStatus } from "@/lib/portal/format";

/**
 * One badge style for every status in the portals: a 12% tint of the tone
 * with text in the tone, a dot for colour-blind users' shape cue, and the
 * label always spelled out (colour is never the only signal).
 */
const TONE_CLASS = {
  success: "border-success/25 bg-success/12 text-success",
  warning: "border-warning/25 bg-warning/12 text-warning",
  danger: "border-destructive/25 bg-destructive/10 text-destructive",
  info: "border-info/25 bg-info/10 text-info",
  gold: "border-brand-gold/40 bg-brand-gold/15 text-gold-text",
  muted: "border-border bg-muted text-muted-foreground",
};

export function StatusBadge({ tone = "muted", children, className, dot = true }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", TONE_CLASS[tone] || TONE_CLASS.muted, className)}>
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </Badge>
  );
}

/* The legacy grouping of ATTENDANCE_STATUS_TONE (public/legacy/js/app.js):
   green On Time / Early Bird, gold Late / Undertime, flame Half Day, red
   Absent, gray Incomplete / awaiting review, gold Holiday. Corrected and On
   Leave use a muted blue (the legacy deep green was too close to On Time to
   tell apart on the calendar). */
const ATTENDANCE_TONE = {
  "On Time": "success",
  "Early Bird": "success",
  Late: "gold",
  Undertime: "gold",
  "Half Day": "warning",
  Absent: "danger",
  Incomplete: "muted",
  "Pending Correction": "muted",
  Corrected: "info",
  "On Leave": "info",
  Holiday: "gold",
};

export function AttendanceBadge({ status, className }) {
  const label = normalizeAttendanceStatus(status);
  if (label === "—") return <StatusBadge tone="muted" className={className}>No data</StatusBadge>;
  return <StatusBadge tone={ATTENDANCE_TONE[label] || "muted"} className={className}>{label}</StatusBadge>;
}

const REQUEST_TONE = {
  approved: "success",
  paid: "success",
  issued: "success",
  pending: "gold",
  rejected: "danger",
  cancelled: "danger",
};

/** Leave / request / payslip state: "approved", "pending", "rejected", ... */
export function RequestStatusBadge({ status, className }) {
  const key = String(status || "pending").toLowerCase();
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return <StatusBadge tone={REQUEST_TONE[key] || "muted"} className={className}>{label}</StatusBadge>;
}
