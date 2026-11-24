// The defense data plan (requested 2026-11-24): every account on payroll, Oct 1 to today, generated
// through the app's own routes and database functions (scripts/demo/period.mjs). This file holds the
// people's records and the days that are not ordinary; every number on a payslip is the app's.
//
// Government numbers are clearly fictional (99-prefixed) but in the right format. No password here.

export const FROM = "2026-10-01";
export const PERIODS = [
  { label: "October 1-15, 2026", start: "2026-10-01", end: "2026-10-15", final: true },
  { label: "October 16-31, 2026", start: "2026-10-16", end: "2026-10-31", final: true },
  { label: "November 1-15, 2026", start: "2026-11-01", end: "2026-11-15", final: true },
  { label: "November 16-30, 2026", start: "2026-11-16", end: "2026-11-30", final: false },
];
export const DEMO_NOTE = "Demo amount, pending policy manual";
export const PERFECT_ATTENDANCE = 500;
export const EARLY_BIRD = 300;
export const MAKEUP_DAY = { date: "2026-11-21", start: "08:00", end: "12:00", reason: "Make-up classes for Nov 20 (no classes: Typhoon Yolanda)" };

/**
 * Who is who. `match` finds the account on live (employee ID, else full name + role); everything else is the
 * complete record the account gets. `rename` only for the three test-looking names (owner's yes).
 */
export const PEOPLE = [
  { key: "anjo", match: { code: "SACS-006" }, cp: "09171230006", address: "Blk 4 Lot 12, Mayamot, Antipolo City, Rizal",
    emergency: ["Liza Saraga", "Parent", "09171239006"], separation: { on: "2026-10-21", reason: "Resigned", note: "Resignation letter received Oct 7; last day Oct 21." } },
  { key: "joanna", match: { code: "SACS-ACCT-001" }, rename: { first: "Joanna", middle: "Reyes", last: "Marquez" }, cp: "09171230101",
    address: "12 Sumulong Hwy, Antipolo City, Rizal", emergency: ["Mark Marquez", "Spouse", "09171239101"] },
  { key: "reinjelyn", match: { code: "SACS-043" }, cp: "09171230043", address: "88 Marcos Hwy, Mambugan, Antipolo City, Rizal",
    emergency: ["Rosa Garaña", "Parent", "09171239043"] },
  { key: "andrea", match: { code: "SACS-EMP-001" }, rename: { first: "Andrea", middle: "Lopez", last: "Villanueva" }, cp: "09171230201",
    address: "5 Taktak Rd, Antipolo City, Rizal", emergency: ["Paolo Villanueva", "Spouse", "09171239201"] },
  { key: "ehd", match: { code: "SACS-001" }, cp: "09171230001", address: "21 Circumferential Rd, San Roque, Antipolo City, Rizal",
    emergency: ["Maria Refuerzo", "Parent", "09171239001"] },
  { key: "jane", match: { code: "SACS-003" }, cp: "09171230003", address: "9 P. Oliveros St, Antipolo City, Rizal",
    emergency: ["Ramil Benitez", "Parent", "09171239003"] },
  { key: "jarvis", match: { code: "SACS-042" }, cp: "09171230042", address: "34 Bagong Nayon, Antipolo City, Rizal",
    emergency: ["Josefina Pasion", "Parent", "09171239042"] },
  { key: "marisol", match: { code: "DEMO-101" }, licensed: { no: "0991101", expires: "2028-06-30" } },
  { key: "carlo", match: { code: "DEMO-102" }, licensed: { no: "0991102", expires: "2029-03-31" } },
  { key: "liza", match: { code: "DEMO-103" } },
  { key: "ramon", match: { code: "DEMO-104" }, active: true }, // his case opens again after Nov 1-15 is paid
  { key: "nestor", match: { code: "DEMO-105" } },
  { key: "teresa", match: { code: "SACS-HR-001" }, rename: { first: "Teresa", middle: "Cruz", last: "Bautista" }, cp: "09171230301",
    address: "7 M.L. Quezon Ext, Antipolo City, Rizal", emergency: ["Ruben Bautista", "Spouse", "09171239301"] },
  { key: "janeacc", match: { code: "SACS-005" }, cp: "09171230005", address: "3 Ortigas Ave Ext, Cainta, Rizal",
    emergency: ["Ramil Benitez", "Parent", "09171239005"] },
  { key: "karlos", match: { code: "SACS-044" }, cp: "09171230044", address: "15 Robinson's Place Rd, Antipolo City, Rizal",
    emergency: ["Elena Dela Cruz", "Parent", "09171239044"] },
  // The HR login of Jane Marinel (owner: complete it as its own record at Robinson Branch).
  { key: "janehr", match: { name: "Jane Marinel Dela Pena Benitez", role: "hr" }, branch: "BR-003", code: "SACS-HR-003", position: "HR Officer", salary: 28000,
    hired: "2026-09-24", category: "Non-Teaching", status: "Regular", cp: "09171230303", address: "3 Ortigas Ave Ext, Cainta, Rizal", emergency: ["Ramil Benitez", "Parent", "09171239005"] },
  { key: "nona", match: { name: "Nona Guido", role: "hr" }, branch: "BR-001", code: "SACS-HR-002", position: "HR Officer", salary: 32000, hired: "2025-06-02",
    category: "Non-Teaching", status: "Regular", active: true, cp: "09171230302", address: "40 Dela Paz, Antipolo City, Rizal", emergency: ["Arnel Guido", "Spouse", "09171239302"] },
];

