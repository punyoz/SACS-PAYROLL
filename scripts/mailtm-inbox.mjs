/**
 * mail.tm test inboxes from the command line (development only).
 *
 *   npm run mailtm -- create              new inbox; prints address + password
 *   npm run mailtm -- list                inboxes created on this machine
 *   npm run mailtm -- messages <address>  what arrived
 *   npm run mailtm -- otp <address>       wait (up to 90 s) for a code and print it
 *   npm run mailtm -- delete <address>    remove the inbox from mail.tm
 *
 * Needs USE_MAILTM=true in .env.local. Inbox passwords are kept in
 * .runtime/mailtm-inboxes.json (git-ignored).
 *
 * To check sign-in code delivery: create an inbox, set a TEST Employee or
 * Accountant account's email to that address (HR / Admin -> edit employee),
 * sign in as that account, then run "otp <address>" (or press "Read code from
 * test inbox" on the code screen).
 */

import dotenv from "dotenv";
import {
  createInbox,
  deleteInbox,
  findInbox,
  isMailtmEnabled,
  listMessages,
  listSavedInboxes,
  waitForOtp,
} from "../src/lib/mail/mailtm.service.mjs";

dotenv.config({ path: ".env.local" });

const [command = "help", address] = process.argv.slice(2);

/**
 * Stops the command with a message and an exit code. Thrown rather than
 * calling process.exit(): exiting while fetch's abort timer is still open
 * trips a libuv assertion on Windows.
 */
class Stop extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function requireInbox() {
  const inbox = findInbox(address);
  if (!inbox) {
    throw new Stop(address
      ? `${address} was not created on this machine (see "npm run mailtm -- list").`
      : "Give the inbox address.");
  }
  return inbox;
}

async function main() {
  if (!isMailtmEnabled()) {
    throw new Stop("mail.tm is off. Set USE_MAILTM=true in .env.local (never in production).");
  }

  if (command === "create") {
    const inbox = await createInbox();
    console.log(`Address:  ${inbox.address}\nPassword: ${inbox.password}`);
    console.log("Set a TEST account's email to this address, then sign in as it.");
    return;
  }
  if (command === "list") {
    const inboxes = listSavedInboxes();
    if (!inboxes.length) console.log("No inboxes yet. Run: npm run mailtm -- create");
    for (const inbox of inboxes) console.log(`${inbox.address}  (created ${inbox.createdAt})`);
    return;
  }
  if (command === "messages") {
    const messages = await listMessages(requireInbox());
    if (!messages.length) console.log("No messages.");
    for (const m of messages) console.log(`${m.createdAt}  ${m.from?.address}  ${m.subject}`);
    return;
  }
  if (command === "otp") {
    console.log("Waiting for a code (up to 90 s)...");
    const found = await waitForOtp(requireInbox(), { timeoutMs: 90_000 });
    if (!found) throw new Stop("No code arrived.", 2);
    console.log(`Code: ${found.code}\nSubject: ${found.subject}\nFrom: ${found.from}\nReceived: ${found.receivedAt}`);
    return;
  }
  if (command === "delete") {
    await deleteInbox(requireInbox());
    console.log(`Deleted ${address}.`);
    return;
  }

  console.log("Usage: npm run mailtm -- create | list | messages <address> | otp <address> | delete <address>");
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = error?.exitCode || 1;
});
