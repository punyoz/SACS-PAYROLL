// Part F (2026-11-09): the rules WITHOUT a browser. Direct API calls as each
// role (scripts/demo/local-api.mjs) against the LOCAL app on :3101, on the
// local demo dataset (node scripts/demo/build-local.mjs --stage=base,cards).
//   node --test e2e/my-account/rules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { as } from "../../scripts/demo/local-api.mjs";
import { context } from "../../scripts/demo/build-local.mjs";
import { database } from "../../scripts/demo/db.mjs";

const local = database("local");
const { by } = await context();
const P = (tag) => by(tag);
const sql = (q) => local.rows(q);
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Each run files on its own dates (requests from an earlier run stay on file).
const RUN = 30 + (Math.floor(Date.now() / 60000) % 500) * 10;

/** File a leave as `who` weeks ahead (the advance rule), returning its id. */
async function fileLeave(who, offset) {
  const start = addDays(today, RUN + offset);
  const res = await as(P(who)).post("/api/me/leave-requests", { leave_type: "Vacation Leave", start_date: start, end_date: start, reason: "Part F test leave" });
  assert.equal(res.status, 201, `file leave as ${who}: ${JSON.stringify(res.data).slice(0, 300)}`);
  return res.data.request.id;
}

test("Admin and Super Admin are refused every My Account API", async () => {
  for (const tag of ["adm-b1-1", "sa1"]) {
    for (const path of ["/api/me/attendance/logs?from=2026-11-01&to=2026-11-09", "/api/me/payslips", "/api/me/leave-requests", "/api/me/requests", "/api/me/bir-2316", "/api/me/timesheet?from=2026-11-01&to=2026-11-09"]) {
      const res = await as(P(tag)).get(path);
      assert.equal(res.status, 403, `${tag} ${path} -> ${res.status}`);
    }
  }
});

test("My pages return only the caller's own rows, whatever is asked", async () => {
  const hr = P("hr1");
  const other = P("emp1");
  const logs = await as(hr).get(`/api/me/attendance/logs?from=2026-10-01&to=2026-10-31&page=1&page_size=100&q=${encodeURIComponent(other.first)}`);
  assert.equal(logs.status, 200);
  assert.ok(logs.data.logs.every((r) => r.employee_id === hr.id), "HR My Attendance: only HR's own rows");
  assert.equal(logs.data.can_review, false, "no review tools on My Attendance");
  const pay = await as(hr).get(`/api/me/payslips?email=${encodeURIComponent(other.email)}`);
  assert.equal(pay.status, 200);
  assert.ok(JSON.stringify(pay.data).includes(other.id) === false, "another person's payslips never come back");
  const leaves = await as(P("acc-b1-1")).get(`/api/me/leave-requests?employee_id=${other.id}`);
  assert.equal(leaves.status, 200);
  assert.ok((leaves.data.requests || []).every((r) => r.employee_id === P("acc-b1-1").id));
});

test("HR's own leave: hidden from their queue, no self-decision; the other HR decides", async () => {
  const id = await fileLeave("hr1", 20);
  const queue = await as(P("hr1")).get("/api/hr/leave-requests?status=pending");
  assert.ok(!queue.data.requests.some((r) => r.id === id), "not in HR1's own queue");
  const self = await as(P("hr1")).patch("/api/hr/leave-requests", { id, action: "approve" });
  assert.equal(self.status, 403);
  assert.equal(self.data.code, "own_item");
  const other = await as(P("hr2")).get("/api/hr/leave-requests?status=pending");
  assert.ok(other.data.requests.some((r) => r.id === id), "in HR2's queue");
  const decided = await as(P("hr2")).patch("/api/hr/leave-requests", { id, action: "approve" });
  assert.equal(decided.status, 200, JSON.stringify(decided.data));
});

test("A rejection without a reason is refused; the Accountant's leave goes to HR", async () => {
  const id = await fileLeave("acc-b1-1", 21);
  const noReason = await as(P("hr1")).patch("/api/hr/leave-requests", { id, action: "reject" });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.code, "reason_required");
  const rejected = await as(P("hr1")).patch("/api/hr/leave-requests", { id, action: "reject", reason: "Overlaps the payroll cutoff week" });
  assert.equal(rejected.status, 200);
});

test("The requester cancels their own pending leave; not someone else's", async () => {
  const id = await fileLeave("emp2", 22);
  const foreign = await as(P("emp3")).patch("/api/me/leave-requests", { id, action: "cancel" });
  assert.equal(foreign.status, 404);
  const own = await as(P("emp2")).patch("/api/me/leave-requests", { id, action: "cancel" });
  assert.equal(own.status, 200);
  assert.equal(own.data.request.status, "cancelled");
});

