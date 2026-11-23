"use client";

/*
 * Part E step 4 (2026-11-23): what the system recommends for a leave request
 * (credits, filing time, calendar, staffing), and the branch Admin's check.
 * A recommendation only: HR decides.
 */
export function SystemRecommendation({ rec, compact = false }) {
  if (!rec) return null;
  return (
    <div className="space-y-0.5 text-xs" data-testid="system-recommendation">
      <p className="font-medium">System: {rec.label}</p>
      {!compact ? rec.reasons.map((r) => <p key={r} className="text-muted-foreground">✓ {r}</p>) : null}
      {rec.warnings.map((w) => <p key={w} className="text-warning">! {w}</p>)}
      {rec.admin_note ? <p className="text-muted-foreground">{rec.admin_noted_by_name || "Admin"}: {rec.admin_note}</p> : null}
    </div>
  );
}
