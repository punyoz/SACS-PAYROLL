/**
 * The daily AWOL notice delivery (2026-11-24; vercel.json crons, ~01:00
 * Manila, after the nightly AWOL jobs). For each notice the system or HR sent
 * (awol_notices, already shown in-app): the PDF is stored on the case (the
 * private awol-notices bucket) and e-mailed to the employee; the delivery is
 * logged. A failed e-mail is retried on later runs (up to 5 attempts).
 *
 *   GET   Authorization: Bearer <CRON_SECRET>   (Vercel Cron sends it)
 *
 * Refused without the secret, or when CRON_SECRET is not set.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { appendAuditLog } from "@/lib/audit/store";
import { getServiceClient } from "@/lib/supabase/admin";
import { isMailConfigured, sendMail } from "@/lib/mail/gmail";
import { renderNoticePdf } from "@/lib/awol/notice-pdf";

export const dynamic = "force-dynamic";
const MAX_ATTEMPTS = 5;

function authorized(request) {
  const secret = process.env.CRON_SECRET || "";
  if (secret.length < 16) return false;
  const given = Buffer.from(String(request.headers.get("authorization") || ""));
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const supabase = getServiceClient();
  const { data: pending, error } = await supabase.from("awol_notices").select("*")
    .is("emailed_at", null).lt("attempts", MAX_ATTEMPTS).order("created_at", { ascending: true }).limit(25);
  if (error) return NextResponse.json({ error: "Could not read the notices." }, { status: 500 });
  const mailOn = isMailConfigured();
  // My Notices (sign-in required) and how to reply without it (2026-11-24).
  const link = `${new URL(request.url).origin}/employee?page=emp-notices`;
  const howToReply = `

To reply, sign in and open My Notices: ${link}
If you cannot sign in, reply in person at the HR office (or by letter) before the deadline.`;
  const done = [];
  for (const n of pending || []) {
    const patch = { attempts: Number(n.attempts || 0) + 1 };
    try {
      const pdf = await renderNoticePdf(n);
      if (!n.pdf_path) {
        const path = `${n.case_id}/${n.id}.pdf`;
        const up = await supabase.storage.from("awol-notices").upload(path, pdf, { contentType: "application/pdf", upsert: true });
        if (!up.error) patch.pdf_path = path;
      }
      if (!n.email_to) {
        patch.email_error = "No e-mail address on the employee's record: in-app notice only.";
      } else if (!mailOn) {
        patch.email_error = "E-mail is not set up on this server.";
      } else {
        await sendMail({
          to: n.email_to,
          subject: n.title,
          text: `${n.body}${howToReply}`,
          html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(n.body)}</pre><p>To reply, sign in and open <a href="${escapeHtml(link)}">My Notices</a>.<br>If you cannot sign in, reply in person at the HR office (or by letter) before the deadline.</p>`,
          attachments: [{ filename: `${n.kind === "second" ? "notice-of-separation" : "notice-to-return"}-${n.sent_on}.pdf`, content: pdf, contentType: "application/pdf" }],
        });
        patch.emailed_at = new Date().toISOString();
        patch.email_error = null;
      }
    } catch (e) {
      patch.email_error = String(e?.message || e).slice(0, 300);
    }
    // No address or no mail server: nothing to retry (the in-app notice stands); stop at the attempts cap.
    if (patch.email_error && (!n.email_to || !mailOn)) patch.attempts = MAX_ATTEMPTS;
    await supabase.from("awol_notices").update(patch).eq("id", n.id);
    await appendAuditLog({
      actor: null, module: "awol_cases", action: patch.emailed_at ? "awol_notice_delivered" : "awol_notice_delivery_failed", entity_type: "awol_notice", entity_id: n.id,
      status: patch.emailed_at ? "success" : "failure", source: "system",
      description: `${n.kind === "second" ? "2nd" : "1st"} AWOL notice ${patch.emailed_at ? `e-mailed to the employee with the PDF` : `not e-mailed: ${patch.email_error}`} (by System).`,
      metadata: { case_id: n.case_id, pdf_path: patch.pdf_path || n.pdf_path || null },
    }).catch(() => {});
    done.push({ id: n.id, emailed: Boolean(patch.emailed_at) });
  }
  return NextResponse.json({ processed: done.length, emailed: done.filter((d) => d.emailed).length });
}
