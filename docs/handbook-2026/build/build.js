// Builds the Employee Handbook .docx from handbook-source.md (a small markdown subset).
// Usage: node build.js <source.md> <out.docx>
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, Header, Footer, PageNumber, TableOfContents, LevelFormat,
  TabStopType, PageBreak, VerticalAlign,
} = require("docx");

const [, , SRC, OUT] = process.argv;
const LEGAL = "Shepherd Angels Christian School of Antipolo, Inc.";
const FONT = "Arial";
const W = 9026; // A4 width 11906 − 2 × 1440 margins
const lines = fs.readFileSync(SRC, "utf8").replace(/\r/g, "").split("\n");

// ── inline: **bold** and [TO CONFIRM …] markers ──────────────────────────────
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\[TO CONFIRM[^\]]*\])/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const t = m[0];
    if (t.startsWith("**")) out.push(new TextRun({ text: t.slice(2, -2), bold: true, ...base }));
    else out.push(new TextRun({ text: t, bold: true, highlight: "yellow", ...base }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out;
}

const P = (text, opts = {}) => new Paragraph({ children: runs(text, opts.run || {}), spacing: { after: 120, line: 276 }, ...opts.para });
const border = { style: BorderStyle.SINGLE, size: 4, color: "808080" };
const cellBorders = { top: border, bottom: border, left: border, right: border };

function table(rows) {
  const n = rows[0].length;
  // column widths by the longest text in each column (min 12 %)
  const len = Array.from({ length: n }, (_, c) => Math.max(...rows.map((r) => (r[c] || "").length)));
  const total = len.reduce((a, b) => a + b, 0) || 1;
  let widths = len.map((l) => Math.max(0.18, l / total));
  const s = widths.reduce((a, b) => a + b, 0);
  widths = widths.map((w) => Math.floor((w / s) * W));
  widths[n - 1] += W - widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: widths,
    rows: rows.map((r, i) => new TableRow({
      tableHeader: i === 0,
      cantSplit: true,
      children: r.map((c, j) => new TableCell({
        width: { size: widths[j], type: WidthType.DXA },
        borders: cellBorders,
        verticalAlign: VerticalAlign.CENTER,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        shading: i === 0 ? { type: ShadingType.CLEAR, color: "auto", fill: "D9E2F3" } : undefined,
        children: [new Paragraph({ children: runs(c, i === 0 ? { bold: true, size: 20 } : { size: 20 }) })],
      })),
    })),
  });
}

const callout = (text) => new Paragraph({
  children: runs(text, { size: 21 }),
  shading: { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: "2F5496", space: 8 } },
  indent: { left: 200, right: 200 },
  spacing: { before: 80, after: 160, line: 276 },
});

const field = (label) => new Paragraph({
  tabStops: [{ type: TabStopType.RIGHT, position: W, leader: "underscore" }],
  spacing: { before: 200, after: 80 },
  children: [new TextRun({ text: `${label}\t` })],
});
const blankLines = (n) => Array.from({ length: n }, () => field(""));
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });
const center = (text, size, bold = false, after = 120) => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after }, children: runs(text, { size, bold }) });

// ── fixed blocks ────────────────────────────────────────────────────────────
function cover() {
  return [
    new Paragraph({ spacing: { before: 2400 } }),
    center("SHEPHERD ANGELS CHRISTIAN SCHOOL", 32, true, 60),
    center("OF ANTIPOLO, INC.", 32, true, 240),
    center("Antipolo City, Rizal", 24, false, 1200),
    center("EMPLOYEE HANDBOOK", 56, true, 240),
    center("2026 Edition", 32, false, 1600),
    center("Main · Pinugay · Robinson · Spring Valley", 22, false, 2000),
    center("Draft for review. Items marked [TO CONFIRM] are waiting for the School's decision.", 18),
    center("Prepared from the School's payroll and attendance system as of 26 November 2026.", 18),
  ];
}

function ackBody(title) {
  return [
    center(title, 28, true, 240),
    P("Please read this handbook, sign this form and give it to HR. Keep the handbook for your reference."),
    field("Employee name:"),
    field("Employee ID and branch:"),
    P(""),
    P(`I acknowledge that I received a copy of the Employee Handbook (2026 Edition) of ${LEAGAL_FIX()} I have read it, I understand it, and I agree to follow its policies and procedures. I had the chance to ask questions about it.`),
    P("I understand that the handbook is a guide to School policy and is not an employment contract; that my appointment or contract and the laws of the Philippines prevail where they differ; and that the School may change the handbook in writing, with notice to employees."),
    P("I understand that my attendance is recorded by RFID taps, that I must never tap for another person, and that I may question any payslip in writing within the period stated in the handbook."),
    field("Employee's signature:"),
    field("Date:"),
    field("Received by (HR):"),
    field("Date received:"),
  ];
}
function LEAGAL_FIX() { return LEGAL; }

