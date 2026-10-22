/**
 * Scenario SC-10 / HR-02 (2026-10-22): onboarding from a CSV file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { IMPORT_COLUMNS, importTemplateCsv, parseCsv, readImportFile, rowToEmployeeBody } from "@/lib/employees/csv-import";

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, commas and line breaks in quotes, CRLF and a BOM", () => {
    const text = "﻿a,b,c\r\n\"1, 2\",\"say \"\"hi\"\"\",\"two\nlines\"\r\n\r\nx,,z\n";
    expect(parseCsv(text)).toEqual([["a", "b", "c"], ["1, 2", "say \"hi\"", "two\nlines"], ["x", "", "z"]]);
  });
});

describe("readImportFile", () => {
  it("maps the template headers (labels or keys), reports missing and unknown columns, and keeps line numbers", () => {
    const header = importTemplateCsv().trim();
    const file = readImportFile(`${header},Notes\nMaria,,Santos\n`);
    expect(file.missing).toEqual([]);
    expect(file.unknown).toEqual(["Notes"]);
    expect(file.rows).toEqual([{ line: 2, values: expect.objectContaining({ first_name: "Maria", last_name: "Santos" }) }]);
    expect(readImportFile("first_name,last_name\nA,B\n").missing).toContain("Email");
  });
});

describe("rowToEmployeeBody", () => {
  const branches = [{ id: "b1", name: "Main Campus" }, { id: "b2", name: "SACS East Campus" }];
  it("finds the branch by name in any case, cleans the salary and defaults the role", () => {
    const { body, branch } = rowToEmployeeBody({ branch: "main campus", basic_salary: "₱18,500.00", first_name: "Ana" }, branches);
    expect(branch.id).toBe("b1");
    expect(body).toMatchObject({ branch_id: "b1", basic_salary: 18500, role: "employee", first_name: "Ana", employee_status: "Active" });
    expect(body.branch).toBeUndefined();
  });
  it("only ever makes an Employee or an Accountant", () => {
    expect(rowToEmployeeBody({ role: "Accountant", branch: "b2" }, branches).body.role).toBe("accountant");
    expect(rowToEmployeeBody({ role: "super_admin", branch: "b2" }, branches).body.role).toBe("employee");
    expect(rowToEmployeeBody({ branch: "Nowhere" }, branches).branch).toBeNull();
  });
});

describe("the import route", () => {
  const route = readFileSync("src/app/api/admin/employees/import/route.js", "utf8");
  it("needs HR's employee create permission, checks first, and creates through the Add employee route", () => {
    expect(route).toContain('requirePermission(request, "employee_information", "create")');
    expect(route).toContain("dry_run");
    expect(route).toMatch(/import \{ POST as createEmployee \} from "\.\.\/route"/);
    expect(route).toContain("findLikelyDuplicates(record, users)");
  });
  it("the template has every required field of the form", () => {
    const keys = IMPORT_COLUMNS.map(([key]) => key);
    ["first_name", "last_name", "email", "branch", "employee_type", "position", "date_hired", "basic_salary", "date_of_birth", "emergency_contact_number"]
      .forEach((key) => expect(keys).toContain(key));
  });
});
