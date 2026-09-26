import { describe, expect, it, vi } from "vitest";
import { assessProviderRouteSelection, discoverProviderRouteEvidence } from "../model-route-evidence.js";
import type { ProviderRouteBinding, ProviderRouteObservation } from "../model-discovery-types.js";

const at = "2026-09-26T08:00:00.000Z";
const until = "2026-09-26T08:01:00.000Z";
const now = () => new Date(at);
const cli: ProviderRouteBinding = { route: "codex-cli", sourceId: "installation-fixture", sourceRevision: "rev-1" };
const api: ProviderRouteBinding = { route: "openai-api", sourceId: "credential-fixture", sourceRevision: "rev-2" };

function observation(binding = cli): ProviderRouteObservation {
  return { binding, observedAt: at, expiresAt: until, installed: true,
    authenticated: true, healthy: true, version: "fixture-1",
    models: [{ modelId: "model-a", operation: binding.route === "codex-cli" ? "agent.run" : "chat.generate",
      support: "supported", providerDefaultSupported: true }] };
}
function page() {
  return { data: [{ id: "model-a", defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }], nextCursor: null };
}
function request(binding = cli, effort: string | null = "high") {
  return { binding, modelId: "model-a", operation: binding.route === "codex-cli" ? "agent.run" as const : "chat.generate" as const, effort };
}
const apiFetch = () => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model-a" }] })));

