/**
 * Shared-secret authentication for unattended hardware.
 *
 * The RFID readers are not people: they have no account, no session and no way
 * to complete a sign-in. They present a fixed key on every request instead,
 * configured on the device and held server-side in RFID_DEVICE_KEYS.
 *
 * FORMAT
 *   RFID_DEVICE_KEYS="lobby-main:s3cret-one,gate-2:s3cret-two"
 *
 * One entry per reader, so a device that is lost or decommissioned can be cut
 * off by deleting its line — without reissuing the key to every other reader.
 * The device id is what lands in the audit trail, which is the point of keying
 * them separately.
 *
 * WHAT THIS IS NOT
 * A shared secret identifies the device, not the person tapping. It is the
 * right control for a fixed reader on a private network, and it is why the
 * endpoint it guards can only append attendance rows — never read payroll, edit
 * an employee, or do anything a leaked key would make dangerous.
 */

import crypto from "node:crypto";

/** Parsed once per process; the env is fixed for the life of the deployment. */
let cache = null;

function parseKeys() {
  if (cache) return cache;

  const raw = String(process.env.RFID_DEVICE_KEYS || "").trim();
  const byKey = new Map();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(":");
    if (separator < 1) continue; // malformed entry, no device id

    const deviceId = trimmed.slice(0, separator).trim();
    const secret = trimmed.slice(separator + 1).trim();
    if (!deviceId || !secret) continue;

    byKey.set(secret, deviceId);
  }

  cache = byKey;
  return cache;
}

/** Test seam: forget the parsed env so a new value takes effect. */
export function resetDeviceKeyCache() {
  cache = null;
}

export function deviceKeysConfigured() {
  return parseKeys().size > 0;
}

/**
 * Identify the device behind a request.
 *
 * Every configured key is compared, and all of them are compared even after a
 * match, so the work done does not depend on which key was presented or whether
 * one matched at all. Each comparison is timing-safe, and the digest wrapper
 * keeps that true for keys of differing lengths (timingSafeEqual throws on a
 * length mismatch, which would itself leak the length).
 *
 * @returns {string} the matching device id, or "" when the key is unknown
 */
export function resolveDeviceId(presentedKey) {
  const presented = String(presentedKey || "");
  if (!presented) return "";

  const presentedDigest = crypto.createHash("sha256").update(presented).digest();
  let matched = "";

  for (const [secret, deviceId] of parseKeys()) {
    const secretDigest = crypto.createHash("sha256").update(secret).digest();
    if (crypto.timingSafeEqual(presentedDigest, secretDigest)) {
      matched = deviceId;
    }
  }

  return matched;
}