const APPENDIX = {
  "!APPENDIX_A": () => [
    new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun("Appendix A. Sexual and Gender-Based Harassment Complaint Form")] }),
    P("For complaints under RA 7877 and RA 11313. Give this form to the Committee on Decorum and Investigation (CODI) [TO CONFIRM members]. Your complaint is kept as confidential as the investigation allows. No one may be punished for complaining in good faith."),
    field("Your name:"), field("Position and branch:"), field("Date filed:"),
    field("Date(s) of the incident(s):"), field("Where it happened:"),
    field("Name of the person(s) complained of:"), field("Witnesses, if any:"),
    P("What happened (what was said or done, and what you did). Attach more pages if needed:", { para: { spacing: { before: 200 } } }),
    ...blankLines(7),
    P("I certify that the information above is true and complete to the best of my knowledge. I authorize the CODI to share it with the persons involved as the investigation requires.", { para: { spacing: { before: 200 } } }),
    field("Signature:"), field("Received by (CODI) and date:"),
  ],
  "!APPENDIX_B": () => [
    new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun("Appendix B. Grievance Form")] }),
    P("For work-related concerns under Section 9.2. Give this form to HR."),
    field("Your name:"), field("Position and branch:"), field("Date filed:"),
    field("Date(s) of the matter:"), field("Person(s) involved, if any:"),
    field("Step 1 done? (talked to my supervisor or school head on):"),
    P("Your concern, and what you would like the School to do:", { para: { spacing: { before: 200 } } }),
    ...blankLines(7),
    P("I certify that the information above is true and complete to the best of my knowledge.", { para: { spacing: { before: 200 } } }),
    field("Signature:"), field("Received by (HR) and date:"),
  ],
  "!APPENDIX_C": () => [
    new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun("Appendix C. Payslip Query Form")] }),
    P("Use this form to question a payslip within fifteen (15) days of receiving it [TO CONFIRM] (Section 5.20). Give it to HR or the Accountant of your branch."),
    field("Your name and employee ID:"), field("Branch:"),
    field("Payslip (pay period, e.g. November 16–30, 2026):"),
    field("Line(s) you are questioning (e.g. Undertime, SSS, Overtime):"),
    field("Amount shown on the payslip:"), field("Amount you believe is correct:"),
    P("Why (dates, times, approvals; attach copies if you have them):", { para: { spacing: { before: 200 } } }),
    ...blankLines(5),
    field("Signature and date:"),
    P("For the School:", { run: { bold: true }, para: { spacing: { before: 280 } } }),
    field("Received by and date:"), field("Finding:"), field("Correction filed? (Yes / No) and payslip where settled:"), field("Approved by (HR) and date:"),
  ],
  "!APPENDIX_D": () => [
    new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun("Appendix D. Acknowledgment of Receipt (File Copy)")] }),
    ...ackBody("ACKNOWLEDGMENT OF RECEIPT OF THE EMPLOYEE HANDBOOK").slice(1),
  ],
};

// ── parse the body ──────────────────────────────────────────────────────────
const body = [];
const coverChildren = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  const t = line.trim();
  if (!t) { i += 1; continue; }
  if (t === "!COVER") { coverChildren.push(...cover()); i += 1; continue; }
  if (t === "!ACK") { body.push(...ackBody("ACKNOWLEDGMENT OF RECEIPT OF THE EMPLOYEE HANDBOOK"), pageBreak()); i += 1; continue; }
  if (t === "!TOC") {
    body.push(center("TABLE OF CONTENTS", 28, true, 240));
    body.push(new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }));
    body.push(pageBreak());
    i += 1; continue;
  }
  if (APPENDIX[t]) { body.push(...APPENDIX[t]()); i += 1; continue; }
  if (t.startsWith("# ")) {
    const first = !body.some((b) => b && b.__h1);
    const p = new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: !first, children: [new TextRun(t.slice(2))] });
    p.__h1 = true;
    body.push(p); i += 1; continue;
  }
  if (t.startsWith("## ")) { body.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t.slice(3))] })); i += 1; continue; }
  if (t.startsWith("### ")) { body.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(t.slice(4))] })); i += 1; continue; }
  if (t.startsWith("|")) {
    const rows = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      i += 1;
    }
    body.push(table(rows), new Paragraph({ spacing: { after: 120 } }));
    continue;
  }
  if (t.startsWith("> ")) { body.push(callout(t.slice(2))); i += 1; continue; }
  if (t.startsWith("- ")) {
    body.push(new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 80, line: 276 }, children: runs(t.slice(2)) }));
    i += 1; continue;
  }
  body.push(P(t));
  i += 1;
}

const headingStyle = (id, name, size, before, after) => ({
  id, name, basedOn: "Normal", next: "Normal", quickFormat: true,
  run: { font: FONT, size, bold: true, color: "1F3864" },
  paragraph: { spacing: { before, after }, keepNext: true, keepLines: true, outlineLevel: Number(id.slice(-1)) - 1 },
});

const doc = new Document({
  creator: LEGAL,
  title: "Employee Handbook 2026",
  description: `Employee Handbook of ${LEGAL}, 2026 Edition (draft)`,
  features: { updateFields: true },
  styles: {
    default: { document: { run: { font: FONT, size: 22 } } },
    paragraphStyles: [
      headingStyle("Heading1", "Heading 1", 32, 0, 200),
      headingStyle("Heading2", "Heading 2", 26, 280, 120),
      headingStyle("Heading3", "Heading 3", 22, 200, 80),
    ],
  },
  numbering: {
    config: [{ reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }],
  },
  sections: [
    { properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children: coverChildren },
    {
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 }, pageNumbers: { start: 1 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "808080", space: 4 } }, children: [new TextRun({ text: LEGAL, size: 18, color: "404040" })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Employee Handbook, 2026 Edition  ·  Page ", size: 18 }), new TextRun({ children: [PageNumber.CURRENT], size: 18 }), new TextRun({ text: " of ", size: 18 }), new TextRun({ children: [PageNumber.TOTAL_PAGES_IN_SECTION], size: 18 })] })] }) },
      children: body,
    },
  ],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log("wrote", OUT, buf.length); });