/** Fictional, well-formed government numbers from the person's place in the list. */
export function govNumbers(n) {
  // Digits only, as stored (SSS 10, PhilHealth 12, Pag-IBIG 12, TIN 12); the screens add the dashes.
  const pad = (v, w) => String(v).padStart(w, "0");
  return { sss_number: `99${pad(n, 8)}`, philhealth_number: `9900${pad(n, 8)}`, pagibig_number: `9910${pad(n, 8)}`, tin_number: `999${pad(n, 6)}000` };
}

/**
 * The days that are not ordinary, per person: [in, out] Manila "HH:MM" (null = no tap), "none" = no tap at all.
 * Leave days need no entry (approved leave: no taps). Ordinary days come from the person's schedule.
 */
export const SPECIAL_DAYS = {
  marisol: { "2026-11-05": ["08:25", "auto"], "2026-11-10": ["auto", "19:04"] },
  carlo: { "2026-11-09": ["08:18", "auto"] },
  liza: { "2026-11-06": ["auto", null], "2026-11-18": ["auto", null], "2026-11-19": "none" },
  ramon: { "2026-11-03": ["08:14", "auto"], "2026-11-04": ["auto", "10:30"], "2026-11-13": ["auto", "18:40"] },
  nestor: { "2026-11-06": ["auto", "18:33"] },
  jane: { "2026-10-14": ["08:32", "auto"], "2026-10-29": ["auto", "11:00"] },
  jarvis: { "2026-11-12": ["08:20", "auto"] },
  karlos: { "2026-11-18": ["08:16", "auto"] },
  andrea: { "2026-10-20": ["08:27", "auto"] },
  joanna: { "2026-10-30": ["auto", "18:02"] },
};
/** Ramon (AWOL demo): no taps from this day on. Anjo: none after his last day. */
export const STOP_TAPPING = { ramon: "2026-11-18", anjo: "2026-10-22" };

