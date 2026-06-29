import { describe, expect, it } from "vitest";
import {
  resolveProviderOrigin,
  isCrossFamily,
  type ResolverCatalogs,
  type ResolveInput,
} from "../index.js";

const catalogs: ResolverCatalogs = {
  providerOriginMap: {
    codex: { originKey: "openai:codex", modelOriginFamily: "openai" },
    claude: { originKey: "anthropic:claude", modelOriginFamily: "anthropic" },
    openrouter: {
      originKey: "openrouter:unknown",
      modelOriginFamily: "unknown",
    },
  },
  modelOriginCatalog: {
    "gpt-5-codex": { originKey: "openai:gpt", modelOriginFamily: "openai" },
  },
  resolverVersion: "resolver@1",
  catalogVersion: "catalog@2026-06-29",
};

const at = "2026-06-29T00:00:00.000Z";

describe("resolveProviderOrigin (MPCO P2)", () => {
  it("resolves a known provider to its origin-map family", () => {
    const input: ResolveInput = {
      executionProviderId: "claude",
      resolvedAt: at,
    };
    const r = resolveProviderOrigin(input, catalogs);
    expect(r.modelOriginFamily).toBe("anthropic");
    expect(r.originKey).toBe("anthropic:claude");
    expect(r.resolutionSource).toBe("origin-map");
    expect(r.resolverVersion).toBe("resolver@1");
    expect(r.catalogVersion).toBe("catalog@2026-06-29");
    expect(r.resolvedAt).toBe(at);
  });

  it("prefers the model catalog when a requestedModel is mapped", () => {
    const input: ResolveInput = {
      executionProviderId: "codex",
      requestedModel: "gpt-5-codex",
      resolvedAt: at,
    };
    const r = resolveProviderOrigin(input, catalogs);
    expect(r.originKey).toBe("openai:gpt");
    expect(r.modelOriginFamily).toBe("openai");
    expect(r.resolutionSource).toBe("model-catalog");
    expect(r.resolvedModelId).toBe("gpt-5-codex");
  });

  it("fails closed to unknown for an unmapped provider", () => {
    const input: ResolveInput = {
      executionProviderId: "goose",
      resolvedAt: at,
    };
    const r = resolveProviderOrigin(input, catalogs);
    expect(r.modelOriginFamily).toBe("unknown");
    expect(r.resolutionSource).toBe("unmapped");
    expect(r.resolutionConfidence).toBe(0);
  });

  // T8: cross-family enforcement
  it("T8a: blocks same-family proposer+critic", () => {
    const a = resolveProviderOrigin(
      { executionProviderId: "codex", resolvedAt: at },
      catalogs,
    );
    const b = resolveProviderOrigin(
      { executionProviderId: "codex", resolvedAt: at },
      catalogs,
    );
    expect(isCrossFamily(a, b)).toBe(false);
  });

  it("T8b: allows different known families", () => {
    const a = resolveProviderOrigin(
      { executionProviderId: "codex", resolvedAt: at },
      catalogs,
    );
    const b = resolveProviderOrigin(
      { executionProviderId: "claude", resolvedAt: at },
      catalogs,
    );
    expect(isCrossFamily(a, b)).toBe(true);
  });

  it('T8c: unknown family is never "different" — fails closed', () => {
    const known = resolveProviderOrigin(
      { executionProviderId: "claude", resolvedAt: at },
      catalogs,
    );
    const unknown = resolveProviderOrigin(
      { executionProviderId: "openrouter", resolvedAt: at },
      catalogs,
    );
    expect(isCrossFamily(known, unknown)).toBe(false);
  });

  // T14: purity / determinism
  it("T14: same inputs + catalogs produce a deep-equal ProviderResolution", () => {
    const input: ResolveInput = {
      executionProviderId: "claude",
      resolvedAt: at,
    };
    const first = resolveProviderOrigin(input, catalogs);
    const second = resolveProviderOrigin(input, catalogs);
    expect(second).toEqual(first);
  });
});
