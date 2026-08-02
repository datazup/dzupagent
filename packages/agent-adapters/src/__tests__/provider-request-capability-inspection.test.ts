import { describe, expect, it } from "vitest";

import { CodexAdapter } from "../codex/codex-adapter.js";
import { inspectProviderRequestCapabilities } from "../provider-request-capability-inspection.js";

const packet7Requirements = {
  providerEnforcedIdempotency: true,
  restartLookupBy: ["idempotencyKey"] as const,
  stableIdentityLookup: true,
};

describe("provider request capability inspection", () => {
  it("rejects the current Codex route without credentials or provider effects", () => {
    const adapter = new CodexAdapter();
    const inspection = inspectProviderRequestCapabilities({
      providerId: "codex",
      capabilities: adapter.getCapabilities(),
      lookupMethodAvailable: typeof adapter.lookupProviderRequest === "function",
      requirements: packet7Requirements,
    });

    expect(inspection.qualification).toEqual({
      accepted: false,
      blockers: [
        "idempotency_not_accepted",
        "idempotency_not_provider_enforced",
        "required_lookup_key_unavailable",
      ],
    });
    expect(inspection.declaredCapabilities.restartLookup).toMatchObject({
      supported: true,
      lookupBy: ["sessionId"],
      stableIdentityLookupBy: ["sessionId"],
    });
    expect(inspection.effects).toEqual({
      credentialReads: 0,
      networkAttempts: 0,
      providerDispatches: 0,
      providerSpendUsd: 0,
    });
    expect(inspection.inspectionId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts only an exact capable declaration with a lookup implementation", () => {
    const inspection = inspectProviderRequestCapabilities({
      providerId: "capable-provider",
      capabilities: {
        supportsResume: true,
        supportsFork: false,
        supportsToolCalls: true,
        emitsToolCalls: true,
        executesToolLoop: true,
        supportsStreaming: true,
        supportsCostUsage: true,
        providerRequestCorrelation: {
          idempotencyKey: { accepted: true, enforcement: "provider" },
          restartLookup: {
            supported: true,
            lookupBy: ["responseId", "idempotencyKey", "requestId"],
          },
        },
      },
      lookupMethodAvailable: true,
      requirements: packet7Requirements,
    });

    expect(inspection.qualification).toEqual({ accepted: true, blockers: [] });
    expect(inspection.declaredCapabilities.idempotencyKey.providerEnforced).toBe(true);
    expect(inspection.declaredCapabilities.restartLookup.lookupBy).toEqual([
      "idempotencyKey",
      "requestId",
      "responseId",
    ]);
  });

  it("fails closed when a declaration lacks its lookup method", () => {
    const inspection = inspectProviderRequestCapabilities({
      providerId: "detached-provider",
      capabilities: {
        supportsResume: false,
        supportsFork: false,
        supportsToolCalls: false,
        emitsToolCalls: false,
        executesToolLoop: false,
        supportsStreaming: false,
        supportsCostUsage: false,
        providerRequestCorrelation: {
          idempotencyKey: { accepted: true, enforcement: "provider" },
          restartLookup: { supported: true, lookupBy: ["idempotencyKey", "requestId"] },
        },
      },
      lookupMethodAvailable: false,
      requirements: packet7Requirements,
    });

    expect(inspection.qualification).toEqual({
      accepted: false,
      blockers: ["restart_lookup_unavailable"],
    });
  });
});
