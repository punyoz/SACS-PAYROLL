/**
 * The portals' own UI audit trail (logAuditMovement, public/legacy/js/
 * admin.js): page opens, exports and manual RFID scans are posted to
 * /api/admin/audit-logs. Never blocks or fails the action it records.
 */
export function logAuditMovement(payload) {
  fetch("/api/admin/audit-logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
