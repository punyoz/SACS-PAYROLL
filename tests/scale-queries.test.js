/**
 * Scale test 2026-10-22 (SCENARIOS.md SC-*): long id lists go in chunks (a
 * long .in() list made the URL too long and the request failed), and every
 * matching row is read, never just PostgREST's first 1,000.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { IN_CHUNK_SIZE, chunkValues, fetchAllIn, forEachInChunk } from "@/lib/supabase/fetch-all";

function fakeQuery(rows, calls) {
  const state = { filter: null, from: 0, to: Infinity };
  const builder = {
    in(column, values) { calls.push(values.length); state.filter = (row) => values.includes(row[column]); return builder; },
    range(from, to) { state.from = from; state.to = to; return builder; },
    then(resolve) {
      const hit = rows.filter((row) => !state.filter || state.filter(row));
      // PostgREST's own cap: at most 1,000 rows per request.
      return Promise.resolve({ data: hit.slice(state.from, Math.min(state.to + 1, state.from + 1000)), error: null }).then(resolve);
    },
  };
  return builder;
}

describe("chunked .in() reads", () => {
  it("splits ids into URL-safe chunks, dropping blanks and repeats", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const chunks = chunkValues([...ids, "", null, "id-1"]);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(IN_CHUNK_SIZE).toBe(100);
  });

  it("reads every row of every chunk, paging past 1,000 rows", async () => {
    const ids = Array.from({ length: 330 }, (_, i) => `e${i}`);
    const rows = ids.flatMap((id) => Array.from({ length: 5 }, (_, d) => ({ employee_id: id, day: d })));
    const calls = [];
    const result = await fetchAllIn(() => fakeQuery(rows, calls), "employee_id", ids);
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1650);
    expect(Math.max(...calls)).toBeLessThanOrEqual(IN_CHUNK_SIZE);
  });

  it("runs a write once per chunk and stops at the first error", async () => {
    const seen = [];
    const ok = await forEachInChunk(Array.from({ length: 210 }, (_, i) => i + 1), async (part) => { seen.push(part.length); return { error: null }; });
    expect(ok.error).toBeNull();
    expect(seen).toEqual([100, 100, 10]);
    const failed = await forEachInChunk([1, 2, 3], async () => ({ error: { message: "nope" } }));
    expect(failed.error.message).toBe("nope");
  });
});

describe("no route passes a whole id list in one .in() any more", () => {
  const files = [];
  const walk = (dir) => readdirSync(dir).forEach((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.js$/.test(name)) files.push(path);
  });
  walk("src/app/api");
  walk("src/lib");

  it("id lists are chunked (fetchAllIn / chunkValues / forEachInChunk)", () => {
    const risky = /\.in\("(id|employee_id|entry_id|run_id|log_id|loan_id|grant_id)",\s*(ids|userIds|employeeIds|candidateIds|openIds|borrowers|withSubsidy|runIds|balanceIds|correctedIds|grantIds)(\.slice\([^)]*\))?\)/;
    const offenders = files.filter((file) => !/fetch-all.js$/.test(file) && risky.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("leave requests are read in full (paged), with the period overlap for payroll", () => {
    const store = readFileSync("src/lib/leave-requests/store.js", "utf8");
    expect(store).toContain("await fetchAllRows(build)");
    const payroll = readFileSync("src/app/api/accountant/payroll/route.js", "utf8");
    expect(payroll).toContain('readAllLeaveRequests({ status: "approved", overlapFrom: periodStart, overlapTo: periodEnd })');
  });

  it("the payroll GET reads a scope, never every payslip ever made", () => {
    const payroll = readFileSync("src/app/api/accountant/payroll/route.js", "utf8");
    expect(payroll).not.toMatch(/readPayrollEntries\(supabase\)/);
    expect(payroll).toContain("historyLabels(historyParam)");
  });
});
