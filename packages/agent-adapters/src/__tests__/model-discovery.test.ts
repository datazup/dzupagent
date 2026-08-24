import { describe, expect, it, vi } from "vitest";
import {
  assessModelAvailability,
  discoverClaudeModels,
  discoverCodexModels,
  discoverCrushModels,
  discoverGeminiModels,
  discoverProviderModels,
  discoverQwenModels,
  parseAcpModelCatalogObservation,
  parseClaudeCliModelAliases,
} from "../model-discovery.js";
import {
  GEMINI_0_35_3_ACP_MODEL_RECORDING,
  QWEN_0_21_9_ACP_MODEL_RECORDING,
} from "./fixtures/model-discovery-acp-recordings.js";

const fixedNow = () => new Date("2026-07-24T00:00:00.000Z");

describe("provider model discovery", () => {
  it("discovers and fingerprints every paginated Codex app-server model", async () => {
    const loadCodexPage = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: "current-default",
            displayName: "Current Default",
            isDefault: true,
            hidden: false,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "high", description: "deep" },
            ],
            inputModalities: ["text", "image"],
          },
        ],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "current-fast",
            displayName: "Current Fast",
            isDefault: false,
            hidden: false,
            upgrade: "current-default",
          },
        ],
        nextCursor: null,
      });

    const catalog = await discoverCodexModels({
      dependencies: { loadCodexPage, now: fixedNow },
    });

    expect(loadCodexPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cursor: null, includeHidden: false }),
    );
    expect(loadCodexPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "page-2" }),
    );
    expect(catalog).toMatchObject({
      providerId: "codex",
      source: "codex-app-server",
      completeness: "runtime-catalog",
      authenticated: true,
      discoveredAt: "2026-07-24T00:00:00.000Z",
    });
    expect(catalog.models.map((model) => model.id)).toEqual([
      "current-default",
      "current-fast",
    ]);
    expect(catalog.models[0]).toMatchObject({
      isDefault: true,
      supportedReasoningEfforts: ["low", "high"],
      inputModalities: ["text", "image"],
    });
    expect(catalog.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const repeated = await discoverCodexModels({
      dependencies: {
        loadCodexPage: async () => ({
          data: [
            {
              id: "current-fast",
              displayName: "Current Fast",
              isDefault: false,
              hidden: false,
              upgrade: "current-default",
            },
            {
              id: "current-default",
              displayName: "Current Default",
              isDefault: true,
              hidden: false,
              defaultReasoningEffort: "low",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
              inputModalities: ["text", "image"],
            },
          ],
          nextCursor: null,
        }),
        now: () => new Date("2026-07-25T00:00:00.000Z"),
      },
    });
    expect(repeated.fingerprint).toBe(catalog.fingerprint);
  });

  it("falls back to the OpenAI Models API without claiming Codex compatibility", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "account-model",
              object: "model",
              created: 1_782_345_600,
              owned_by: "openai",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const catalog = await discoverCodexModels({
      apiKey: "test-key",
      dependencies: {
        loadCodexPage: async () => {
          throw new Error("local app-server unavailable");
        },
        fetch: fetchMock as typeof fetch,
        now: fixedNow,
      },
    });

    expect(catalog.source).toBe("openai-models-api");
    expect(catalog.models.map((model) => model.id)).toEqual(["account-model"]);
    expect(catalog.warnings).toContain(
      "OpenAI Models API availability does not by itself prove Codex runtime compatibility.",
    );
    expect(
      assessModelAvailability(catalog, "account-model").status,
    ).toBe("available");
    expect(
      assessModelAvailability(catalog, "missing-model").status,
    ).toBe("unverified");
  });

  it("paginates the Anthropic Models API and preserves capability metadata", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      const secondPage = url.includes("after_id=model-new");
      return new Response(
        JSON.stringify(
          secondPage
            ? {
                data: [
                  {
                    id: "model-fast",
                    display_name: "Model Fast",
                    created_at: "2026-01-01T00:00:00Z",
                    max_input_tokens: 200_000,
                    max_tokens: 64_000,
                    capabilities: {
                      structured_outputs: { supported: true },
                    },
                    type: "model",
                  },
                ],
                first_id: "model-fast",
                has_more: false,
                last_id: "model-fast",
              }
            : {
                data: [
                  {
                    id: "model-new",
                    display_name: "Model New",
                    created_at: "2026-07-01T00:00:00Z",
                    max_input_tokens: 1_000_000,
                    max_tokens: 128_000,
                    capabilities: {
                      effort: {
                        supported: true,
                        low: { supported: true },
                        medium: { supported: true },
                        high: { supported: false },
                        future: { supported: true },
                      },
                      thinking: { supported: true },
                    },
                    type: "model",
                  },
                ],
                first_id: "model-new",
                has_more: true,
                last_id: "model-new",
              },
        ),
        { status: 200 },
      );
    });

    const catalog = await discoverClaudeModels({
      source: "anthropic-api",
      apiKey: "test-key",
      dependencies: { fetch: fetchMock as typeof fetch, now: fixedNow },
    });

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain("limit=1000");
    expect(requestedUrls[1]).toContain("after_id=model-new");
    expect(catalog).toMatchObject({
      providerId: "claude",
      source: "anthropic-models-api",
      completeness: "account-catalog",
      authenticated: true,
    });
    expect(catalog.models.map((model) => model.id)).toEqual([
      "model-fast",
      "model-new",
    ]);
    expect(catalog.models.find((model) => model.id === "model-new")).toMatchObject({
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      supportedReasoningEfforts: ["future", "low", "medium"],
      capabilities: { thinking: { supported: true } },
    });
    expect(
      assessModelAvailability(catalog, "missing-model").status,
    ).toBe("unavailable");
  });

  it("resolves provider-maintained Claude aliases through Models Retrieve", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/v1/models/sonnet")) {
        return new Response(
          JSON.stringify({
            id: "claude-sonnet-current-version",
            display_name: "Claude Sonnet",
            created_at: "2026-07-01T00:00:00Z",
            max_input_tokens: 1_000_000,
            max_tokens: 128_000,
            capabilities: {
              structured_outputs: { supported: true },
            },
            type: "model",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "claude-sonnet-current-version",
              display_name: "Claude Sonnet",
              created_at: "2026-07-01T00:00:00Z",
              max_input_tokens: 1_000_000,
              max_tokens: 128_000,
              capabilities: {
                structured_outputs: { supported: true },
              },
              type: "model",
            },
          ],
          first_id: "claude-sonnet-current-version",
          has_more: false,
          last_id: "claude-sonnet-current-version",
        }),
        { status: 200 },
      );
    });

    const catalog = await discoverClaudeModels({
      source: "anthropic-api",
      apiKey: "test-key",
      resolveModelIds: ["sonnet"],
      dependencies: { fetch: fetchMock as typeof fetch, now: fixedNow },
    });

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toMatch(/\/v1\/models\/sonnet$/u);
    expect(catalog.models.find((model) => model.id === "sonnet")).toMatchObject({
      alias: true,
      canonicalId: "claude-sonnet-current-version",
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: { structured_outputs: { supported: true } },
    });
    expect(assessModelAvailability(catalog, "sonnet").status).toBe("available");
  });

  it("uses Claude CLI provider aliases when API credentials are absent", async () => {
    const runCommand = vi.fn(
      async (_command: string, args: readonly string[]) => {
        if (args[0] === "auth") return { stdout: "authenticated", stderr: "" };
        return {
          stdout: [
            "Options:",
            "  --model <model>  Model for the current session. Provide an alias",
            "                   for the latest model (e.g. 'fable', 'opus', or 'sonnet')",
            "                   or a model's full name (e.g. 'claude-fable-5').",
            "  --name <name>    Session name.",
          ].join("\n"),
          stderr: "",
        };
      },
    );

    const catalog = await discoverClaudeModels({
      env: {},
      dependencies: { runCommand, now: fixedNow },
    });

    expect(catalog).toMatchObject({
      source: "claude-cli",
      completeness: "aliases-only",
      authenticated: true,
    });
    expect(catalog.models.map((model) => model.id)).toEqual([
      "claude-fable-5",
      "fable",
      "opus",
      "sonnet",
    ]);
    expect(assessModelAvailability(catalog, "sonnet").status).toBe("available");
    expect(
      assessModelAvailability(catalog, "claude-model-not-in-help").status,
    ).toBe("unverified");
  });

  it("discovers a scoped Gemini runtime catalog from a recorded ACP observation", async () => {
    const loadCliCatalog = vi.fn(async () => ({
      stdout: GEMINI_0_35_3_ACP_MODEL_RECORDING,
      stderr: "",
      authenticated: true,
      sourceRevision: "0.35.3",
    }));

    const catalog = await discoverProviderModels("gemini", {
      sourceEvidence: {
        installationId: "installation-gemini-a",
        backendId: "gemini-cli",
      },
      dependencies: { loadCliCatalog, now: fixedNow },
    });

    expect(loadCliCatalog).toHaveBeenCalledWith({
      providerId: "gemini",
      cliPath: "gemini",
      timeoutMs: 10_000,
      sourceEvidence: {
        installationId: "installation-gemini-a",
        backendId: "gemini-cli",
      },
    });
    expect(catalog).toMatchObject({
      providerId: "gemini",
      source: "gemini-cli-acp",
      completeness: "runtime-catalog",
      authenticated: true,
      installationId: "installation-gemini-a",
      backendId: "gemini-cli",
      sourceRevision: "0.35.3",
    });
    expect(catalog.models.map((model) => model.id)).toEqual([
      "auto-gemini-2.5",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
    ]);
    expect(catalog.models.every((model) => model.isDefault !== true)).toBe(true);
    const defaultAssessment = assessModelAvailability(catalog);
    expect(defaultAssessment.status).toBe("unverified");
    expect(defaultAssessment).not.toHaveProperty("matchedModel");
  });

  it("discovers Qwen ACP model identity and observed token limits without static fallback", async () => {
    const catalog = await discoverQwenModels({
      sourceEvidence: {
        installationId: "installation-qwen-a",
        backendId: "qwen-cli",
        sourceRevision: "0.21.9",
      },
      dependencies: {
        loadCliCatalog: async () => ({
          stdout: QWEN_0_21_9_ACP_MODEL_RECORDING,
          stderr: "",
          authenticated: null,
          sourceRevision: "0.21.9",
        }),
        now: fixedNow,
      },
    });

    expect(catalog).toMatchObject({
      providerId: "qwen",
      source: "qwen-cli-acp",
      authenticated: null,
      installationId: "installation-qwen-a",
      backendId: "qwen-cli",
      sourceRevision: "0.21.9",
    });
    expect(catalog.models).toEqual([
      expect.objectContaining({
        id: "qwen3-coder-plus(qwen-oauth)",
        maxInputTokens: 1_000_000,
      }),
      expect.objectContaining({
        id: "qwen3-max-preview(qwen-oauth)",
        maxInputTokens: 262_144,
      }),
    ]);
    expect(
      assessModelAvailability(catalog, "static-registry-default").status,
    ).toBe("unavailable");
  });

  it("deduplicates identical ACP models and reasoning efforts", () => {
    const repeatedModel = {
      modelId: "observed-reasoning-model",
      name: "Observed Reasoning Model",
      _meta: {
        supportedReasoningEfforts: ["low", "high", "low"],
        defaultReasoningEffort: "low",
      },
    };
    const output = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        models: {
          currentModelId: "observed-reasoning-model",
          availableModels: [repeatedModel, repeatedModel],
        },
      },
    });

    expect(parseAcpModelCatalogObservation("gemini", output)).toEqual([
      expect.objectContaining({
        id: "observed-reasoning-model",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "high"],
      }),
    ]);
  });

  it("rejects malformed, ambiguous, and conflicting ACP catalog output", () => {
    expect(() => parseAcpModelCatalogObservation("gemini", "not-json")).toThrow(
      /malformed JSON/u,
    );
    expect(() =>
      parseAcpModelCatalogObservation(
        "gemini",
        `${GEMINI_0_35_3_ACP_MODEL_RECORDING}\n${GEMINI_0_35_3_ACP_MODEL_RECORDING}`,
      ),
    ).toThrow(/ambiguous model catalogs/u);
    expect(() =>
      parseAcpModelCatalogObservation(
        "qwen",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            models: {
              currentModelId: "same-model",
              availableModels: [
                { modelId: "same-model", name: "First" },
                { modelId: "same-model", name: "Conflicting" },
              ],
            },
          },
        }),
      ),
    ).toThrow(/conflicting duplicate model IDs/u);
  });

  it("fails closed when Gemini and Qwen have no injected catalog observation", async () => {
    await expect(discoverGeminiModels()).rejects.toThrow(
      "Gemini CLI catalog discovery requires an injected ACP catalog loader",
    );
    await expect(discoverQwenModels()).rejects.toThrow(
      "Qwen CLI catalog discovery requires an injected ACP catalog loader",
    );
  });

  it("fingerprints installation/backend scope and rejects revision conflicts", async () => {
    const discover = (installationId: string, sourceRevision = "0.35.3") =>
      discoverGeminiModels({
        sourceEvidence: {
          installationId,
          backendId: "gemini-cli",
          sourceRevision,
        },
        dependencies: {
          loadCliCatalog: async () => ({
            stdout: GEMINI_0_35_3_ACP_MODEL_RECORDING,
            stderr: "",
            sourceRevision: "0.35.3",
          }),
          now: fixedNow,
        },
      });

    const first = await discover("installation-gemini-a");
    const second = await discover("installation-gemini-b");
    expect(first.fingerprint).not.toBe(second.fingerprint);
    await expect(discover("installation-gemini-a", "0.34.0")).rejects.toThrow(
      "Configured and observed CLI source revisions do not match",
    );
  });

  it("rejects paths and endpoints as catalog source identity", async () => {
    const loadCliCatalog = vi.fn();
    await expect(
      discoverGeminiModels({
        sourceEvidence: {
          installationId: "https://catalog.invalid/installation",
          backendId: "gemini-cli",
        },
        dependencies: { loadCliCatalog },
      }),
    ).rejects.toThrow("catalog source installationId must be a safe opaque identifier");
    expect(loadCliCatalog).not.toHaveBeenCalled();
  });

  it("parses only the Claude --model help section", () => {
    expect(
      parseClaudeCliModelAliases(
        [
          "  --agent <agent>  Example 'not-a-model'",
          "  --model <model>  Alias 'sonnet' or full name 'claude-sonnet-current'.",
          "  --name <name>    Example 'also-not-a-model'",
        ].join("\n"),
      ).map((model) => model.id),
    ).toEqual(["sonnet", "claude-sonnet-current"]);
  });

  it("does not guess a default when the provider does not advertise one", () => {
    const aliases = parseClaudeCliModelAliases(
      "  --model <model>  Alias 'sonnet'.",
    );
    const catalog = {
      schemaVersion: "dzupagent/provider-model-catalog/v1" as const,
      providerId: "claude" as const,
      source: "claude-cli" as const,
      completeness: "aliases-only" as const,
      discoveredAt: "2026-07-24T00:00:00.000Z",
      authenticated: true,
      models: aliases,
      warnings: [],
      fingerprint: "sha256:test",
    };
    expect(assessModelAvailability(catalog)).toEqual({
      status: "unverified",
      reason:
        "No model was pinned and provider-default execution has no qualified capability evidence",
    });
  });

  it("discovers Crush compound model identities through its qualified underlying provider", async () => {
    const catalog = await discoverCrushModels({
      sourceEvidence: {
        installationId: "installation-crush-a",
        backendId: "crush-cli",
        sourceRevision: "0.19.0",
      },
      dependencies: {
        now: fixedNow,
        loadCrushProfile: async () => ({
          underlyingProviderId: "claude",
          authenticated: true,
          sourceRevision: "0.19.0",
          providerDefaultQualifiedVersion: "crush-0.19.0",
        }),
        discoverCrushUnderlyingProvider: async () => ({
          schemaVersion: "dzupagent/provider-model-catalog/v1",
          providerId: "claude",
          source: "claude-cli",
          completeness: "runtime-catalog",
          discoveredAt: fixedNow().toISOString(),
          authenticated: true,
          models: [
            {
              providerId: "claude",
              id: "claude-observed",
              displayName: "Claude Observed",
              supportedReasoningEfforts: ["low", "high"],
            },
          ],
          warnings: [],
          fingerprint: `sha256:${"a".repeat(64)}`,
        }),
      },
    });

    expect(catalog).toMatchObject({
      providerId: "crush",
      source: "crush-underlying-provider",
      installationId: "installation-crush-a",
      backendId: "crush-cli",
      providerDefaultExecution: {
        qualifiedVersion: "crush-0.19.0",
        underlyingProviderId: "claude",
      },
    });
    expect(catalog.models).toEqual([
      expect.objectContaining({
        providerId: "crush",
        id: "claude/claude-observed",
        supportedReasoningEfforts: ["low", "high"],
      }),
    ]);
    expect(assessModelAvailability(catalog).status).toBe("provider-default");
  });

  it("supports qualified Crush provider-default only and rejects inferred/static fallbacks", async () => {
    const common = {
      sourceEvidence: {
        installationId: "installation-crush-a",
        backendId: "crush-cli",
      },
      dependencies: {
        now: fixedNow,
        loadCrushProfile: async () => ({
          underlyingProviderId: "qwen" as const,
          authenticated: null,
          providerDefaultQualifiedVersion: "crush-profile-v1",
        }),
      },
    };
    const catalog = await discoverCrushModels(common);
    expect(catalog.models).toEqual([]);
    expect(catalog.completeness).toBe("provider-default");
    expect(assessModelAvailability(catalog)).toMatchObject({
      status: "provider-default",
    });
    expect(assessModelAvailability(catalog, "qwen/static-default").status).toBe(
      "unavailable",
    );

    await expect(
      discoverCrushModels({
        ...common,
        dependencies: {
          ...common.dependencies,
          loadCrushProfile: async () => ({ underlyingProviderId: "qwen" }),
        },
      }),
    ).rejects.toThrow(/did not provide a qualified underlying catalog/u);
  });

  it("cancels Crush discovery without retaining profile payloads", async () => {
    const controller = new AbortController();
    controller.abort(new Error("catalog refresh cancelled"));
    const loadCrushProfile = vi.fn();
    await expect(
      discoverCrushModels({
        signal: controller.signal,
        dependencies: { loadCrushProfile },
      }),
    ).rejects.toThrow("catalog refresh cancelled");
    expect(loadCrushProfile).not.toHaveBeenCalled();
  });

  it("redacts Crush loader failures and underlying warnings", async () => {
    await expect(
      discoverCrushModels({
        dependencies: {
          loadCrushProfile: async () => {
            throw new Error("/private/profile Authorization: Bearer secret");
          },
        },
      }),
    ).rejects.toThrow(/^Crush normalized profile discovery failed$/u);

    const catalog = await discoverCrushModels({
      dependencies: {
        loadCrushProfile: async () => ({ underlyingProviderId: "codex" }),
        discoverCrushUnderlyingProvider: async () => ({
          schemaVersion: "dzupagent/provider-model-catalog/v1",
          providerId: "codex",
          source: "codex-app-server",
          completeness: "runtime-catalog",
          discoveredAt: fixedNow().toISOString(),
          authenticated: true,
          models: [{ providerId: "codex", id: "observed", displayName: "Observed" }],
          warnings: ["/private/profile secret"],
          fingerprint: `sha256:${"b".repeat(64)}`,
        }),
      },
    });
    expect(catalog.warnings).toEqual([
      "Crush underlying catalog reported diagnostics; raw diagnostics were not retained.",
    ]);
  });
});
