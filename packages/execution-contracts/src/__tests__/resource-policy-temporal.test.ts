import { describe, expect, it } from "vitest";

import {
  buildCommandCatalog,
  buildSignedExecutionPolicy,
  createDefaultResourcePolicy,
  validateResourcePolicy,
  validateSignedExecutionPolicy,
  validateSignedExecutionPolicyForClaim,
  type ResourcePolicy,
} from "../index.js";

const ISSUED_AT = "2026-07-19T10:00:00.000Z";
const EXPIRES_AT = "2026-07-19T10:05:00.000Z";
const CLAIMED_AT = "2026-07-19T10:02:00.000Z";

function temporalPolicy(overrides: Partial<ResourcePolicy> = {}) {
  const catalog = buildCommandCatalog([
    { binary: "node", workdirPolicy: "checkout-only" },
  ]);
  const policy = createDefaultResourcePolicy({
    policyId: "temporal-policy",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  });
  return buildSignedExecutionPolicy(policy, catalog);
}

describe("signed policy temporal validity", () => {
  it("accepts a signed temporal policy at a deterministic claim time", () => {
    const signed = temporalPolicy();

    expect(
      validateSignedExecutionPolicyForClaim(signed, { claimedAt: CLAIMED_AT }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("covers temporal fields with the policy signature", () => {
    const signed = temporalPolicy();
    const tampered = {
      ...signed,
      policy: { ...signed.policy, expiresAt: "2026-07-19T10:06:00.000Z" },
    };

    expect(validateSignedExecutionPolicy(tampered)).toMatchObject({
      valid: false,
      errors: ["signature does not match policy + catalog digest"],
    });
  });

  it.each([
    ["missing milliseconds", { issuedAt: "2026-07-19T10:00:00Z" }],
    ["non-UTC offset", { expiresAt: "2026-07-19T12:05:00.000+02:00" }],
    ["invalid calendar date", { issuedAt: "2026-02-30T10:00:00.000Z" }],
  ])("rejects a malformed timestamp: %s", (_case, overrides) => {
    expect(
      validateSignedExecutionPolicyForClaim(temporalPolicy(overrides), {
        claimedAt: CLAIMED_AT,
      }).valid,
    ).toBe(false);
  });

  it("rejects an incomplete temporal pair", () => {
    const policy = createDefaultResourcePolicy({ issuedAt: ISSUED_AT });

    expect(validateResourcePolicy(policy)).toMatchObject({
      valid: false,
      errors: [
        "issuedAt and expiresAt must either both be present or both be absent",
      ],
    });
  });

  it.each([
    ["zero validity", ISSUED_AT],
    ["expiry before issuance", "2026-07-19T09:59:59.999Z"],
  ])("rejects %s", (_case, expiresAt) => {
    const result = validateSignedExecutionPolicyForClaim(
      temporalPolicy({ expiresAt }),
      { claimedAt: CLAIMED_AT },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "policy validity must be positive: expiresAt must be later than issuedAt",
    );
  });

  it("rejects a policy before its issuance time", () => {
    const result = validateSignedExecutionPolicyForClaim(temporalPolicy(), {
      claimedAt: "2026-07-19T09:59:59.999Z",
    });

    expect(result).toMatchObject({
      valid: false,
      errors: ["policy is not valid before issuedAt"],
    });
  });

  it("treats equality at issuedAt as valid", () => {
    expect(
      validateSignedExecutionPolicyForClaim(temporalPolicy(), {
        claimedAt: ISSUED_AT,
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects an expired policy", () => {
    const result = validateSignedExecutionPolicyForClaim(temporalPolicy(), {
      claimedAt: "2026-07-19T10:05:00.001Z",
    });

    expect(result).toMatchObject({
      valid: false,
      errors: ["policy is expired at claimedAt (expiresAt is exclusive)"],
    });
  });

  it("treats equality at expiresAt as expired", () => {
    const result = validateSignedExecutionPolicyForClaim(temporalPolicy(), {
      claimedAt: EXPIRES_AT,
    });

    expect(result).toMatchObject({
      valid: false,
      errors: ["policy is expired at claimedAt (expiresAt is exclusive)"],
    });
  });

  it("keeps legacy v1 policies structurally valid but fails closed for claims", () => {
    const catalog = buildCommandCatalog([
      { binary: "node", workdirPolicy: "checkout-only" },
    ]);
    const legacy = buildSignedExecutionPolicy(
      createDefaultResourcePolicy({ policyId: "legacy-policy" }),
      catalog,
    );

    expect(validateSignedExecutionPolicy(legacy)).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateSignedExecutionPolicyForClaim(legacy, { claimedAt: CLAIMED_AT }),
    ).toMatchObject({
      valid: false,
      errors: ["issuedAt and expiresAt are required for claim-time validation"],
    });
  });

  it("rejects a malformed deterministic claim-time input", () => {
    const result = validateSignedExecutionPolicyForClaim(temporalPolicy(), {
      claimedAt: "2026-07-19T10:02:00Z",
    });

    expect(result).toMatchObject({
      valid: false,
      errors: [
        "claimedAt must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)",
      ],
    });
  });
});
