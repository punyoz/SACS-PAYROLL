/**
 * Outgoing mail through Gmail SMTP (Nodemailer).
 *
 * Signs in to smtp.gmail.com as GMAIL_USER with a Google App Password
 * (GMAIL_APP_PASSWORD) — never the account's real password. An App Password
 * needs 2-Step Verification on that Google account: Google Account ->
 * Security -> 2-Step Verification -> App passwords.
 *
 * Server-only: the credentials are read from the environment here and never
 * reach the browser (neither variable has the NEXT_PUBLIC_ prefix).
 */

import nodemailer from "nodemailer";

/** Thrown when GMAIL_USER / GMAIL_APP_PASSWORD are not set. */
export class MailNotConfiguredError extends Error {
  constructor() {
    super("Email is not configured: set GMAIL_USER and GMAIL_APP_PASSWORD.");
    this.name = "MailNotConfiguredError";
  }
}

function credentials() {
  const user = String(process.env.GMAIL_USER || "").trim();
  // Google shows App Passwords in groups of four ("abcd efgh ijkl mnop"); the
  // spaces are not part of it.
  const pass = String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  return user && pass ? { user, pass } : null;
}

export function isMailConfigured() {
  return credentials() !== null;
}

let cached = null; // { key, transporter }

function transporter() {
  const auth = credentials();
  if (!auth) throw new MailNotConfiguredError();
  const key = `${auth.user}:${auth.pass}`;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      transporter: nodemailer.createTransport({
        service: "gmail",
        auth,
        // A login screen is waiting on this send: fail in seconds, not minutes.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      }),
    };
  }
  return cached.transporter;
}

/**
 * Send one message. Resolves to Nodemailer's info object; rejects when Gmail
 * refuses it or cannot be reached.
 * @param {{ to: string, subject: string, html: string, text: string, attachments?: object[] }} message
 */
export async function sendMail({ to, subject, html, text, attachments }) {
  const auth = credentials();
  if (!auth) throw new MailNotConfiguredError();
  const fromName = String(process.env.MAIL_FROM_NAME || "SACS Payroll").replace(/["\r\n]/g, "").trim();
  return transporter().sendMail({
    // Gmail rewrites any other From address to the signed-in account anyway.
    from: { name: fromName || "SACS Payroll", address: auth.user },
    to,
    subject,
    html,
    text,
    attachments,
  });
}

/** Test seam: drop the cached transporter. */
export function resetMailTransport() {
  cached = null;
}
