import { describe, expect, it } from "vitest";

import {
  isNativeResumeAdmittedV2,
  isProviderCatalogSnapshotSelectableV2,
  validateProviderCatalogSnapshotV2,
  validateProviderSessionObservationV2,
  type ProviderCapabilitySupport,
  type ProviderCatalogSnapshotV2,
  type ProviderSessionExplorerKnownProviderId,
  type ProviderSessionObservationV2,
  type SessionContinuationMode,
} from "@dzupagent/adapter-types/provider-session-explorer";

import { getProviderCapabilities } from "../provider-catalog.js";

const EVALUATED_AT = new Date("2026-08-18T10:00:00.000Z");

interface ProviderCase {
  readonly providerId: ProviderSessionExplorerKnownProviderId;
  readonly support: ProviderCapabilitySupport;
  readonly continuation: SessionContinuationMode;
  readonly nativeResumeAdmitted: boolean;
}

const PROVIDERS: readonly ProviderCase[] = [
  { providerId: "codex", support: "supported", continuation: "native_resume", nativeResumeAdmitted: true },
  { providerId: "claude", support: "supported", continuation: "native_resume", nativeResumeAdmitted: true },
  { providerId: "gemini", support: "supported", continuation: "native_resume", nativeResumeAdmitted: true },
  { providerId: "qwen", support: "supported", continuation: "native_resume", nativeResumeAdmitted: true },
  { providerId: "goose", support: "unsupported", continuation: "unsupported", nativeResumeAdmitted: false },
  { providerId: "crush", support: "unknown", continuation: "unknown", nativeResumeAdmitted: false },
];

function fixtureCatalog(input: ProviderCase): ProviderCatalogSnapshotV2 {
  const selectable = input.support === "supported";
  return {
    schemaVersion: "codev/provider-catalog/v2",
    providerId: input.providerId,
    installationId: `installation_${input.providerId}_fixture`,
    backendId: `backend_${input.providerId}_fixture`,
    source: "agent_adapter_conformance_fixture",
    observedAt: "2026-08-18T09:00:00.000Z",
    expiresAt: "2026-08-18T11:00:00.000Z",
    fingerprint: `sha256:${input.providerId.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
    authenticated: selectable,
    completeness: selectable ? "runtime" : "partial",
    confidence: selectable ? "observed" : "unverified",
    models: selectable
      ? [
          {
            modelId: `${input.providerId}_fixture_model`,
            displayName: "Provider observed fixture model",
            isDefault: true,
            efforts: [
              {
                effortId: `${input.providerId}_fixture_effort`,
                displayName: "Provider observed fixture effort",
                nativeValue: "fixture_native_value",
                source: "agent_adapter_conformance_fixture",
                confidence: "observed",
              },
            ],
            defaultEffortId: `${input.providerId}_fixture_effort`,
          },
        ]
      : [],
    capabilities: {
      modelCatalog: {
        support: input.support,
        source: "agent_adapter_conformance_fixture",
        observedAt: "2026-08-18T09:00:00.000Z",
        expiresAt: "2026-08-18T11:00:00.000Z",
      },
      native_resume: {
        support: input.support,
        source: "agent_adapter_conformance_fixture",
        observedAt: "2026-08-18T09:00:00.000Z",
        expiresAt: "2026-08-18T11:00:00.000Z",
      },
    },
    warnings: selectable ? [] : ["Native resume is not qualified for this provider backend."],
  };
}

function fixtureObservation(input: ProviderCase): ProviderSessionObservationV2 {
  return {
    canonicalIdentity: {
      providerId: input.providerId,
      installationId: `installation_${input.providerId}_fixture`,
      backendId: `backend_${input.providerId}_fixture`,
      sessionId: `canonical_session_${input.providerId}_fixture`,
      ...(input.nativeResumeAdmitted
        ? { nativeSessionId: `native_reference_${input.providerId}_fixture` }
        : {}),
      sourceObservationIds: [`observation_${input.providerId}_fixture`],
    },
    observedAt: "2026-08-18T09:00:00.000Z",
    continuation: input.nativeResumeAdmitted
      ? {
          mode: "native_resume",
          reasonCode: "qualified_native_binding",
          explanation: "Qualified provider binding is available.",
          providerCapabilitySource: "agent_adapter_conformance_fixture",
          qualifiedVersion: "fixture_v1",
          bindingGeneration: 1,
          requiresFreshAuthorization: true,
        }
      : {
          mode: input.continuation,
          reasonCode: `provider_${input.continuation}`,
          explanation: "The provider backend does not expose qualified native resume.",
          requiresFreshAuthorization: true,
        },
  };
}

describe("Provider Session Explorer adapter conformance", () => {
  it.each(PROVIDERS)(
    "$providerId keeps framework capability truth aligned with shared continuation admission",
    (input) => {
      const catalog = fixtureCatalog(input);
      const observation = fixtureObservation(input);
      const frameworkResume =
        getProviderCapabilities(input.providerId)?.capabilityProfile.supportsResume === true;

      expect(validateProviderCatalogSnapshotV2(catalog)).toEqual({ valid: true, diagnostics: [] });
      expect(validateProviderSessionObservationV2(observation)).toEqual({ valid: true, diagnostics: [] });
      expect(frameworkResume).toBe(input.nativeResumeAdmitted);
      expect(isProviderCatalogSnapshotSelectableV2(catalog, EVALUATED_AT)).toBe(
        input.nativeResumeAdmitted,
      );
      expect(isNativeResumeAdmittedV2(observation, catalog, EVALUATED_AT)).toBe(
        input.nativeResumeAdmitted,
      );
    },
  );

  it("denies native resume when the catalog belongs to another installation", () => {
    const input = PROVIDERS[0]!;
    const catalog = fixtureCatalog(input);
    const observation = fixtureObservation(input);

    expect(
      isNativeResumeAdmittedV2(
        observation,
        { ...catalog, installationId: "installation_other_fixture" },
        EVALUATED_AT,
      ),
    ).toBe(false);
  });
});
