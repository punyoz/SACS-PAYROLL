/**
 * The one-time-code email: subject, HTML and plain text, in the school's
 * green and gold.
 *
 * The seal is attached inline (cid:) rather than linked, so it shows without
 * the mail client fetching anything from the app's host — which has no fixed
 * public URL in development. next.config.mjs's outputFileTracingIncludes
 * ships the file with the API functions on Vercel. If the file is missing the
 * email goes out without it rather than not at all.
 */

import fs from "node:fs";
import path from "node:path";

const LOGO_FILE = path.join(process.cwd(), "public", "legacy", "assets", "logo-160.png");
const LOGO_CID = "sacs-logo@sacs-payroll";

const GREEN = "#1B5E3C";
const GREEN_DARK = "#0F3D28";
const GOLD = "#C9A227";
const GOLD_LIGHT = "#E8C766";

const PURPOSES = {
  login: { subject: "Your SACS Payroll sign-in code", action: "finish signing in" },
  reset: { subject: "Your SACS Payroll password reset code", action: "reset your password" },
  pwchange: { subject: "Your SACS Payroll password change code", action: "change your password" },
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function logoAttachment() {
  try {
    if (!fs.existsSync(LOGO_FILE)) return null;
    return { filename: "sacs-logo.png", path: LOGO_FILE, cid: LOGO_CID };
  } catch {
    return null;
  }
}

/**
 * @param {{ code: string, purpose: "login"|"reset"|"pwchange", minutes: number, name?: string }} input
 * @returns {{ subject: string, html: string, text: string, attachments: object[] }}
 */
export function buildOtpEmail({ code, purpose, minutes, name }) {
  const kind = PURPOSES[purpose] || PURPOSES.login;
  const logo = logoAttachment();
  const greeting = name ? `Hello ${escapeHtml(name)},` : "Hello,";
  const digits = String(code).split("").map(escapeHtml).join("&#8202;");

  const logoCell = logo
    ? `<img src="cid:${LOGO_CID}" width="72" height="72" alt="Shepherd Angels Christian School seal" style="display:block;margin:0 auto 12px;border:0;outline:none;">`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(kind.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#F6F7F3;font-family:'DM Sans',Segoe UI,Arial,sans-serif;color:#1A1A1A;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F6F7F3;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid #E0D5AE;">
      <tr><td style="background:${GREEN};background-image:linear-gradient(135deg,${GREEN} 0%,${GREEN_DARK} 100%);padding:28px 24px 22px;text-align:center;border-bottom:4px solid ${GOLD};">
        ${logoCell}
        <div style="color:#FFFFFF;font-size:17px;font-weight:700;letter-spacing:.01em;">Shepherd Angels Christian School</div>
        <div style="color:${GOLD_LIGHT};font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-top:4px;">Payroll Management System</div>
      </td></tr>
      <tr><td style="padding:28px 28px 8px;font-size:15px;line-height:1.6;">
        <p style="margin:0 0 12px;">${greeting}</p>
        <p style="margin:0 0 20px;">Use this code to ${escapeHtml(kind.action)}:</p>
        <div style="text-align:center;margin:0 0 20px;">
          <div style="display:inline-block;background:#FBF6E6;border:2px solid ${GOLD};border-radius:12px;padding:14px 22px;font-family:'DM Mono',Consolas,'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:.35em;color:${GREEN_DARK};">${digits}</div>
        </div>
        <p style="margin:0 0 8px;">It expires in <strong>${Number(minutes)} minutes</strong> and works once.</p>
        <p style="margin:0 0 20px;color:#5E6470;font-size:13px;">If you did not try to sign in or change your password, ignore this email and tell the school administrator. Never share this code with anyone, including school staff.</p>
      </td></tr>
      <tr><td style="background:#F2F4EF;padding:14px 24px;text-align:center;font-size:11px;color:#5E6470;border-top:1px solid #E0D5AE;">
        Sent automatically by SACS Payroll. Please do not reply.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    "Shepherd Angels Christian School - Payroll Management System",
    "",
    name ? `Hello ${name},` : "Hello,",
    "",
    `Use this code to ${kind.action}: ${code}`,
    "",
    `It expires in ${Number(minutes)} minutes and works once.`,
    "If you did not request it, ignore this email and tell the school administrator.",
    "Never share this code with anyone.",
  ].join("\n");

  return { subject: kind.subject, html, text, attachments: logo ? [logo] : [] };
}
