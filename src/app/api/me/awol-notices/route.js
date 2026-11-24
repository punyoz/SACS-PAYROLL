/**
 * My Notices (2026-11-24): the employee's own AWOL notices, their replies and
 * HR's decision. Reachable while the case is open and after separation (pay
 * on hold or not): mapped to "profile" in src/proxy.js, which a separated
 * account keeps.
 *
 *   GET                       { cases: [{ id, stage, open, automation, notices[], replies[], decision }], banner }
 *   GET ?file=<path>          one of the employee's own attachments
 *   GET ?notice=<id>          one of the employee's own notices (PDF)
 *   POST { case_id, kind: "reply" | "follow_up", reason_code, explanation, return_on?, attachments?: [{ name, type, data (base64) }] }
 *        A reply stops the automation ("Response received: HR decides") and HR is told. Never edited later; a
 *        follow-up adds to the same thread.
 */
import { NextResponse } from "next/server";
import { sanitizeError } from "@/lib/api-error";
import { appendAuditLog } from "@/lib/audit/store";
import { requirePermission } from "@/lib/rbac/guard";
import { getServiceClient } from "@/lib/supabase/admin";
import { notify } from "@/lib/branch-requests-server";
import { manilaDateKey } from "@/lib/payroll/periods";
import { REPLY_REASONS, saveReplyFiles } from "@/lib/awol/replies";
import { noticePdf } from "@/lib/awol/notice-pdf";

const ID = /^[0-9a-f-]{36}$/i;
const STAGE_TEXT = {
  flagged: "Being checked by HR", confirmed: "Confirmed AWOL", first_notice: "1st notice sent", second_notice: "Notice of separation sent",
  for_decision: "Waiting for HR's decision", closed: "Closed",
};
const OUTCOME_TEXT = { false_alarm: "Closed: no AWOL (false alarm)", returned: "Closed: you returned to work", excused_by_leave: "Closed: excused by leave", separated: "Separated" };

