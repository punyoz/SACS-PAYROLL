/**
 * In-memory twins of the email-OTP pieces the routes reach:
 *
 *   emailOtpRpc(name, args)  public.auth_email_otp_issue / _verify / _discard
 *                            (supabase/migrations/20261007020000_email_otp_codes.sql),
 *                            same rules, on Date.now() so fake timers move expiry.
 *   gmailModule              stands in for src/lib/mail/gmail.js; every send is
 *                            kept in `outbox`, so a test reads the real code
 *                            from the email it would have received.
 *
 * Kept on globalThis: vi.resetModules() reloads mocked modules, and every copy
 * must see the same rows and outbox.
 */

const state = (globalThis.__fakeEmailOtpState ??= { rows: new Map(), outbox: [], failNextSend: false });
export const outbox = state.outbox;

export function resetEmailOtpFakes() {
  state.rows.clear();
  state.outbox.length = 0;
  state.failNextSend = false;
}

/** Make the next sendMail() reject, as Gmail would on a refused login. */
export function failNextSend() {
  state.failNextSend = true;
}

/** The 6-digit code in the latest email to `to` (any address when omitted). */
export function lastCode(to) {
  const mail = [...state.outbox].reverse().find((m) => !to || m.to === to);
  return mail ? /\b(\d{6})\b/.exec(mail.text)?.[1] || null : null;
}

/** A code guaranteed not to be the one just sent. */
export function wrongCode(to) {
  const code = lastCode(to) || "000000";
  return `${(Number(code[0]) + 1) % 10}${code.slice(1)}`;
}

export function emailOtpRpc(name, args) {
  const now = Date.now();
  const rows = state.rows;
  if (name === "auth_email_otp_issue") {
    const row = rows.get(args.p_key);
    if (row && row.expiresAt > now && row.attempts < args.p_max_attempts) {
      const wait = row.sentAt + args.p_cooldown_seconds * 1000 - now;
      if (wait > 0) return { data: Math.ceil(wait / 1000), error: null };
    }
    rows.set(args.p_key, { hash: args.p_hash, expiresAt: now + args.p_ttl_seconds * 1000, attempts: 0, sentAt: now });
    return { data: 0, error: null };
  }
  if (name === "auth_email_otp_verify") {
    const row = rows.get(args.p_key);
    if (!row) return { data: "expired", error: null };
    if (row.expiresAt <= now) { rows.delete(args.p_key); return { data: "expired", error: null }; }
    if (row.attempts >= args.p_max_attempts) return { data: "locked", error: null };
    if (row.hash === args.p_hash) { rows.delete(args.p_key); return { data: "ok", error: null }; }
    row.attempts += 1;
    return { data: row.attempts >= args.p_max_attempts ? "locked" : "invalid", error: null };
  }
  if (name === "auth_email_otp_discard") {
    rows.delete(args.p_key);
    return { data: null, error: null };
  }
  return null;
}

export class MailNotConfiguredError extends Error {}

export const gmailModule = {
  MailNotConfiguredError,
  isMailConfigured: () => true,
  resetMailTransport: () => {},
  sendMail: async (message) => {
    if (state.failNextSend) {
      state.failNextSend = false;
      throw Object.assign(new Error("Invalid login"), { code: "EAUTH" });
    }
    state.outbox.push(message);
    return { messageId: `fake-${state.outbox.length}` };
  },
};
