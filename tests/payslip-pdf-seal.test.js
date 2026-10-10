import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildPayslipPdf, jpegInfo } from "@/lib/payroll/payslip-pdf";

/**
 * The school seal on payslip PDFs (approved Oct 10, 2026): the JPEG at
 * public/brand/seal-payslip.jpg, embedded as it is. Without it the PDF is
 * exactly the text-only payslip it was before.
 */

const seal = readFileSync("public/brand/seal-payslip.jpg");
const details = {
  status: "final",
  payslip_no: "PS-202610-0001",
  pay_period: "October 1-15, 2026",
  employee: { name: "Maria Santos", id: "SACS-001", branch: "Antipolo", position: "Teacher I" },
  monthly: { half: "first", monthly_salary: 30000, semi_monthly_pay: 15000, second_half_label: "October 16-31, 2026" },
  net_pay: 15000,
};

describe("payslip PDF seal", () => {
  it("reads the seal file's size and colours", () => {
    expect(jpegInfo(seal)).toEqual({ width: 300, height: 300, components: 3 });
    expect(jpegInfo(Buffer.from("not a jpeg"))).toBeNull();
    expect(jpegInfo(null)).toBeNull();
  });

  it("embeds the seal as an image beside the school name", () => {
    const pdf = buildPayslipPdf(details, { seal });
    const text = pdf.toString("latin1");
    expect(text).toContain("/XObject << /Im1 7 0 R >>");
    expect(text).toContain("/Subtype /Image /Width 300 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode");
    expect(text).toMatch(/q 40 0 0 40 48 \d+ cm \/Im1 Do Q/);
    expect(pdf.includes(seal)).toBe(true);
    // The cross-reference table lists all 7 objects.
    expect(text).toMatch(/xref\n0 8\n/);
  });

  it("without a seal (or with an unusable file) the PDF is the text-only one", () => {
    const plain = buildPayslipPdf(details);
    expect(plain.toString("latin1")).not.toContain("/Im1");
    expect(buildPayslipPdf(details, { seal: Buffer.from("png?") }).equals(plain)).toBe(true);
  });
});
