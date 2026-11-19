import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildPayslipPdf, jpegInfo } from "@/lib/payroll/payslip-pdf";
import { readPdf } from "./helpers/pdf-read";

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

  it("embeds the seal as an image beside the school name", async () => {
    const pdf = Buffer.from(await buildPayslipPdf(details, { seal }));
    const text = pdf.toString("latin1");
    // The JPEG is embedded as it is (DCTDecode), 300 x 300, drawn once on the page (2026-11-19: by the shared template).
    expect(text).toMatch(/\/Subtype \/Image/);
    expect(text).toMatch(/\/Width 300/);
    expect(text).toMatch(/\/Height 300/);
    expect(text).toMatch(/\/Filter \/DCTDecode/);
    expect(pdf.includes(seal)).toBe(true);
    const { pages } = await readPdf(pdf);
    expect(pages[0].images).toBe(1);
  });

  it("without a seal (or with an unusable file) the PDF is the text-only one", async () => {
    const plain = await readPdf(await buildPayslipPdf(details));
    expect(plain.pages[0].images).toBe(0);
    const unusable = await readPdf(await buildPayslipPdf(details, { seal: Buffer.from("png?") }));
    expect(unusable.pages[0].images).toBe(0);
    expect(unusable.text).toBe(plain.text);
  });
});
