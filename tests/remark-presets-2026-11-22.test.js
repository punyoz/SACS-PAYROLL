// Part H (2026-11-22): preset remarks. The server builds the text from the
// preset (never trusts the client's), refuses the wrong / deactivated ones,
// and counts reasons from the audit entries (one per decided item).
import { describe, expect, it } from "vitest";
import { countRemarkReasons, remarkClient, resolveRemark } from "@/lib/remarks/presets";

const PRESETS = {
  "reject.leave.filed_late": { code: "reject.leave.filed_late", decision: "reject", entity_type: "leave_request", label: "Filed late", active: true },
  "approve.as_requested": { code: "approve.as_requested", decision: "approve", entity_type: "*", label: "Approved as requested", active: true },
  "reject.old": { code: "reject.old", decision: "reject", entity_type: "*", label: "Old reason", active: false },
};
const db = { from: () => ({ select: () => ({ eq: (_c, code) => ({ maybeSingle: async () => ({ data: PRESETS[code] || null, error: null }) }) }) }) };
const reject = (input, extra = {}) => resolveRemark(db, input, { decision: "reject", entityType: "leave_request", ...extra });

describe("resolveRemark", () => {
  it("a preset's text is its label, with the extra words after a colon", async () => {
    expect(await reject({ code: "reject.leave.filed_late" })).toEqual({ code: "reject.leave.filed_late", text: "Filed late" });
    expect(await reject({ code: "reject.leave.filed_late", extra: " came Friday " })).toEqual({ code: "reject.leave.filed_late", text: "Filed late: came Friday" });
  });
  it("a general (*) preset fits any type; another decision's or a deactivated one is refused", async () => {
    expect(await resolveRemark(db, { code: "approve.as_requested" }, { decision: "approve", entityType: "payroll_run" })).toMatchObject({ code: "approve.as_requested" });
    expect((await reject({ code: "approve.as_requested" })).error).toBe("That remark is not for this decision.");
    expect((await reject({ code: "reject.old" })).error).toBe("That remark is no longer offered. Choose another.");
    expect((await reject({ code: "nope" })).error).toBe("That remark is no longer offered. Choose another.");
  });
  it("Other needs words; a reason is required to reject, optional to approve", async () => {
    expect(await reject({ code: "other", extra: "Covered by the principal" })).toEqual({ code: "other", text: "Covered by the principal" });
    expect((await reject({ code: "other", extra: "x" })).error).toMatch(/at least 3 characters/);
    expect(await reject(null)).toMatchObject({ error: "Choose a remark (a reason is required).", missing: true });
    expect(await resolveRemark(db, null, { decision: "approve", entityType: "leave_request" })).toEqual({ code: null, text: "" });
  });
  it("an older caller's plain reason is kept as an Other remark (still counted)", async () => {
    expect(await reject(null, { fallbackText: "The dates clash with exams" })).toEqual({ code: "other", text: "The dates clash with exams" });
  });
  it("too long, or an unknown decision, is refused", async () => {
    expect((await reject({ code: "other", extra: "x".repeat(401) })).error).toMatch(/too long/);
    expect((await resolveRemark(db, { code: "other", extra: "fine words" }, { decision: "delete", entityType: "leave_request" })).error).toBe("Unknown decision.");
  });
});

describe("remarkClient", () => {
  it("carries the remark (UTF-8, base64) for the trigger; no header without a remark", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-key";
    const client = remarkClient({ code: "other", text: "₱ ñ remark" }, { decision: "reject", entityType: "leave_request", module: "leave", table: "leave_requests", ids: ["a"], ops: ["INSERT"], actor: { userId: "u", role: "hr", session: { full_name: "Hana" } } });
    const header = client.rest?.headers?.["x-sacs-remark"] ?? client.headers?.["x-sacs-remark"];
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(payload).toMatchObject({ code: "other", text: "₱ ñ remark", decision: "reject", entity_type: "leave_request", table: "leave_requests", ids: ["a"], ops: ["INSERT"], actor_name: "Hana" });
    const plain = remarkClient({ code: null, text: "" }, { decision: "approve", entityType: "leave_request", table: "leave_requests" });
    expect(plain.rest?.headers?.["x-sacs-remark"] ?? plain.headers?.["x-sacs-remark"]).toBeUndefined();
  });
});

describe("countRemarkReasons", () => {
  it("one count per audit entry, by decision, type and preset; Other grouped; a deactivated preset keeps its label", () => {
    const e = (action, entity_type, code, label, at) => ({ action, entity_type, created_at: at, metadata: { kind: "decision_remark", remark_code: code, preset_label: label, remark_text: label } });
    const rows = countRemarkReasons([
      e("reject", "leave_request", "reject.leave.filed_late", "Filed late", "2026-11-20T01:00:00Z"),
      e("reject", "leave_request", "reject.leave.filed_late", "Filed late", "2026-11-21T01:00:00Z"),
      e("reject", "payroll_run", "reject.leave.filed_late", "Filed late", "2026-11-21T02:00:00Z"),
      e("reject", "leave_request", "other", null, "2026-11-21T03:00:00Z"),
      e("reject", "leave_request", "other", null, "2026-11-21T04:00:00Z"),
      e("approve", "leave_request", "reject.old", "Old reason", "2026-11-19T00:00:00Z"),
    ]);
    expect(rows.map((r) => [r.decision, r.entity_type, r.label, r.count])).toEqual([
      ["reject", "leave_request", "Filed late", 2],
      ["reject", "leave_request", "Other (written)", 2],
      ["reject", "payroll_run", "Filed late", 1],
      ["approve", "leave_request", "Old reason", 1],
    ]);
    expect(rows[0].last_at).toBe("2026-11-21T01:00:00Z");
  });
});
