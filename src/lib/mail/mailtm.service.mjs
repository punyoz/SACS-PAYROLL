/**
 * mail.tm test inboxes, for checking code delivery in development.
 *
 * mail.tm (https://docs.mail.tm, REST API at https://api.mail.tm) hands out
 * real, disposable email addresses. Point a TEST account's email at one, sign
 * in, and the code Gmail sends lands there, where the app (or the
 * `npm run mailtm` script) can read it back. Nothing here sends mail; it only
 * reads what arrived.
 *
 * Switched on by USE_MAILTM=true and ALWAYS off when NODE_ENV=production,
 * whatever USE_MAILTM says: every network function below refuses to run then.
 *
 *   createInbox()          new address + password on a live mail.tm domain,
 *                          remembered in .runtime/mailtm-inboxes.json
 *                          (git-ignored, local disk only)
 *   getToken(inbox)        bearer token; cached, and fetched again on a 401
 *                          (mail.tm tokens carry no expiry claim, so a 401
 *                          is the only sign one has lapsed)
 *   listMessages(inbox)    newest first: id, from, subject, intro, createdAt
 *   readMessage(inbox, id) one message with its text and html bodies
 *   extractOtp(message)    the 6-digit code in a message, or null
 *   waitForOtp(inbox, …)   polls every few seconds until a code arrives or
 *                          the timeout passes
 *
 * Plain Node (no "@/" imports, .mjs) so scripts/mailtm-inbox.mjs can load it too.
 * mail.tm allows 8 requests per second per IP; polling every 3 s is far
 * below that, and a 429 is waited out (Retry-After) rather than retried hot.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MAILTM_API = "https://api.mail.tm";
const REQUEST_TIMEOUT_MS = 10_000;
const STORE_FILE = path.join(process.cwd(), ".runtime", "mailtm-inboxes.json");

export class MailtmDisabledError extends Error {
  constructor() {
    super("mail.tm is off. Set USE_MAILTM=true (development only; never in production).");
    this.name = "MailtmDisabledError";
  }
}

export class MailtmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "MailtmError";
    this.status = status;
  }
}

/** True only with USE_MAILTM=true outside production. */
export function isMailtmEnabled() {
  return String(process.env.USE_MAILTM || "").trim().toLowerCase() === "true"
    && process.env.NODE_ENV !== "production";
}

function assertEnabled() {
  if (!isMailtmEnabled()) throw new MailtmDisabledError();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── Local inbox store ─────────────────────────────────────────────────── */

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

const normalizeAddress = (address) => String(address || "").trim().toLowerCase();

/** A collection's items: JSON-LD wraps them in hydra:member, plain JSON is the bare array. */
function members(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.["hydra:member"]) ? data["hydra:member"] : [];
}

/** The saved inbox for `address`, or null when it is not one of ours. */
export function findInbox(address) {
  const key = normalizeAddress(address);
  const saved = readStore()[key];
  return saved ? { address: key, password: saved.password, id: saved.id } : null;
}

/** Addresses of every inbox created on this machine. */
export function listSavedInboxes() {
  return Object.entries(readStore()).map(([address, value]) => ({ address, id: value.id, createdAt: value.createdAt }));
}

/* ── HTTP ──────────────────────────────────────────────────────────────── */

const tokens = new Map(); // address -> token

