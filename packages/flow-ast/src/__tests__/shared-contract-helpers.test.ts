import { describe, expect, it } from "vitest";

import { createFlowCredentialHandle } from "../types/credential-contracts.js";
import { isRecord, nonEmptyString, validDate } from "../types/primitives.js";

/**
 * `validDate`, `nonEmptyString` and `isRecord` were duplicated byte-for-byte in
 * credential-contracts.ts and security-contracts.ts. They now live in
 * primitives.ts. These tests pin the behaviour the two contract modules rely on
 * so a future edit to the shared copy cannot silently loosen either validator.
 */
describe("shared contract helpers", () => {
  describe("validDate", () => {
    it.each([
      ["2024-01-01T00:00:00Z", true],
      ["2024-01-01T00:00:00.123Z", true],
      ["2024-01-01T00:00:00+02:00", true],
      ["2024-01-01T00:00:00-05:30", true],
    ])("accepts RFC 3339 %s", (value, expected) => {
      expect(validDate(value)).toBe(expected);
    });

    it.each([
      ["2024-01-01", "date without time"],
      ["2024-01-01T00:00:00", "no timezone offset"],
      ["not-a-date", "free text"],
      ["", "empty string"],
      ["   ", "whitespace only"],
      ["2024-13-01T00:00:00Z", "month 13 parses to NaN"],
    ])("rejects %s (%s)", (value) => {
      expect(validDate(value)).toBe(false);
    });

    it.each([[null], [undefined], [42], [{}], [[]]])(
      "rejects non-string %s",
      (value) => {
        expect(validDate(value)).toBe(false);
      },
    );

    // The regex carries an eslint-disable for security/detect-unsafe-regex with
    // a linearity argument attached. Guard the claim, not just the comment.
    it("stays linear on an adversarial near-miss input", () => {
      const attack = `2024-01-01T00:00:00.${"9".repeat(40_000)}!`;
      const started = process.hrtime.bigint();
      expect(validDate(attack)).toBe(false);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(elapsedMs).toBeLessThan(50);
    });
  });

  describe("nonEmptyString", () => {
    it.each([
      ["a", true],
      [" a ", true],
      ["", false],
      ["   ", false],
      ["\t\n", false],
    ])("nonEmptyString(%j) === %s", (value, expected) => {
      expect(nonEmptyString(value)).toBe(expected);
    });

    it.each([[null], [undefined], [0], [{}]])("rejects %s", (value) => {
      expect(nonEmptyString(value)).toBe(false);
    });
  });

  describe("isRecord", () => {
    it("accepts plain objects and rejects arrays and null", () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord([])).toBe(false);
      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
      expect(isRecord("s")).toBe(false);
    });
  });

  // Consolidation is only safe if the consuming module still enforces the rule.
  // This reaches through credential-contracts to the shared validDate.
  describe("credential-contracts still enforces validDate via the shared copy", () => {
    const base = {
      schema: "dzupagent.flowCredentialHandle/v1",
      handleId: "h1",
      bindingRef: "binding://b1",
      capabilityRef: "cap1",
      scopes: ["read"],
    } as const;

    it("accepts a valid expiresAt", () => {
      expect(() =>
        createFlowCredentialHandle({
          ...base,
          expiresAt: "2024-01-01T00:00:00Z",
        }),
      ).not.toThrow();
    });

    it("rejects a malformed expiresAt", () => {
      expect(() =>
        createFlowCredentialHandle({ ...base, expiresAt: "2024-01-01" }),
      ).toThrow(/RFC 3339/);
    });
  });
});
