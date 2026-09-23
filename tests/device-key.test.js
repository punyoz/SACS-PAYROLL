import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  deviceKeysConfigured,
  resolveDeviceId,
  resetDeviceKeyCache,
} from "@/lib/auth/device-key";

const ORIGINAL = process.env.RFID_DEVICE_KEYS;

function setKeys(value) {
  process.env.RFID_DEVICE_KEYS = value;
  resetDeviceKeyCache();
}

beforeEach(() => {
  setKeys("lobby-main:secret-one,gate-2:secret-two");
});

afterEach(() => {
  process.env.RFID_DEVICE_KEYS = ORIGINAL;
  resetDeviceKeyCache();
});

describe("RFID device keys", () => {
  it("identifies each reader by its own key", () => {
    expect(resolveDeviceId("secret-one")).toBe("lobby-main");
    expect(resolveDeviceId("secret-two")).toBe("gate-2");
  });

  it("rejects a key that is not configured", () => {
    expect(resolveDeviceId("not-a-key")).toBe("");
  });

  it("rejects an empty or missing key", () => {
    expect(resolveDeviceId("")).toBe("");
    expect(resolveDeviceId(null)).toBe("");
    expect(resolveDeviceId(undefined)).toBe("");
  });

  it("does not match on a prefix of a real key", () => {
    expect(resolveDeviceId("secret")).toBe("");
    expect(resolveDeviceId("secret-one-extra")).toBe("");
  });

  it("reports when nothing is configured, so the endpoint can refuse", () => {
    setKeys("");
    expect(deviceKeysConfigured()).toBe(false);
    expect(resolveDeviceId("secret-one")).toBe("");
  });

  it("revoking one reader leaves the others working", () => {
    setKeys("gate-2:secret-two");
    expect(resolveDeviceId("secret-one")).toBe("");
    expect(resolveDeviceId("secret-two")).toBe("gate-2");
  });

  it("ignores malformed entries without dropping the valid ones", () => {
    setKeys("no-separator,:no-device,lobby-main:secret-one, ,");
    expect(deviceKeysConfigured()).toBe(true);
    expect(resolveDeviceId("secret-one")).toBe("lobby-main");
    expect(resolveDeviceId("no-separator")).toBe("");
  });

  it("tolerates whitespace around entries", () => {
    setKeys("  lobby-main : secret-one , gate-2:secret-two  ");
    expect(resolveDeviceId("secret-one")).toBe("lobby-main");
  });

  it("allows a secret containing colons", () => {
    setKeys("lobby-main:a:b:c");
    expect(resolveDeviceId("a:b:c")).toBe("lobby-main");
  });
});
