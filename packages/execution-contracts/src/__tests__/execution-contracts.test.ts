import { describe, expect, it } from "vitest";

import {
  FLEET_GATEWAY_CORRELATION_RECEIPT_SCHEMA,
  UnsupportedEnforcementDriver,
  buildCommandCatalog,
  buildSignedExecutionPolicy,
  createDefaultResourcePolicy,
  createEgressPolicy,
  sealFleetGatewayCorrelationReceipt,
  sealIsolationReceipt,
  validateCommand,
  validateSignedExecutionPolicy,
  verifyFleetGatewayCorrelationReceipt,
  verifyIsolationReceipt,
  type HostCapabilities,
} from "../index.js";

const capabilities: HostCapabilities = {
  cgroupsV2: true,
  namespaces: true,
  ulimits: true,
  processGroups: true,
};

describe("execution contracts", () => {
  it("seals and validates a resource policy and command catalog", () => {
    const catalog = buildCommandCatalog([
      { binary: "yarn", allowedArgs: ["test"], workdirPolicy: "checkout-only" },
    ]);
    const signed = buildSignedExecutionPolicy(
      createDefaultResourcePolicy({ policyId: "execution-1", wallTimeSec: 60 }),
      catalog,
    );

    expect(validateSignedExecutionPolicy(signed)).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateCommand("yarn", ["test"], "/checkout", {}, catalog, "/checkout"),
    ).toEqual({ allowed: true });
    expect(
      validateCommand("bash", [], "/checkout", {}, catalog, "/checkout"),
    ).toMatchObject({
      allowed: false,
      reason: "UNKNOWN_BINARY",
    });
  });

  it("keeps egress default-deny and seals sanitized isolation evidence", () => {
    const egress = createEgressPolicy([
      { provider: "codex", label: "provider" },
    ]);
    expect(egress.checkAndRecord("codex", "2026-07-17T00:00:00.000Z")).toBe(
      "allow",
    );
    expect(egress.checkAndRecord("unknown", "2026-07-17T00:00:01.000Z")).toBe(
      "deny",
    );
    const catalog = buildCommandCatalog([
      { binary: "yarn", allowedArgs: ["test"], workdirPolicy: "checkout-only" },
    ]);
    const signed = buildSignedExecutionPolicy(
      createDefaultResourcePolicy({ policyId: "execution-1", wallTimeSec: 60 }),
      catalog,
    );
    const receipt = sealIsolationReceipt({
      executionId: "execution-1",
      policy: createDefaultResourcePolicy({ policyId: "execution-1" }),
      policySignature: signed.signature,
      catalogDigest: catalog.digest,
      hostCapabilities: capabilities,
      limitsApplied: ["process-groups"],
      limitsUnavailable: [],
      egressRecords: [...egress.getRecords()],
      forciblyTerminated: false,
      sessionStatePreserved: true,
      sealedAt: "2026-07-17T00:00:02.000Z",
    });

    expect(receipt.policySignature).toBe(signed.signature);
    expect(receipt.catalogDigest).toBe(catalog.digest);
    expect(verifyIsolationReceipt(receipt)).toBe(true);
    expect(
      verifyIsolationReceipt({ ...receipt, forciblyTerminated: true }),
    ).toBe(false);
    expect(
      verifyIsolationReceipt({ ...receipt, catalogDigest: "invalid" }),
    ).toBe(false);
    expect(() =>
      sealIsolationReceipt({
        ...receipt,
        policy: createDefaultResourcePolicy({ policyId: receipt.policyId }),
        policySignature: "",
      }),
    ).toThrow("ISOLATION_RECEIPT_POLICY_SIGNATURE_INVALID");
  });
});

