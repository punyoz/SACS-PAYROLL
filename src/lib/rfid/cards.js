/**
 * RFID cards and terminals (20261021030000_rfid_cards_terminals.sql). The
 * database functions own every rule (who, which branch, which status move);
 * this file shapes what the routes send and show.
 */

export const CARD_STATUS_LABELS = Object.freeze({
  active: "Active",
  inactive: "Inactive",
  lost: "Lost",
  replaced: "Replaced",
});

export const CARD_STATUS_TONES = Object.freeze({ active: "success", inactive: "muted", lost: "danger", replaced: "gold" });

export const CARD_ACTION_LABELS = Object.freeze({
  registered: "Registered",
  replaced: "Replaced",
  deactivated: "Deactivated",
  reactivated: "Reactivated",
  marked_lost: "Marked lost",
  imported: "Imported",
});

export const ROLE_LABELS = Object.freeze({
  hr: "HR",
  super_admin: "Super Admin",
  admin: "Admin",
  accountant: "Accountant",
  employee: "Employee",
  system: "System",
});

/** No reader seen for this long: the terminal reads "No recent taps". */
export const TERMINAL_QUIET_MINUTES = 60;

/** "••••••5678": recognisable, never the whole number on screen. */
export function maskUid(uidOrLast4) {
  const last4 = String(uidOrLast4 || "").slice(-4);
  return last4 ? `••••••${last4}` : "—";
}

/** Digits only, 1–16 (what a reader types and the terminal matches). */
export function isCardUid(value) {
  return /^\d{1,16}$/.test(String(value ?? "").trim());
}

const STATUS_BY_CODE = {
  forbidden: 403, not_found: 404, duplicate: 409, already_active: 409, blocked: 409,
  invalid_transition: 409, invalid: 400, reason_required: 400,
};

/** A database refusal as { status, error, code } for the person. */
export function describeRfidError(error) {
  const message = String(error?.message || "").replace(/^ERROR:\s*/, "");
  const match = message.match(/^([a-z_]+):\s*(.*)$/s);
  if (match && STATUS_BY_CODE[match[1]]) {
    return { status: STATUS_BY_CODE[match[1]], error: match[2].charAt(0).toUpperCase() + match[2].slice(1), code: match[1] };
  }
  if (String(error?.code || "") === "42501") return { status: 403, error: message || "Not allowed.", code: "forbidden" };
  if (/does not exist|schema cache|could not find the function/i.test(message)) {
    return { status: 503, error: "RFID cards are not set up yet: apply 20261021030000_rfid_cards_terminals.sql.", code: "not_ready" };
  }
  return { status: 500, error: "Not saved. Please try again.", code: "error" };
}

/** A terminal's health from its last tap. */
export function terminalHealth(terminal, now = Date.now()) {
  if (terminal.status !== "active") return { label: "Inactive", tone: "muted" };
  if (!terminal.last_tap_at) return { label: "No taps yet", tone: "gold" };
  const minutes = (now - new Date(terminal.last_tap_at).getTime()) / 60000;
  return minutes <= TERMINAL_QUIET_MINUTES ? { label: "Recent taps", tone: "success" } : { label: "No recent taps", tone: "gold" };
}
