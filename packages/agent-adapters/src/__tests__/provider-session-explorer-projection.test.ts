import { describe, expect, it } from "vitest";

import { isProviderCatalogSnapshotSelectableV2 } from "@dzupagent/adapter-types/provider-session-explorer";

import {
  projectProviderModelCatalogV2,
  type DiscoverableProviderId,
  type ProviderModelCatalog,
} from "../model-discovery.js";

const NOW = new Date("2026-08-18T10:00:00.000Z");

function discovery(providerId: DiscoverableProviderId): ProviderModelCatalog {
  return {
    schemaVersion: "dzupagent/provider-model-catalog/v1",
    providerId,
    source:
      providerId === "codex"
        ? "codex-app-server"
        : providerId === "claude"
          ? "claude-cli"
          : providerId === "gemini"
            ? "gemini-cli-acp"
            : providerId === "qwen"
              ? "qwen-cli-acp"
              : "crush-underlying-provider",
    completeness: "runtime-catalog",
    discoveredAt: "2026-08-18T09:00:00.000Z",
    authenticated: true,
    installationId: `installation_${providerId}_fixture`,
    backendId: `backend_${providerId}_fixture`,
    models: [
      {
        providerId,
        id: `${providerId}_observed_model`,
        displayName: `${providerId} observed model`,
        isDefault: true,
        defaultReasoningEffort: "observed_effort",
        supportedReasoningEfforts: ["observed_effort"],
      },
    ],
    warnings: [],
    fingerprint: `sha256:${providerId.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
  };
}

describe("provider discovery to shared catalog projection", () => {
  it.each(["codex", "claude", "gemini", "qwen", "crush"] as const)(
    "projects %s discovery without inventing model or effort ids",
    (providerId) => {
      const source = discovery(providerId);
      const projected = projectProviderModelCatalogV2(source, {
        expiresAt: "2026-08-18T11:00:00.000Z",
      });

      expect(projected).not.toBeNull();
      expect(projected?.models[0]?.modelId).toBe(source.models[0]?.id);
      expect(projected?.models[0]?.efforts[0]?.nativeValue).toBe("observed_effort");
      expect(projected?.capabilities.native_resume?.support).toBe("unknown");
      expect(isProviderCatalogSnapshotSelectableV2(projected, NOW)).toBe(true);
    },
  );

  it("projects only explicit provider-default and control capability evidence", () => {
    const source = {
      ...discovery("crush"),
      providerDefaultExecution: {
        qualifiedVersion: "crush-profile-v1",
        underlyingProviderId: "claude" as const,
      },
    };
    const projected = projectProviderModelCatalogV2(source, {
      expiresAt: "2026-08-18T11:00:00.000Z",
      controlCapabilities: {
        interactions: { support: "supported", qualifiedVersion: "crush-0.19" },
        streaming: { support: "unknown" },
        cancellation: { support: "supported", qualifiedVersion: "crush-0.19" },
      },
    });

    expect(projected?.capabilities.provider_default_execution).toMatchObject({
      support: "supported",
      qualifiedVersion: "crush-profile-v1",
      constraints: { underlyingProviderId: "claude" },
    });
    expect(projected?.capabilities.interactions?.support).toBe("supported");
    expect(projected?.capabilities.streaming?.support).toBe("unknown");
    expect(projected?.capabilities.cancellation?.support).toBe("supported");
  });

  it("fails closed without installation identity or with unsafe public warnings", () => {
    const source = discovery("codex");
    expect(
      projectProviderModelCatalogV2(
        { ...source, installationId: undefined },
        { expiresAt: "2026-08-18T11:00:00.000Z" },
      ),
    ).toBeNull();
    expect(
      projectProviderModelCatalogV2(
        { ...source, warnings: ["Authorization: Bearer synthetic-secret"] },
        { expiresAt: "2026-08-18T11:00:00.000Z" },
      ),
    ).toBeNull();
  });
});
