import { NextResponse } from "next/server";
import { readPendingLogin } from "@/lib/auth/pending-login";
import { sanitizeError } from "@/lib/api-error";
import {
  createInbox,
  findInbox,
  isMailtmEnabled,
  listMessages,
  listSavedInboxes,
  waitForOtp,
} from "@/lib/mail/mailtm.service.mjs";

/**
 * /api/dev/mailtm — development only: read code emails from mail.tm test
 * inboxes inside the app (src/lib/mail/mailtm.service.mjs).
 *
 * Answers 404 unless USE_MAILTM=true and NODE_ENV is not "production", so in
 * a deployment it does not exist. It is listed as public in src/proxy.js
 * because the sign-in code screen calls it before any session exists; it only
 * ever reads inboxes created on this machine (.runtime/mailtm-inboxes.json).
 *
 *   GET                                      { enabled, inboxes: [address] }
 *   POST { action: "create" }                a new inbox { address, password }
 *   POST { action: "messages", address }     that inbox's messages
 *   POST { action: "latest-otp", address?, since? }
 *       waits up to 45 s for a code in `address` (default: the address the
 *       pending sign-in's code went to) -> { code, subject, from, receivedAt }
 */

const WAIT_MS = 45_000;

function notFound() {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export async function GET() {
  if (!isMailtmEnabled()) return notFound();
  return NextResponse.json({ enabled: true, inboxes: listSavedInboxes().map((i) => i.address) });
}

export async function POST(request) {
  if (!isMailtmEnabled()) return notFound();

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "").trim();

    if (action === "create") {
      const inbox = await createInbox({ prefix: body.prefix });
      return NextResponse.json({ success: true, ...inbox });
    }

    const address = String(body.address || readPendingLogin(request)?.email || "").trim();
    const inbox = findInbox(address);
    if (!inbox) {
      return NextResponse.json(
        {
          error: address
            ? `${address} is not a mail.tm test inbox created here. Run "npm run mailtm -- create" and use that address as the account's email.`
            : "No address given and no sign-in is waiting for a code.",
        },
        { status: 404 },
      );
    }

    if (action === "messages") {
      return NextResponse.json({ address: inbox.address, messages: await listMessages(inbox) });
    }

    if (action === "latest-otp") {
      const found = await waitForOtp(inbox, { since: body.since, timeoutMs: WAIT_MS });
      if (!found) {
        return NextResponse.json({ error: `No code arrived in ${WAIT_MS / 1000} seconds.` }, { status: 404 });
      }
      return NextResponse.json({ address: inbox.address, ...found });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error, "mail.tm request failed.") }, { status: 502 });
  }
}
