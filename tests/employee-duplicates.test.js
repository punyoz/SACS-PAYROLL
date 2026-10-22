/**
 * Scenario EM-11 (2026-10-22): a new employee with the same name AND date of
 * birth as someone on file (archived included) is flagged for HR to confirm;
 * the same name alone is not.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { findLikelyDuplicates } from "@/lib/employees/duplicates";

const user = (id, full_name, date_of_birth, extra = {}) => ({ id, email: `${id}@x.test`, user_metadata: { full_name, date_of_birth, employee_id: `E-${id}`, ...extra } });
const users = [
  user("a", "Maria Clara Santos", "1990-05-01"),
  user("b", "Maria Santos", "1991-02-02"),
  user("c", "José Rizal Jr.", "1985-06-19", { archived: true }),
];

describe("findLikelyDuplicates", () => {
  it("flags the same first + last name and birthday, ignoring the middle name", () => {
    expect(findLikelyDuplicates({ first_name: "Maria", last_name: "Santos", date_of_birth: "1990-05-01" }, users).map((m) => m.id)).toEqual(["a"]);
  });
  it("does not flag the same name with another birthday", () => {
    expect(findLikelyDuplicates({ first_name: "Maria", last_name: "Santos", date_of_birth: "1999-09-09" }, users)).toEqual([]);
  });
  it("finds an archived match (a re-hire), ignoring accents, case and suffix", () => {
    const [m] = findLikelyDuplicates({ first_name: "jose", last_name: "RIZAL", date_of_birth: "1985-06-19" }, users);
    expect(m).toMatchObject({ id: "c", archived: true });
  });
  it("matches a last name of more than one word (Dela Cruz), with or without a middle name", () => {
    const people = [user("d", "Juan Santos Dela Cruz", "1980-01-01"), user("e", "Juan Dela Cruz Jr.", "1980-01-01")];
    expect(findLikelyDuplicates({ first_name: "Juan", last_name: "Dela Cruz", date_of_birth: "1980-01-01" }, people).map((m) => m.id)).toEqual(["d", "e"]);
    expect(findLikelyDuplicates({ first_name: "Juan", last_name: "Cruz", date_of_birth: "1980-01-01" }, people).map((m) => m.id)).toEqual(["d", "e"]);
  });
  it("needs a birthday to compare", () => {
    expect(findLikelyDuplicates({ first_name: "Maria", last_name: "Santos", date_of_birth: "" }, users)).toEqual([]);
  });
  it("the create route asks before making a second account, and the form confirms", () => {
    expect(readFileSync("src/app/api/admin/employees/route.js", "utf8")).toMatch(/possible_duplicate[\s\S]*confirm_duplicate|confirm_duplicate[\s\S]*possible_duplicate/);
    expect(readFileSync("src/app/hr/employee-form-dialog.jsx", "utf8")).toContain("confirm_duplicate: true");
  });
});
