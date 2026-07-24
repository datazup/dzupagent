import { describe, expect, it, vi } from "vitest";
import {
  assessModelAvailability,
  discoverClaudeModels,
  discoverCodexModels,
  parseClaudeCliModelAliases,
} from "../model-discovery.js";

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
      capabilities: { thinking: { supported: true } },
    });
    expect(
      assessModelAvailability(catalog, "missing-model").status,
    ).toBe("unavailable");
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
      status: "provider-default",
      reason: "No model was pinned; selection remains owned by the provider runtime",
    });
  });
});
