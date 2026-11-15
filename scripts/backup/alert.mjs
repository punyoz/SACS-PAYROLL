// A failed scheduled backup must be noticed (2026-11-14: a run died on a DNS
// error and only the log file knew). Called by scheduled-backup.ps1:
//   node scripts/backup/alert.mjs "<message>"
// E-mails BACKUP_ALERT_TO (or GMAIL_USER) through the app's Gmail account,
// from .env.live.local. Never prints a secret. Exit 1 when it cannot send, so
// the caller still shows its own desktop notification.
import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config({ path: ".env.live.local", quiet: true });
const user = process.env.GMAIL_USER;
const pass = process.env.GMAIL_APP_PASSWORD;
const to = process.env.BACKUP_ALERT_TO || user;
const message = String(process.argv[2] || "The scheduled backup failed.").slice(0, 4000);

if (!user || !pass || !to) {
  console.error("No GMAIL_USER / GMAIL_APP_PASSWORD in .env.live.local: alert not e-mailed.");
  process.exit(1);
}
try {
  await nodemailer.createTransport({ service: "gmail", auth: { user, pass }, connectionTimeout: 15_000 }).sendMail({
    from: `"SACS Payroll backup" <${user}>`,
    to,
    subject: "SACS Payroll: the scheduled database backup FAILED",
    text: `${message}\n\nRun it again: npm run db:backup (Docker Desktop running). The log: %LOCALAPPDATA%\\SACS-Payroll\\backup.log`,
  });
  console.log("alert e-mailed");
} catch (error) {
  console.error(`alert not e-mailed: ${error.message}`);
  process.exit(1);
}