describe("UnsupportedEnforcementDriver", () => {
  const driver = new UnsupportedEnforcementDriver();
  const policy = createDefaultResourcePolicy({ policyId: "test-1" });
  const caps: HostCapabilities = {
    cgroupsV2: false,
    namespaces: false,
    ulimits: false,
    processGroups: false,
  };

  it("apply() returns all 4 dimensions as unavailable", async () => {
    const results = await driver.apply({
      executionId: "ex-1",
      policy,
      capabilities: caps,
    });
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.outcome).toBe("unavailable");
    }
  });

  it("release() returns all 4 dimensions as unavailable", async () => {
    const results = await driver.release({
      executionId: "ex-1",
      forciblyTerminated: false,
    });
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.outcome).toBe("unavailable");
    }
  });

  it("never returns applied outcome on any dimension", async () => {
    const applyResults = await driver.apply({
      executionId: "ex-1",
      policy,
      capabilities: caps,
    });
    const releaseResults = await driver.release({
      executionId: "ex-1",
      forciblyTerminated: true,
    });
    for (const r of [...applyResults, ...releaseResults]) {
      expect(r.outcome).not.toBe("applied");
    }
  });

  it("each dimension name is a non-empty string", async () => {
    const applyResults = await driver.apply({
      executionId: "ex-1",
      policy,
      capabilities: caps,
    });
    const releaseResults = await driver.release({
      executionId: "ex-1",
      forciblyTerminated: false,
    });
    for (const r of [...applyResults, ...releaseResults]) {
      expect(typeof r.dimension).toBe("string");
      expect(r.dimension.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// X6b IsolationReceipt — Gateway correlation optional fields
// ---------------------------------------------------------------------------

describe("IsolationReceipt X6b Gateway correlation fields", () => {
  const FAKE_SIG = "a".repeat(64);
  const FAKE_DIGEST = "b".repeat(64);

  function baseParams() {
    const catalog = buildCommandCatalog([
      { binary: "yarn", allowedArgs: ["test"], workdirPolicy: "checkout-only" },
    ]);
    const signed = buildSignedExecutionPolicy(
      createDefaultResourcePolicy({ policyId: "x6b-1", wallTimeSec: 30 }),
      catalog,
    );
    return {
      executionId: "x6b-exec-1",
      policy: createDefaultResourcePolicy({
        policyId: "x6b-1",
        wallTimeSec: 30,
      }),
      policySignature: signed.signature,
      catalogDigest: catalog.digest,
      hostCapabilities: capabilities,
      limitsApplied: [],
      limitsUnavailable: [],
      egressRecords: [],
      forciblyTerminated: false,
      sessionStatePreserved: true,
      sealedAt: "2026-07-17T00:00:00.000Z",
    };
  }

  it("backward-compat: receipt without new fields seals and verifies", () => {
    const receipt = sealIsolationReceipt(baseParams());
    expect(verifyIsolationReceipt(receipt)).toBe(true);
    expect(receipt.gatewayAuditRef).toBeUndefined();
    expect(receipt.credentialRefDigest).toBeUndefined();
    expect(receipt.providerSessionRef).toBeUndefined();
    expect(receipt.fencingTokenRef).toBeUndefined();
  });

  it("seal changes when new optional fields are present", () => {
    const withoutFields = sealIsolationReceipt(baseParams());
    const withFields = sealIsolationReceipt({
      ...baseParams(),
      gatewayAuditRef: FAKE_SIG,
      credentialRefDigest: FAKE_DIGEST,
      providerSessionRef: "session-opaque-ref",
      fencingTokenRef: "fence0123456789ab",
    });
    expect(withFields.seal).not.toBe(withoutFields.seal);
  });

  it("verifyIsolationReceipt passes when all four new fields are present", () => {
    const receipt = sealIsolationReceipt({
      ...baseParams(),
      gatewayAuditRef: FAKE_SIG,
      credentialRefDigest: FAKE_DIGEST,
      providerSessionRef: "session-opaque-ref",
      fencingTokenRef: "fence0123456789ab",
    });
    expect(verifyIsolationReceipt(receipt)).toBe(true);
  });

  it("verifyIsolationReceipt fails when gatewayAuditRef is tampered", () => {
    const receipt = sealIsolationReceipt({
      ...baseParams(),
      gatewayAuditRef: FAKE_SIG,
      credentialRefDigest: FAKE_DIGEST,
      providerSessionRef: "session-opaque-ref",
      fencingTokenRef: "fence0123456789ab",
    });
    const tampered = { ...receipt, gatewayAuditRef: "tampered-value" };
    expect(verifyIsolationReceipt(tampered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// X6b FleetGatewayCorrelationReceipt
// ---------------------------------------------------------------------------

describe("FleetGatewayCorrelationReceipt", () => {
  function makeGatewayReceipt(
    overrides: Partial<
      Parameters<typeof sealFleetGatewayCorrelationReceipt>[0]
    > = {},
  ) {
    return sealFleetGatewayCorrelationReceipt({
      receiptId: "gw-corr-001",
      sealedAt: "2026-07-17T00:00:00.000Z",
      executionId: "exec-x6b-1",
      workerId: "worker-opaque-ref",
      executionFamily: "codev-assistant",
      verifiedCases: ["provider-free-receipt"],
      providerFree: true,
      migratedApi: true,
      ...overrides,
    });
  }

  it("returns correct schema and valid seal", () => {
    const receipt = makeGatewayReceipt();
    expect(receipt.schema).toBe(FLEET_GATEWAY_CORRELATION_RECEIPT_SCHEMA);
    expect(receipt.seal).toHaveLength(64);
    expect(receipt.providerFree).toBe(true);
    expect(receipt.migratedApi).toBe(true);
  });

  it("verifyFleetGatewayCorrelationReceipt passes for sealed receipt", () => {
    const receipt = makeGatewayReceipt();
    expect(verifyFleetGatewayCorrelationReceipt(receipt)).toBe(true);
  });

  it("verifyFleetGatewayCorrelationReceipt fails when verifiedCases is tampered", () => {
    const receipt = makeGatewayReceipt();
    const tampered = { ...receipt, verifiedCases: ["tampered"] };
    expect(verifyFleetGatewayCorrelationReceipt(tampered)).toBe(false);
  });

  it("contains no raw URLs or credentials", () => {
    const receipt = makeGatewayReceipt();
    const json = JSON.stringify(receipt);
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toMatch(/password|token|secret|credential/i);
  });
});