/** Leave, as filed (filed date) and decided. half: "AM" / "PM". */
export const LEAVE = [
  { who: "andrea", type: "Sick Leave", start: "2026-10-07", end: "2026-10-07", filed: "2026-10-08", decision: "approve", reason: "Flu; clinic visit" },
  { who: "andrea", type: "Emergency Leave", start: "2026-10-27", end: "2026-10-27", filed: "2026-10-26", decision: "approve", reason: "Child brought to the hospital" },
  { who: "ehd", type: "Vacation Leave", start: "2026-10-22", end: "2026-10-22", half: "PM", filed: "2026-10-19", decision: "approve", reason: "Afternoon: PRC renewal appointment" },
  { who: "marisol", type: "Vacation Leave", start: "2026-11-12", end: "2026-11-13", filed: "2026-11-03", decision: "approve", reason: "Family reunion in Batangas" },
  { who: "liza", type: "Vacation Leave", start: "2026-11-11", end: "2026-11-11", half: "AM", filed: "2026-11-09", decision: "approve", reason: "Morning: bank and government office errands" },
  { who: "ramon", type: "Vacation Leave", start: "2026-11-09", end: "2026-11-09", filed: "2026-11-04", decision: "reject", reason: "Personal errand",
    remark: { code: "reject.leave.school_activity" }, note: "Conflicts with the Grade 4 field trip that day." },
  { who: "jarvis", type: "Sick Leave", start: "2026-11-10", end: "2026-11-10", filed: "2026-11-11", decision: "approve", reason: "Stomach flu" },
  { who: "carlo", type: "Sick Leave", start: "2026-11-17", end: "2026-11-17", filed: "2026-11-18", decision: "approve", reason: "Fever; clinic visit", substitute: "marisol" },
  { who: "jane", type: "Vacation Leave", start: "2026-11-27", end: "2026-11-27", filed: "2026-11-20", decision: null, reason: "Sister's wedding in Laguna" },
  { who: "nestor", type: "Vacation Leave", start: "2026-12-01", end: "2026-12-01", filed: "2026-11-23", decision: null, reason: "Barangay ID and clearance" },
];

/** Overtime filed ahead (approved ones are worked: the time out above matches). */
export const OVERTIME = [
  { who: "marisol", day: "2026-11-10", start: "17:00", end: "19:00", filed: "2026-11-09", decision: "approve", reason: "Grade 6 recognition rehearsal" },
  { who: "nestor", day: "2026-11-06", start: "17:00", end: "18:30", filed: "2026-11-05", decision: "approve", reason: "Stage set-up for the school program" },
  { who: "joanna", day: "2026-10-30", start: "17:00", end: "18:00", filed: "2026-10-29", decision: "approve", reason: "Month-end payroll checking" },
  { who: "carlo", day: "upcoming", start: "17:00", end: "18:00", decision: null, reason: "Checking quarterly exam papers" },
];
// Ramon's Nov 13 (out 18:40, no request) is the "Overtime not filed" day.

/** Missing time-outs fixed by a correction (Liza's Nov 6 approved; Nov 18 pending). */
export const CORRECTIONS = [
  { who: "liza", day: "2026-11-06", time: "17:05", decision: "approve", note: "Confirmed with the guard's logbook." },
  { who: "liza", day: "2026-11-18", time: "17:10", decision: null },
];

/** Additional pay (Accountant files, HR approves). */
export const ADDITIONAL = [
  { who: "carlo", kind: "honorarium", amount: 800, date: "2026-10-09", description: "Judge, Science Fair" },
  { who: "liza", kind: "honorarium", amount: 1000, date: "2026-10-29", description: "Host, Foundation Day program" },
  { who: "marisol", kind: "honorarium", amount: 1500, date: "2026-11-14", description: "Host, Recognition Day program" },
  { who: "ramon", kind: "adjustment", amount: 500, date: "2026-11-14", description: "October transport allowance underpaid" },
];

/** Loans and cash advances (Accountant files, HR approves); repaid on the payslips. */
export const LOANS = [
  { who: "marisol", type: "salary_loan", principal: 10000, payrolls: 4, granted: "2026-10-05", start: "2026-10-16", description: "Salary loan" },
  { who: "andrea", type: "cash_advance", principal: 3000, payrolls: 2, granted: "2026-10-12", start: "2026-10-16", description: "Cash advance" },
  { who: "jane", type: "salary_loan", principal: 6000, payrolls: 3, granted: "2026-10-12", start: "2026-10-16", description: "Salary loan" },
];

/** The special working day covers the three demo teachers. */
export const MAKEUP_COVERS = ["marisol", "carlo", "liza"];
