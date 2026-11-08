/**
 * The short first-time tour per role (alpha test B6): a few steps on where
 * things are, skippable, and reopened any time from the avatar menu → Help.
 */
export const HELP_VERSION = 1;

const COMMON_END = {
  title: "Your account",
  body: "The picture at the top right opens your account menu: Profile, Change password, Help (this tour) and Sign out. The bell shows new notices as they arrive.",
};

export const ROLE_HELP = {
  super_admin: [
    { title: "Welcome, Super Admin", body: "You look after the whole system: accounts for Admin and HR, branches, settings, backups and the audit log. You see payroll and attendance, but processing and approving them is the Accountant's and HR's work." },
    { title: "Dashboard", body: "The cards at the top open their lists: attendance records, accounts, backup and system health, and RFID issues." },
    { title: "RFID Management", body: "RFID Cards, RFID Terminal and RFID Issues are together in one group in the sidebar." },
    { title: "System Configuration", body: "Rates, the payslip schedule, holidays, security and the duplicate-tap window. A rate change is always a new version from a future pay period, with a reason." },
    COMMON_END,
  ],
  admin: [
    { title: "Welcome, Admin", body: "You look after one branch: its attendance, RFID cards and terminal, and the requests you send to HR (leave endorsements, transfers, incidents, incentives)." },
    { title: "Attendance", body: "Choose a date range at the top of a list. Export gives an Excel or PDF of exactly what the filters show." },
    { title: "Requests to HR", body: "HR decides every request. You see its status, and HR's decision arrives in the bell." },
    COMMON_END,
  ],
  hr: [
    { title: "Welcome, HR", body: "You serve every branch: employees and accounts, attendance corrections, leave, transfers, payroll approval, and the government rates and daily rate." },
    { title: "Employees", body: "Positions come from a list you can add to. The list never repeats a position, whatever the capitals." },
    { title: "Payroll approval", body: "Each branch's run comes to you per cutoff. You approve it or send it back with a reason. You never edit a figure, and never approve your own item." },
    { title: "Government Rates", body: "You can add a new version of the SSS, PhilHealth or Pag-IBIG rates or the daily rate. It applies from a future pay period, with a reason, and the Super Admin is notified. The hourly rate is always the daily rate ÷ 8." },
    COMMON_END,
  ],
  accountant: [
    { title: "Welcome, Accountant", body: "You process your branch's payroll each cutoff and send it to HR for approval. You also handle loans, subsidies, 13th month pay and final pay." },
    { title: "Processing payroll", body: "Process the cutoff, check the figures, then submit. One message sums up each action: green when done, red for an error, amber for a warning." },
    { title: "Records and exports", body: "Payroll Records and Reports export to Excel or PDF, with the school header, the period and the filters you chose." },
    COMMON_END,
  ],
  employee: [
    { title: "Welcome", body: "Here you see your attendance, timesheet, payslips and leave, and you can file a leave request." },
    { title: "Attendance and timesheet", body: "Choose a date range to see your taps and hours. The timesheet loads as soon as you pick the cutoff." },
    { title: "Payslips", body: "Open any approved payslip, or download it as a PDF." },
    COMMON_END,
  ],
};

export function helpFor(role) {
  return ROLE_HELP[String(role || "").toLowerCase()] || ROLE_HELP.employee;
}

export const helpSeenKey = (role) => `sacs:help-seen:${String(role || "user").toLowerCase()}:v${HELP_VERSION}`;
