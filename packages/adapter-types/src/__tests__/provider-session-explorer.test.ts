import { describe, expect, it } from "vitest";

import {
  isNativeResumeAdmittedV2,
  isProviderCatalogSnapshotSelectableV2,
  validateProviderCatalogSnapshotV2,
  validateProviderSessionObservationV2,
  validateSessionContinuationDecision,
  type ProviderCatalogSnapshotV2,
  type ProviderSessionExplorerKnownProviderId,
  type ProviderSessionObservationV2,
  type SessionContinuationMode,
} from "../provider-session-explorer.js";

const NOW = new Date("2026-08-18T10:00:00.000Z");

function catalog(
  providerId: ProviderSessionExplorerKnownProviderId,
  support: "supported" | "unsupported" | "unknown" = "supported",
): ProviderCatalogSnapshotV2 {
  const selectable = support === "supported";
  return {
    schemaVersion: "codev/provider-catalog/v2",
    providerId,
    installationId: `installation_${providerId}_fixture`,
    backendId: `backend_${providerId}_fixture`,
    source: "static_provider_free_fixture",
    observedAt: "2026-08-18T09:00:00.000Z",
    expiresAt: "2026-08-18T11:00:00.000Z",
    fingerprint: `sha256:${providerId.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
    authenticated: selectable,
    completeness: selectable ? "runtime" : "partial",
    confidence: selectable ? "observed" : "unverified",
    models: selectable
      ? [
          {
            modelId: `${providerId}_observed_model`,
            displayName: `${providerId} observed model`,
            isDefault: true,
            efforts: [
              {
                effortId: `${providerId}_observed_effort`,
                displayName: "Provider observed effort",
                nativeValue: "provider_observed_value",
                source: "static_provider_free_fixture",
                confidence: "observed",
              },
            ],
            defaultEffortId: `${providerId}_observed_effort`,
          },
        ]
      : [],
    capabilities: {
      modelCatalog: {
        support,
        source: "static_provider_free_fixture",
        observedAt: "2026-08-18T09:00:00.000Z",
        expiresAt: "2026-08-18T11:00:00.000Z",
      },
      native_resume: {
        support,
        source: "static_provider_free_fixture",
        observedAt: "2026-08-18T09:00:00.000Z",
        expiresAt: "2026-08-18T11:00:00.000Z",
      },
    },
    warnings: selectable ? [] : ["Provider backend is not qualified for selection or resume."],
  };
}

function observation(
  providerId: ProviderSessionExplorerKnownProviderId,
  mode: SessionContinuationMode = "native_resume",
): ProviderSessionObservationV2 {
  return {
    canonicalIdentity: {
      providerId,
      installationId: `installation_${providerId}_fixture`,
      backendId: `backend_${providerId}_fixture`,
      sessionId: `canonical_session_${providerId}_fixture`,
      ...(mode === "native_resume" ? { nativeSessionId: `native_reference_${providerId}_fixture` } : {}),
      sourceObservationIds: [`observation_${providerId}_fixture`],
    },
    observedAt: "2026-08-18T09:00:00.000Z",
    continuation:
      mode === "native_resume"
        ? {
            mode,
            reasonCode: "qualified_native_binding",
            explanation: "Qualified provider binding is available.",
            providerCapabilitySource: "static_provider_free_fixture",
            qualifiedVersion: "fixture_v1",
            bindingGeneration: 1,
            requiresFreshAuthorization: true,
          }
        : {
            mode,
            reasonCode: `provider_${mode}`,
            explanation: "The provider backend does not expose qualified native resume.",
            requiresFreshAuthorization: true,
          },
  };
}

describe("provider-session explorer shared conformance", () => {
  it.each(["codex", "claude", "gemini", "qwen"] as const)(
    "accepts a fresh provider-observed %s catalog without inventing choices",
    (providerId) => {
      const fixture = catalog(providerId);
      expect(validateProviderCatalogSnapshotV2(fixture)).toEqual({ valid: true, diagnostics: [] });
      expect(isProviderCatalogSnapshotSelectableV2(fixture, NOW)).toBe(true);
      expect(isNativeResumeAdmittedV2(observation(providerId), fixture, NOW)).toBe(true);
      expect(fixture.models[0]?.modelId).toContain(providerId);
    },
  );

  it("keeps Goose explicitly unsupported and Crush unknown", () => {
    const goose = catalog("goose", "unsupported");
    const crush = catalog("crush", "unknown");

    expect(validateProviderCatalogSnapshotV2(goose).valid).toBe(true);
    expect(validateProviderCatalogSnapshotV2(crush).valid).toBe(true);
    expect(isProviderCatalogSnapshotSelectableV2(goose, NOW)).toBe(false);
    expect(isProviderCatalogSnapshotSelectableV2(crush, NOW)).toBe(false);
    expect(isNativeResumeAdmittedV2(observation("goose", "unsupported"), goose, NOW)).toBe(false);
    expect(isNativeResumeAdmittedV2(observation("crush", "unknown"), crush, NOW)).toBe(false);
    expect(goose.models).toEqual([]);
    expect(crush.models).toEqual([]);
  });

  it("fails closed on missing installation identity, stale evidence, and unsafe public data", () => {
    const baseline = catalog("codex");
    const { installationId: _omitted, ...missingInstallation } = baseline;
    const stale = {
      ...baseline,
      observedAt: "2026-08-18T07:00:00.000Z",
      expiresAt: "2026-08-18T08:00:00.000Z",
    };
    const unsafe = {
      ...baseline,
      models: [{ ...baseline.models[0]!, capabilityConstraints: { workspacePath: "redacted" } }],
    };

    expect(validateProviderCatalogSnapshotV2(missingInstallation).valid).toBe(false);
    expect(isProviderCatalogSnapshotSelectableV2(stale, NOW)).toBe(false);
    expect(validateProviderCatalogSnapshotV2(unsafe).valid).toBe(false);
    expect(isNativeResumeAdmittedV2(observation("codex"), stale, NOW)).toBe(false);
  });

  it("requires native identity and qualified fresh authorization for native resume", () => {
    const continuation = {
      mode: "native_resume",
      reasonCode: "qualified_native_binding",
      explanation: "Qualified provider binding is available.",
      providerCapabilitySource: "static_provider_free_fixture",
      qualifiedVersion: "fixture_v1",
      bindingGeneration: 1,
      requiresFreshAuthorization: true,
    } as const;
    const observation = {
      canonicalIdentity: {
        providerId: "codex",
        installationId: "installation_codex_fixture",
        backendId: "backend_codex_fixture",
        sessionId: "canonical_session_fixture",
        sourceObservationIds: ["observation_fixture"],
      },
      observedAt: "2026-08-18T09:00:00.000Z",
      continuation,
    };

    expect(validateSessionContinuationDecision(continuation).valid).toBe(true);
    expect(validateProviderSessionObservationV2(observation).valid).toBe(false);
    expect(isNativeResumeAdmittedV2(observation, catalog("codex"), NOW)).toBe(false);
    expect(
      validateSessionContinuationDecision({ ...continuation, requiresFreshAuthorization: false }).valid,
    ).toBe(false);
  });
});
