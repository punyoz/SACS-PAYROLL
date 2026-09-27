import { describe, it, expect, vi } from "vitest";
import {
  PII_FIELDS,
  PII_LAST4_COLUMNS,
  fetchProfilesPii,
  maskLast4,
  maskedPii,
  withoutPiiMetadata,
} from "@/lib/employees/pii";

describe("employee PII helpers", () => {
  it("selects the _last4 column of every field", () => {
    expect(PII_LAST4_COLUMNS.split(",")).toEqual(PII_FIELDS.map((f) => `${f}_last4`));
  });

  it("masks to the last four digits, and blank stays blank", () => {
    expect(maskLast4("7890")).toBe("••••7890");
    expect(maskLast4("")).toBe("");
    expect(maskLast4(null)).toBe("");
  });

  it("masks every field of a profile row, tolerating a missing row", () => {
    expect(maskedPii({ sss_number_last4: "1234", bank_account_number_last4: "5678" })).toEqual({
      sss_number: "••••1234",
      philhealth_number: "",
      pagibig_number: "",
      tin_number: "",
      bank_account_number: "••••5678",
    });
    expect(maskedPii(null).sss_number).toBe("");
  });

  it("strips every PII key from metadata and keeps the rest", () => {
    const meta = { role: "employee", bank_name: "BDO", sss_number: "0123456789", tin_number: "123456789" };
    expect(withoutPiiMetadata(meta)).toEqual({ role: "employee", bank_name: "BDO" });
    expect(meta.sss_number).toBe("0123456789");
  });

  it("decrypts through get_profiles_pii for the unique ids given", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "a", sss_number: "0123456789", philhealth_number: null }],
      error: null,
    });
    const result = await fetchProfilesPii({ rpc }, ["a", "a", null]);
    expect(rpc).toHaveBeenCalledWith("get_profiles_pii", { p_profile_ids: ["a"] });
    expect(result.get("a")).toEqual({
      sss_number: "0123456789",
      philhealth_number: "",
      pagibig_number: "",
      tin_number: "",
      bank_account_number: "",
    });
  });

  it("skips the call for no ids and throws on a database error", async () => {
    const rpc = vi.fn();
    expect((await fetchProfilesPii({ rpc }, [])).size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    const failing = { rpc: vi.fn().mockResolvedValue({ data: null, error: new Error("boom") }) };
    await expect(fetchProfilesPii(failing, ["a"])).rejects.toThrow("boom");
  });
});