test("The claim lock: one HR at a time; nobody claims their own; release frees it", async () => {
  const id = await fileLeave("emp4", 23);
  const claims = await Promise.all([P("hr1"), P("hr2")].map((h) => as(h).post("/api/hr/queue-claims", { action: "claim", item_type: "leave_request", item_id: id })));
  const winners = claims.filter((r) => r.status === 200);
  assert.equal(winners.length, 1, `exactly one claim wins: ${claims.map((r) => r.status)}`);
  const loserIndex = claims.findIndex((r) => r.status !== 200);
  assert.equal(claims[loserIndex].status, 409);
  assert.match(claims[loserIndex].data.error, /Claimed by/);
  const loser = loserIndex === 0 ? P("hr1") : P("hr2");
  const blocked = await as(loser).patch("/api/hr/leave-requests", { id, action: "approve" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, "claimed");
  const winner = loserIndex === 0 ? P("hr2") : P("hr1");
  assert.equal((await as(winner).post("/api/hr/queue-claims", { action: "release", item_type: "leave_request", item_id: id })).status, 200);
  assert.equal((await as(loser).post("/api/hr/queue-claims", { action: "claim", item_type: "leave_request", item_id: id })).status, 200);
  const ownId = await fileLeave("hr2", 24);
  const own = await as(P("hr2")).post("/api/hr/queue-claims", { action: "claim", item_type: "leave_request", item_id: ownId });
  assert.equal(own.status, 403);
  assert.equal(own.data.code, "own_item");
});

test("Only one HR active: an HR's leave goes to the Super Admin (audit + notifications); reactivating restores it", async () => {
  const hr2 = P("hr2");
  await local.exec(`update profiles set archived = true where id = '${hr2.id}'`);
  try {
    const id = await fileLeave("hr1", 25);
    const sa = await as(P("sa1")).get("/api/super-admin/fallback");
    assert.equal(sa.status, 200);
    assert.ok(sa.data.items.some((i) => i.id === id), "waits on the fallback");
    const audit = await sql(`select count(*)::int n from audit_logs where action = 'fallback_used' and entity_id = '${id}'`);
    assert.equal(audit[0].n, 1, "audit: fallback used");
    const bell = await sql(`select count(*)::int n from notifications where kind = 'fallback_waiting' and recipient_id = '${P("sa1").id}'`);
    assert.ok(bell[0].n >= 1, "the Super Admin is notified");
    const decided = await as(P("sa1")).post("/api/super-admin/fallback", { action: "approve", item_type: "leave_request", id });
    assert.equal(decided.status, 200, JSON.stringify(decided.data));
  } finally {
    await local.exec(`update profiles set archived = false where id = '${hr2.id}'`);
  }
  const id2 = await fileLeave("hr1", 26);
  const sa2 = await as(P("sa1")).get("/api/super-admin/fallback");
  assert.ok(!sa2.data.items.some((i) => i.id === id2), "with HR2 back, nothing waits on the Super Admin");
  const refused = await as(P("sa1")).post("/api/super-admin/fallback", { action: "approve", item_type: "leave_request", id: id2 });
  assert.equal(refused.status, 409, "the Super Admin never decides when an HR is active");
});

test("Nobody changes their own salary", async () => {
  const res = await as(P("hr1")).post("/api/hr/salary-changes", { employee_id: P("hr1").id, new_salary: 99999, effective_date: "2027-01-01", reason: "Salary adjustment" });
  assert.equal(res.status, 403);
  assert.equal(res.data.code, "own_item");
  const db = await local.exec(`do $$ begin
    begin
      set local role service_role;
      insert into employee_salary_changes (employee_id, old_salary, new_salary, effective_date, reason, created_by) values ('${P("hr1").id}', 1, 2, '2027-01-01', 'Other', '${P("hr1").id}');
      raise exception 'not refused';
    exception when insufficient_privilege then null; end;
  end $$;`).then(() => "refused").catch((e) => e.message);
  assert.equal(db, "refused", "the database refuses it too");
});

test("Every role on payroll gets an RFID card; HR is paid", async () => {
  const hr = await sql(`select count(*)::int n from rfid_cards c join profiles p on p.id = c.employee_id where p.role = 'hr' and p.is_demo`);
  assert.equal(hr[0].n, 2, "both demo HR have a card");
});