async function request(method, pathname, { body, token, retries = 2 } = {}) {
  let response;
  try {
    response = await fetch(`${MAILTM_API}${pathname}`, {
      method,
      headers: {
        // JSON-LD: collections come wrapped in hydra:member (members() reads both).
        Accept: "application/ld+json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MailtmError(`mail.tm could not be reached: ${error?.message || error}`, 0);
  }

  if (response.status === 429 && retries > 0) {
    const wait = Math.min(Number(response.headers.get("Retry-After")) || 1, 10);
    await sleep(wait * 1000);
    return request(method, pathname, { body, token, retries: retries - 1 });
  }

  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail || data?.message || data?.["hydra:description"] || response.statusText;
    throw new MailtmError(`mail.tm ${method} ${pathname} failed (${response.status}): ${detail}`, response.status);
  }
  return data;
}

/** GET with the inbox's token, fetching a fresh one once on a 401. */
async function authorized(inbox, pathname) {
  const token = await getToken(inbox);
  try {
    return await request("GET", pathname, { token });
  } catch (error) {
    if (error instanceof MailtmError && error.status === 401) {
      return request("GET", pathname, { token: await getToken(inbox, { refresh: true }) });
    }
    throw error;
  }
}

/* ── API ───────────────────────────────────────────────────────────────── */

/** Active public domains new addresses can use. */
export async function getDomains() {
  assertEnabled();
  const data = await request("GET", "/domains");
  return members(data).filter((d) => d.isActive && !d.isPrivate).map((d) => d.domain);
}

/**
 * Create a new inbox and remember its password locally.
 * @param {{ prefix?: string }} [options] start of the address's local part
 * @returns {Promise<{ address: string, password: string, id: string }>}
 */
export async function createInbox({ prefix = "sacs" } = {}) {
  assertEnabled();
  const [domain] = await getDomains();
  if (!domain) throw new MailtmError("mail.tm has no active domain right now.", 503);

  const local = `${String(prefix).toLowerCase().replace(/[^a-z0-9]/g, "") || "sacs"}${crypto.randomBytes(4).toString("hex")}`;
  const address = `${local}@${domain}`;
  const password = crypto.randomBytes(18).toString("base64url");
  const account = await request("POST", "/accounts", { body: { address, password } });

  const store = readStore();
  store[address] = { password, id: account?.id || "", createdAt: new Date().toISOString() };
  writeStore(store);
  return { address, password, id: account?.id || "" };
}

/**
 * Bearer token for an inbox.
 * @param {{ address: string, password: string }} inbox
 * @param {{ refresh?: boolean }} [options]
 */
export async function getToken(inbox, { refresh = false } = {}) {
  assertEnabled();
  const key = normalizeAddress(inbox?.address);
  if (!refresh && tokens.has(key)) return tokens.get(key);
  const data = await request("POST", "/token", { body: { address: key, password: inbox.password } });
  if (!data?.token) throw new MailtmError("mail.tm returned no token.", 502);
  tokens.set(key, data.token);
  return data.token;
}

/**
 * Messages in the inbox, newest first (first page: the 30 most recent).
 * @returns {Promise<Array<{ id: string, from: { address: string, name: string }, subject: string, intro: string, createdAt: string, seen: boolean }>>}
 */
export async function listMessages(inbox) {
  assertEnabled();
  const data = await authorized(inbox, "/messages?page=1");
  return [...members(data)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** One full message: the list fields plus `text` and `html` (an array of HTML parts). */
export async function readMessage(inbox, id) {
  assertEnabled();
  return authorized(inbox, `/messages/${encodeURIComponent(id)}`);
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8202;|&nbsp;|&#160;/g, "")
    .replace(/&[a-z#0-9]+;/gi, " ");
}

/**
 * The one-time code in a message. Looks in the plain text first, then the
 * HTML with tags removed. Prefers a code next to the word "code"; otherwise
 * the first standalone 6-digit number.
 * @param {{ text?: string, html?: string[]|string, intro?: string, subject?: string }} message
 * @param {number} [length]
 * @returns {string|null}
 */
export function extractOtp(message, length = 6) {
  if (!message) return null;
  const html = Array.isArray(message.html) ? message.html.join("\n") : message.html;
  const sources = [message.text, stripHtml(html), message.intro, message.subject];
  const near = new RegExp(`code[^0-9]{0,40}?\\b(\\d{${length}})\\b`, "i");
  const any = new RegExp(`(?<![\\d-])(\\d{${length}})(?![\\d-])`);
  for (const source of sources) {
    const text = String(source || "");
    const match = near.exec(text) || any.exec(text);
    if (match) return match[1];
  }
  return null;
}

/**
 * Poll the inbox until a message with a code arrives.
 * @param {{ address: string, password: string }} inbox
 * @param {{ since?: Date|string|number, timeoutMs?: number, intervalMs?: number, length?: number }} [options]
 *   `since`: ignore messages created before this moment (default: any).
 * @returns {Promise<{ code: string, messageId: string, subject: string, from: string, receivedAt: string } | null>}
 *   null when nothing arrived in time.
 */
export async function waitForOtp(inbox, { since, timeoutMs = 90_000, intervalMs = 3_000, length = 6 } = {}) {
  assertEnabled();
  const after = since ? new Date(since).getTime() : 0;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const checked = new Set();

  for (;;) {
    const messages = await listMessages(inbox);
    for (const summary of messages) {
      if (checked.has(summary.id)) continue;
      if (after && new Date(summary.createdAt).getTime() < after) continue;
      checked.add(summary.id);
      const full = await readMessage(inbox, summary.id);
      const code = extractOtp(full, length);
      if (code) {
        return {
          code,
          messageId: summary.id,
          subject: summary.subject || "",
          from: summary.from?.address || "",
          receivedAt: summary.createdAt,
        };
      }
    }
    if (Date.now() + intervalMs > deadline) return null;
    await sleep(intervalMs);
  }
}

/** Delete an inbox on mail.tm and forget it locally. */
export async function deleteInbox(inbox) {
  assertEnabled();
  const key = normalizeAddress(inbox?.address);
  const saved = findInbox(key) || inbox;
  const token = await getToken(saved);
  const id = saved.id || (await request("GET", "/me", { token }))?.id;
  if (id) await request("DELETE", `/accounts/${encodeURIComponent(id)}`, { token });
  tokens.delete(key);
  const store = readStore();
  delete store[key];
  writeStore(store);
}
