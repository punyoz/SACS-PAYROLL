/**
 * Loans (alpha test B4): the status filter (with Pending) and the faster
 * chunked reads keep the same rows in the same order.
 */
import { describe, it, expect } from "vitest";
import { LOAN_STATUS_LABELS, loanMatchesStatus } from "@/lib/payroll/loan-status";
import { fetchAllIn, IN_CHUNK_CONCURRENCY } from "@/lib/supabase/fetch-all";

const LOANS = [
  { id: 1, status: "active", approval_status: "pending", loan_type: "sss" },
  { id: 2, status: "active", approval_status: "approved", loan_type: "sss" },
  { id: 3, status: "active", approval_status: null, loan_type: "cash_advance" },
  { id: 4, status: "suspended", approval_status: "approved", loan_type: "pagibig" },
  { id: 5, status: "paid", approval_status: "approved", loan_type: "sss" },
  { id: 6, status: "active", approval_status: "rejected", loan_type: "school" },
  { id: 7, status: "active", approval_status: "approved", loan_type: "subsidy_advance" },
];
const ids = (status) => LOANS.filter((l) => loanMatchesStatus(l, status)).map((l) => l.id);

describe("loan status filter", () => {
  it("offers Pending, Active, Suspended, Paid, Rejected, Subsidy advances, Open and All", () => {
    expect(Object.keys(LOAN_STATUS_LABELS)).toEqual(["all", "open", "pending", "active", "suspended", "paid", "rejected", "subsidy"]);
  });
  it("puts each loan where it belongs", () => {
    expect(ids("pending")).toEqual([1]);
    expect(ids("active")).toEqual([2, 3, 7]);
    expect(ids("suspended")).toEqual([4]);
    expect(ids("paid")).toEqual([5]);
    expect(ids("rejected")).toEqual([6]);
    expect(ids("subsidy")).toEqual([7]);
    expect(ids("open")).toEqual([1, 2, 3, 4, 7]);
    expect(ids("all")).toHaveLength(7);
  });
});

describe("fetchAllIn reads chunks at the same time, rows in the same order", () => {
  it("1,210 ids: 13 chunks, at most IN_CHUNK_CONCURRENCY at once, order kept", async () => {
    let running = 0;
    let peak = 0;
    const values = Array.from({ length: 1210 }, (_, i) => i);
    const build = () => ({
      in: (_col, part) => ({
        range: async () => {
          running += 1; peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 5 + (part[0] % 7)));
          running -= 1;
          return { data: part.map((v) => ({ v })), error: null };
        },
      }),
    });
    const result = await fetchAllIn(build, "id", values);
    expect(result.error).toBeNull();
    expect(result.data.map((r) => r.v)).toEqual(values);
    expect(peak).toBeLessThanOrEqual(IN_CHUNK_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
});