export async function GET(request) {
  try {
    const guard = await requirePermission(request, "profile", "read");
    if (guard.denied) return guard.denied;
    const supabase = getServiceClient();
    const url = new URL(request.url);
    // One of the employee's own notices as a PDF.
    const noticeId = url.searchParams.get("notice");
    if (noticeId) {
      if (!ID.test(noticeId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
      const { data: n } = await supabase.from("awol_notices").select("id,case_id,kind,title,body,sent_on,pdf_path,employee_id").eq("id", noticeId).eq("employee_id", guard.userId).maybeSingle();
      if (!n) return NextResponse.json({ error: "Not found." }, { status: 404 });
      const pdf = await noticePdf(supabase, n);
      return new NextResponse(pdf, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="notice-${n.sent_on}.pdf"`, "Cache-Control": "no-store" } });
    }
    const file = url.searchParams.get("file");
    if (file) {
      // Only an attachment of the caller's own case.
      const caseId = String(file).split("/")[0];
      if (!ID.test(caseId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
      const { data: own } = await supabase.from("employee_awol_cases").select("id").eq("id", caseId).eq("employee_id", guard.userId).maybeSingle();
      if (!own) return NextResponse.json({ error: "Not found." }, { status: 404 });
      const { data } = await supabase.storage.from("awol-replies").download(file);
      if (!data) return NextResponse.json({ error: "Not found." }, { status: 404 });
      return new NextResponse(Buffer.from(await data.arrayBuffer()), { status: 200, headers: { "Content-Type": data.type || "application/octet-stream", "Cache-Control": "no-store" } });
    }
    const { data: cases } = await supabase.from("employee_awol_cases")
      .select("id,stage,outcome,first_absent_on,first_notice_sent_on,first_notice_reply_by,second_notice_sent_on,separation_scheduled_on,separation_effective,automation,automation_reason,decided_at,decided_by_name,updated_at")
      .eq("employee_id", guard.userId).order("created_at", { ascending: false }).limit(20);
    const ids = (cases || []).map((c) => c.id);
    const [{ data: notices }, { data: replies }] = ids.length
      ? await Promise.all([
        supabase.from("awol_notices").select("id,case_id,kind,title,sent_on,reply_by,separation_on").in("case_id", ids).order("created_at", { ascending: true }),
        supabase.from("awol_replies").select("id,case_id,kind,reason_code,explanation,return_on,received_on,received_how,attachments,author_name,author_role,created_at").in("case_id", ids).order("created_at", { ascending: true }),
      ])
      : [{ data: [] }, { data: [] }];
    const out = (cases || []).filter((c) => (notices || []).some((n) => n.case_id === c.id)).map((c) => {
      const open = c.stage !== "closed";
      const mine = (notices || []).filter((n) => n.case_id === c.id);
      const latest = mine[mine.length - 1];
      return {
        id: c.id, stage: c.stage, open, stage_text: open ? STAGE_TEXT[c.stage] || c.stage : OUTCOME_TEXT[c.outcome] || "Closed",
        first_absent_on: c.first_absent_on,
        deadline: open ? (latest?.kind === "second" ? latest.separation_on : latest?.reply_by) || null : null,
        response_received: c.automation === "response",
        notices: mine.map(({ case_id: _c, ...n }) => n),
        replies: (replies || []).filter((r) => r.case_id === c.id).map(({ case_id: _c, ...r }) => r),
        decision: open ? null : { text: OUTCOME_TEXT[c.outcome] || "Closed", at: c.decided_at || c.updated_at, by: c.decided_by_name || "HR", separation_effective: c.separation_effective },
      };
    });
    const openWithNotice = out.find((c) => c.open);
    return NextResponse.json({
      cases: out,
      reasons: REPLY_REASONS,
      banner: openWithNotice && !openWithNotice.replies.length ? { deadline: openWithNotice.deadline } : null,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const guard = await requirePermission(request, "profile", "update");
    if (guard.denied) return guard.denied;
    const body = await request.json().catch(() => ({}));
    const caseId = String(body.case_id || "");
    if (!ID.test(caseId)) return NextResponse.json({ error: "Choose the notice." }, { status: 400 });
    const kind = body.kind === "follow_up" ? "follow_up" : "reply";
    const explanation = String(body.explanation || "").trim();
    if (explanation.length < 10) return NextResponse.json({ error: "Write your explanation (at least 10 characters)." }, { status: 400 });
    if (explanation.length > 2000) return NextResponse.json({ error: "The explanation is too long (2,000 characters at most)." }, { status: 400 });
    const reason = kind === "reply" ? String(body.reason_code || "") : (body.reason_code ? String(body.reason_code) : null);
    if (kind === "reply" && !REPLY_REASONS[reason]) return NextResponse.json({ error: "Choose the reason." }, { status: 400 });
    if (reason && !REPLY_REASONS[reason]) return NextResponse.json({ error: "Choose the reason." }, { status: 400 });
    const returnOn = body.return_on ? String(body.return_on) : null;
    if (returnOn && !/^\d{4}-\d{2}-\d{2}$/.test(returnOn)) return NextResponse.json({ error: "Choose the date you intend to return." }, { status: 400 });
    const supabase = getServiceClient();
    const { data: kase } = await supabase.from("employee_awol_cases").select("id,employee_id,branch_id,stage,automation,employee_reply,review_reason")
      .eq("id", caseId).eq("employee_id", guard.userId).maybeSingle();
    if (!kase) return NextResponse.json({ error: "Notice not found." }, { status: 404 });
    if (kind === "follow_up" && kase.stage === "closed") return NextResponse.json({ error: "This case is closed." }, { status: 409 });
    if (kind === "reply") {
      const { count } = await supabase.from("awol_replies").select("id", { count: "exact", head: true }).eq("case_id", caseId).eq("kind", "reply");
      if (count) return NextResponse.json({ error: "Your reply was already received; add a follow-up instead." }, { status: 409 });
    }
    const id = crypto.randomUUID();
    const saved = await saveReplyFiles(supabase, { caseId, replyId: id, files: body.attachments });
    if (saved.error) return NextResponse.json({ error: saved.error }, { status: 400 });
    const name = guard.session?.full_name || guard.session?.email || "Employee";
    const today = manilaDateKey();
    const { error } = await supabase.from("awol_replies").insert({
      id, case_id: caseId, employee_id: guard.userId, kind, reason_code: reason || null, explanation, return_on: returnOn,
      received_on: today, received_how: "portal", attachments: saved.files, author_id: guard.userId, author_name: name, author_role: guard.role,
    });
    if (error) throw error;
    // The automation stops: HR decides (the system never judges a reply).
    if (kase.stage !== "closed") {
      await supabase.from("employee_awol_cases").update({
        employee_reply: kase.employee_reply || `${REPLY_REASONS[reason] || "Reply"}: ${explanation}`.slice(0, 2000),
        ...(kase.automation === "auto" ? { automation: "response", automation_reason: "Response received: the employee replied. HR decides.", automation_changed_at: new Date().toISOString(), automation_changed_by_name: name } : {}),
        review_reason: kase.review_reason || "replied", review_flagged_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", caseId);
    }
    const { data: hr } = await supabase.from("profiles").select("id").eq("role", "hr").eq("archived", false);
    await notify(supabase, (hr || []).map((h) => h.id).filter((h) => String(h) !== String(guard.userId)), {
      kind: "awol_reply", title: kind === "reply" ? "AWOL: the employee replied" : "AWOL: a follow-up from the employee",
      body: `${name}: ${(REPLY_REASONS[reason] || "Follow-up")}. ${explanation.slice(0, 160)}`, link_page: "hr-awol",
    }).catch(() => 0);
    await appendAuditLog({ actor: guard, module: "awol_cases", action: kind === "reply" ? "awol_reply_received" : "awol_reply_follow_up", entity_type: "employee_awol_case", entity_id: caseId,
      branch_id: kase.branch_id, description: `${name} ${kind === "reply" ? "replied to the AWOL notice" : "added a follow-up"} (${REPLY_REASONS[reason] || "follow-up"}${saved.files.length ? `, ${saved.files.length} attachment${saved.files.length === 1 ? "" : "s"}` : ""}).`,
      metadata: { reply_id: id, return_on: returnOn } });
    return NextResponse.json({ success: true, received_on: today }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