describe("bound provider route evidence", () => {
  it("qualifies an evidenced Codex model/operation/effort without a generation request", async () => {
    const loadCodexPage = vi.fn(async () => page());
    const fetch = vi.fn<typeof globalThis.fetch>();
    const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true,
      observation: observation(), cliPath: "/private/fixture-codex", env: { CODEX_HOME: "/private/profile" },
      dependencies: { loadCodexPage, fetch, now } });
    expect(evidence.schemaVersion).toBe("dzupagent/provider-route-evidence/v1");
    expect(evidence.providerId).toBe("codex");
    expect(evidence.source).toBe("codex-app-server");
    expect(evidence.facts).toEqual({ configured: true, installed: true, authenticated: true, healthy: true, modelCatalog: true });
    expect(evidence.models[0]?.supportedReasoningEfforts).toEqual(["low", "high"]);
    expect(assessProviderRouteSelection(evidence, request(), now()).qualified).toBe(true);
    expect(loadCodexPage).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(evidence)).not.toContain("/private/");
  });

  it.each(["installed", "authenticated", "healthy"] as const)("refuses explicit failed %s evidence before probing", async (fact) => {
    const loadCodexPage = vi.fn(async () => page());
    const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true,
      observation: { ...observation(), [fact]: false }, dependencies: { loadCodexPage, now } });
    expect(evidence.facts[fact]).toBe(false);
    expect(assessProviderRouteSelection(evidence, request(), now()).qualified).toBe(false);
    expect(loadCodexPage).not.toHaveBeenCalled();
  });

  it("does not treat a Codex model catalog as proof of CLI authentication or health", async () => {
    const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true,
      dependencies: { loadCodexPage: async () => page(), now } });
    expect(evidence.facts).toMatchObject({ installed: true, authenticated: null, healthy: null, modelCatalog: true });
    expect(assessProviderRouteSelection(evidence, request(), now()).qualified).toBe(false);
  });

  it("keeps OpenAI account evidence on its API route and leaves operation/effort unknown", async () => {
    const fetch = apiFetch();
    const loadCodexPage = vi.fn(async () => page());
    const evidence = await discoverProviderRouteEvidence({ binding: api, configured: true, apiKey: "fixture-key",
      dependencies: { fetch, loadCodexPage, now } });
    expect(evidence.providerId).toBe("openai");
    expect(evidence.binding).toEqual(api);
    expect(evidence.source).toBe("openai-models-api");
    expect(evidence.facts).toMatchObject({ authenticated: true, healthy: true, modelCatalog: true });
    expect(evidence.models[0]).toMatchObject({ supportedReasoningEfforts: null, operations: [] });
    expect(assessProviderRouteSelection(evidence, request(api), now()).qualified).toBe(false);
    expect(loadCodexPage).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/models");
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(JSON.stringify(evidence)).not.toContain("fixture-key");
  });

  it("accepts separately qualified API operations and efforts on that exact source", async () => {
    const proof = observation(api);
    proof.models![0]!.supportedReasoningEfforts = ["high"];
    const evidence = await discoverProviderRouteEvidence({ binding: api, configured: true, apiKey: "fixture-key",
      observation: proof, dependencies: { fetch: apiFetch(), now } });
    expect(assessProviderRouteSelection(evidence, request(api), now()).qualified).toBe(true);
    expect(assessProviderRouteSelection(evidence, request(api, "low"), now()).reasons).toContain("effort_unqualified");
    expect(assessProviderRouteSelection(evidence, request(cli), now()).reasons).toContain("binding_mismatch");
  });

  it("never treats key presence or a failed metadata request as authenticated evidence", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("private diagnostics", { status: 401 }));
    const evidence = await discoverProviderRouteEvidence({ binding: api, configured: true, apiKey: "fixture-key",
      dependencies: { fetch, now } });
    expect(evidence.facts).toMatchObject({ configured: true, authenticated: null, healthy: null, modelCatalog: false });
    expect(evidence.reasons).toEqual(["catalog_unavailable"]);
    expect(assessProviderRouteSelection(evidence, request(api), now()).qualified).toBe(false);
    expect(JSON.stringify(evidence)).not.toMatch(/fixture-key|private diagnostics/);
  });

  it("does not read ambient API keys for an unconfigured route", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-fixture-key");
    const fetch = apiFetch();
    const evidence = await discoverProviderRouteEvidence({ binding: api, configured: true, dependencies: { fetch, now } });
    expect(evidence.facts.configured).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fall back from a failed CLI catalog to the configured OpenAI API", async () => {
    const fetch = apiFetch();
    const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true, observation: observation(),
      env: { OPENAI_API_KEY: "fixture-key" }, dependencies: { fetch, now,
        loadCodexPage: async () => { throw new Error("/private/profile fixture-key"); } } });
    expect(evidence.providerId).toBe("codex");
    expect(evidence.reasons).toEqual(["catalog_unavailable"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(evidence)).not.toMatch(/private|fixture-key/);
  });

  it("refuses changed executable or credential revisions and mismatched route observations", async () => {
    const loadCodexPage = vi.fn(async () => page());
    for (const binding of [{ ...cli, sourceRevision: "changed-binary" }, api]) {
      const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true,
        observation: { ...observation(), binding }, dependencies: { loadCodexPage, now } });
      expect(evidence.reasons).toContain("observation_mismatch");
      expect(assessProviderRouteSelection(evidence, request(), now()).qualified).toBe(false);
    }
    expect(loadCodexPage).not.toHaveBeenCalled();
  });

  it("rejects stale/future observations before probing and expires a slow probe result", async () => {
    const loadCodexPage = vi.fn(async () => page());
    for (const times of [{ expiresAt: at }, { observedAt: until }, { expiresAt: "invalid" }]) {
      const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true,
        observation: { ...observation(), ...times }, dependencies: { loadCodexPage, now } });
      expect(evidence.reasons).toContain("observation_stale");
    }
    expect(loadCodexPage).not.toHaveBeenCalled();
    let clock = now();
    const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true, observation: observation(),
      dependencies: { now: () => clock, loadCodexPage: async () => { clock = new Date(until); return page(); } } });
    expect(assessProviderRouteSelection(evidence, request(), clock).reasons).toContain("evidence_stale");
  });

  it("checks model, operation, effort, provider default, source identity and expiry at selection", async () => {
    const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true, observation: observation(),
      dependencies: { loadCodexPage: async () => page(), now } });
    expect(assessProviderRouteSelection(evidence, { ...request(), modelId: "missing" }, now()).reasons).toContain("model_unlisted");
    expect(assessProviderRouteSelection(evidence, { ...request(), operation: "chat.generate" }, now()).reasons).toContain("operation_unqualified");
    expect(assessProviderRouteSelection(evidence, request(cli, "invented"), now()).reasons).toContain("effort_unqualified");
    expect(assessProviderRouteSelection(evidence, request(cli, null), now()).qualified).toBe(true);
    expect(assessProviderRouteSelection(evidence, { ...request(), binding: { ...cli, sourceId: "another-user" } }, now()).reasons).toContain("binding_mismatch");
    expect(assessProviderRouteSelection(evidence, { ...request(), binding: { ...cli, sourceRevision: "new" } }, now()).qualified).toBe(false);
    expect(assessProviderRouteSelection(evidence, request(), new Date(until)).reasons).toContain("evidence_stale");
  });

  it("keeps unknown efforts and unevidenced provider-default behavior unqualified", async () => {
    const proof = observation();
    proof.models![0]!.providerDefaultSupported = undefined;
    const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true, observation: proof,
      dependencies: { loadCodexPage: async () => ({ data: [{ id: "model-a" }], nextCursor: null }), now } });
    expect(evidence.models[0]?.supportedReasoningEfforts).toBeNull();
    expect(assessProviderRouteSelection(evidence, request(), now()).reasons).toContain("effort_unqualified");
    expect(assessProviderRouteSelection(evidence, request(cli, null), now()).reasons).toContain("effort_unqualified");
  });

  it("intersects CLI model efforts with qualified operation evidence", async () => {
    const proof = observation();
    proof.models![0]!.supportedReasoningEfforts = ["low", "invented"];
    const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true, observation: proof,
      dependencies: { loadCodexPage: async () => page(), now } });
    expect(assessProviderRouteSelection(evidence, request(), now()).qualified).toBe(false);
    expect(assessProviderRouteSelection(evidence, request(cli, "invented"), now()).qualified).toBe(false);
    expect(assessProviderRouteSelection(evidence, request(cli, "low"), now()).qualified).toBe(true);
  });

  it("omits hidden models and never exposes provider display names, capabilities or raw errors", async () => {
    const evidence = await discoverProviderRouteEvidence({ binding: cli, configured: true, observation: observation(),
      dependencies: { now, loadCodexPage: async () => ({ data: [
        { id: "model-a", displayName: "/private/profile", capabilities: { apiKey: "fixture-key" } },
        { id: "hidden", hidden: true }], nextCursor: null }) } });
    expect(evidence.models.map(model => model.modelId)).toEqual(["model-a"]);
    expect(JSON.stringify(evidence)).not.toMatch(/private|fixture-key|hidden/);
  });
});
