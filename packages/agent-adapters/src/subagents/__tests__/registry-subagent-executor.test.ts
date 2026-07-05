import { describe, it, expect, vi } from "vitest";
import type { AgentInput } from "@dzupagent/adapter-types";
import { RegistrySubagentExecutor } from "../registry-subagent-executor.js";
import type { ProviderAdapterRegistry } from "../../registry/adapter-registry.js";
import type { AgentDefinition } from "../../dzupagent/agent-loader.js";

/** Minimal adapter that yields a scripted event stream. */
function fakeAdapter(
  events: Array<Record<string, unknown>>,
  capture?: (input: AgentInput) => void,
  providerId = "claude",
) {
  return {
    providerId,
    async *execute(input: AgentInput) {
      capture?.(input);
      for (const e of events) {
        yield e as never;
      }
    },
  };
}

/** A registry stub exposing only what the executor uses. */
function fakeRegistry(
  adapter: unknown,
  adapters: Record<string, unknown> = { claude: adapter },
): {
  registry: ProviderAdapterRegistry;
  recordSuccess: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
} {
  const recordSuccess = vi.fn();
  const recordFailure = vi.fn();
  const registry = {
    listAdapters: () => Object.keys(adapters),
    getHealthy: (providerId: string) => adapters[providerId],
    get: (providerId: string) => adapters[providerId],
    getForTask: () => {
      const providerId = Object.keys(adapters)[0]!;
      return {
        adapter: adapters[providerId],
        decision: { provider: providerId, reason: "test", confidence: 1 },
      };
    },
    recordSuccess,
    recordFailure,
  } as unknown as ProviderAdapterRegistry;
  return { registry, recordSuccess, recordFailure };
}

function fakeAgentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "security-reviewer",
    description: "Reviews security concerns.",
    version: 1,
    preferredProvider: "codex" as never,
    skillNames: [],
    memoryScope: "project",
    constraints: {},
    personaPrompt: "Review for security issues.",
    filePath: "/agents/security-reviewer.md",
    ...overrides,
  };
}

const ctx = () => ({ taskId: "t1", signal: new AbortController().signal });

describe("RegistrySubagentExecutor", () => {
  it("maps a completed stream to a SubagentResult and records success", async () => {
    const adapter = fakeAdapter([
      { type: "adapter:message", content: "working" },
      {
        type: "adapter:completed",
        result: "final answer",
        usage: { inputTokens: 3, outputTokens: 10 },
      },
    ]);
    const { registry, recordSuccess } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);

    const result = await exec.run({ agentId: "claude", input: "do it" }, ctx());
    expect(result).toEqual({
      output: "final answer",
      provider: "claude",
      usage: { inputTokens: 3, outputTokens: 10 },
    });
    expect(recordSuccess).toHaveBeenCalledWith("claude");
  });

  it("returns the provider id that executed a direct provider subagent", async () => {
    const adapter = fakeAdapter(
      [{ type: "adapter:completed", result: "ok" }],
      undefined,
      "codex",
    );
    const { registry } = fakeRegistry(adapter, { codex: adapter });
    const exec = new RegistrySubagentExecutor(registry);

    const result = await exec.run(
      {
        agentId: "codex",
        input: "audit repo-a",
      },
      ctx(),
    );

    expect(result).toMatchObject({
      output: "ok",
      provider: "codex",
    });
  });

  it("returns the routed provider id for a persona subagent", async () => {
    const adapter = fakeAdapter(
      [{ type: "adapter:completed", result: "reviewed" }],
      undefined,
      "claude",
    );
    const agent = fakeAgentDefinition({
      preferredProvider: "claude" as never,
    });
    const loader = {
      loadAgent: vi.fn(async () => agent),
      compileForProvider: vi.fn(async () => "compiled security prompt"),
    };
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry, {}, { loader });

    const result = await exec.run(
      {
        agentId: "security-reviewer",
        input: "audit repo-a",
      },
      ctx(),
    );

    expect(result).toMatchObject({
      output: "reviewed",
      provider: "claude",
    });
  });

  it("forwards progress events to onProgress", async () => {
    const adapter = fakeAdapter([
      { type: "adapter:progress", message: "step 1" },
      { type: "adapter:completed", result: "done" },
    ]);
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);
    const notes: string[] = [];

    await exec.run(
      { agentId: "claude", input: "x" },
      {
        taskId: "t1",
        signal: new AbortController().signal,
        onProgress: (n) => notes.push(n),
      },
    );
    expect(notes).toContain("step 1");
  });

  it("throws and records failure when the stream fails with no result", async () => {
    const adapter = fakeAdapter([
      { type: "adapter:failed", error: "provider exploded" },
    ]);
    const { registry, recordFailure } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);

    await expect(
      exec.run({ agentId: "claude", input: "x" }, ctx()),
    ).rejects.toThrow("provider exploded");
    expect(recordFailure).toHaveBeenCalled();
  });

  it("passes the abort signal into AgentInput", async () => {
    let seen: AgentInput | undefined;
    const adapter = fakeAdapter(
      [{ type: "adapter:completed", result: "ok" }],
      (input) => {
        seen = input;
      },
    );
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);
    const signal = new AbortController().signal;

    await exec.run({ agentId: "claude", input: "x" }, { taskId: "t1", signal });
    expect(seen?.signal).toBe(signal);
  });

  it("serialises object input to a JSON prompt", async () => {
    let seen: AgentInput | undefined;
    const adapter = fakeAdapter(
      [{ type: "adapter:completed", result: "ok" }],
      (input) => {
        seen = input;
      },
    );
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);

    await exec.run({ agentId: "claude", input: { task: "survey" } }, ctx());
    expect(seen?.prompt).toBe(JSON.stringify({ task: "survey" }));
  });

  it("keeps provider id resolution ahead of same-named personas", async () => {
    let seen: AgentInput | undefined;
    const adapter = fakeAdapter(
      [{ type: "adapter:completed", result: "ok" }],
      (input) => {
        seen = input;
      },
    );
    const loader = {
      loadAgent: vi.fn(async () => fakeAgentDefinition({ name: "claude" })),
      compileForProvider: vi.fn(async () => "persona prompt"),
    };
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry, {}, { loader });

    await exec.run({ agentId: "claude", input: "x" }, ctx());

    expect(loader.loadAgent).not.toHaveBeenCalled();
    expect(seen?.systemPrompt).toBeUndefined();
  });

  it("resolves agent ids through the persona loader when no provider id matches", async () => {
    let seen: AgentInput | undefined;
    const claude = fakeAdapter([{ type: "adapter:completed", result: "ok" }]);
    const codex = fakeAdapter(
      [{ type: "adapter:completed", result: "ok" }],
      (input) => {
        seen = input;
      },
      "codex",
    );
    const agent = fakeAgentDefinition();
    const loader = {
      loadAgent: vi.fn(async () => agent),
      compileForProvider: vi.fn(async () => "Compiled persona prompt."),
    };
    const { registry, recordSuccess } = fakeRegistry(claude, { claude, codex });
    const exec = new RegistrySubagentExecutor(registry, {}, { loader });

    await exec.run(
      {
        agentId: "security-reviewer",
        input: "audit auth",
        instructions: "Focus on token handling.",
      },
      ctx(),
    );

    expect(loader.loadAgent).toHaveBeenCalledWith("security-reviewer");
    expect(loader.compileForProvider).toHaveBeenCalledWith(agent, "codex");
    expect(seen?.systemPrompt).toBe(
      "Compiled persona prompt.\n\nFocus on token handling.",
    );
    expect(recordSuccess).toHaveBeenCalledWith("codex");
  });

  it("rejects inline definitions unless allowInline is enabled", async () => {
    const adapter = fakeAdapter([{ type: "adapter:completed", result: "ok" }]);
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry);

    await expect(
      exec.run(
        {
          agentId: "inline",
          input: "x",
          definition: {
            name: "inline-reviewer",
            personaPrompt: "Review carefully.",
          },
        },
        ctx(),
      ),
    ).rejects.toThrow("Inline subagent definitions are disabled");
  });

  it("materializes inline definitions when allowInline is enabled", async () => {
    let seen: AgentInput | undefined;
    const adapter = fakeAdapter(
      [{ type: "adapter:completed", result: "ok" }],
      (input) => {
        seen = input;
      },
    );
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry, {}, { allowInline: true });

    await exec.run(
      {
        agentId: "inline",
        input: "x",
        instructions: "Use short findings.",
        definition: {
          name: "inline-reviewer",
          personaPrompt: "Review carefully.",
          preferredProvider: "claude",
          constraints: {
            maxBudgetUsd: 1,
            approvalMode: "required",
            networkPolicy: "off",
            toolPolicy: "strict",
          },
        },
      },
      ctx(),
    );

    expect(seen?.systemPrompt).toBe("Review carefully.\n\nUse short findings.");
    expect(seen?.maxBudgetUsd).toBe(1);
    expect(seen?.policyContext?.activePolicy).toMatchObject({
      approvalRequired: true,
      networkAccess: false,
      maxBudgetUsd: 1,
      toolPolicy: "strict",
    });
  });

  it("projects persona constraints into provider-specific input options and conformance warnings", async () => {
    let seen: AgentInput | undefined;
    const adapter = fakeAdapter(
      [{ type: "adapter:completed", result: "ok" }],
      (input) => {
        seen = input;
      },
      "codex",
    );
    const { registry } = fakeRegistry(adapter, { codex: adapter });
    const exec = new RegistrySubagentExecutor(registry, {}, { allowInline: true });

    await exec.run(
      {
        agentId: "inline",
        input: "x",
        definition: {
          name: "codex-inline",
          personaPrompt: "Use the CLI safely.",
          preferredProvider: "codex",
          constraints: {
            maxBudgetUsd: 1,
            networkPolicy: "off",
            toolPolicy: "strict",
          },
        },
      },
      ctx(),
    );

    expect(seen?.options).toMatchObject({
      networkAccessEnabled: false,
      toolPolicy: "strict",
    });
    expect(seen?.policyContext?.projectedGuardrails).toMatchObject({
      maxCostCents: 100,
    });
    expect(seen?.policyContext?.conformanceWarnings).toEqual(
      [expect.stringContaining("maxBudgetUsd")],
    );
  });

  it("preserves balanced toolPolicy in policy transport without fabricating native enforcement", async () => {
    let seen: AgentInput | undefined;
    const adapter = fakeAdapter(
      [{ type: "adapter:completed", result: "ok" }],
      (input) => {
        seen = input;
      },
      "claude",
    );
    const { registry } = fakeRegistry(adapter, { claude: adapter });
    const exec = new RegistrySubagentExecutor(registry, {}, { allowInline: true });

    await exec.run(
      {
        agentId: "inline",
        input: "x",
        definition: {
          name: "tool-balanced",
          personaPrompt: "Use normal tools.",
          preferredProvider: "claude",
          constraints: {
            toolPolicy: "balanced",
          },
        },
      },
      ctx(),
    );

    expect(seen?.options).toMatchObject({ toolPolicy: "balanced" });
    expect(seen?.policyContext?.activePolicy).toMatchObject({
      toolPolicy: "balanced",
    });
    expect(seen?.policyContext?.conformanceWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("toolPolicy")]),
    );
    expect(seen?.policyContext?.projectedGuardrails).toBeUndefined();
  });

  it("throws when the provider is not registered", async () => {
    const registry = {
      listAdapters: () => ["claude"],
      getHealthy: () => undefined,
      get: () => undefined,
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    } as unknown as ProviderAdapterRegistry;
    const exec = new RegistrySubagentExecutor(registry);
    await expect(
      exec.run({ agentId: "ghost", input: "x" }, ctx()),
    ).rejects.toThrow(/provider adapter, persona, or inline definition/);
  });

  // ── AGENT-M-05: output-token budget ceiling ────────────────────────
  it("aborts and records failure when output tokens exceed maxOutputTokens", async () => {
    const adapter = fakeAdapter([
      {
        type: "adapter:completed",
        result: "way too long",
        usage: { inputTokens: 1, outputTokens: 5000 },
      },
    ]);
    const { registry, recordFailure } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry, {
      maxOutputTokens: 100,
    });

    await expect(
      exec.run({ agentId: "claude", input: "x" }, ctx()),
    ).rejects.toMatchObject({ code: "TOKEN_LIMIT_EXCEEDED" });
    expect(recordFailure).toHaveBeenCalled();
  });

  it("allows a run whose output tokens stay within the budget", async () => {
    const adapter = fakeAdapter([
      {
        type: "adapter:completed",
        result: "ok",
        usage: { inputTokens: 1, outputTokens: 50 },
      },
    ]);
    const { registry } = fakeRegistry(adapter);
    const exec = new RegistrySubagentExecutor(registry, {
      maxOutputTokens: 100,
    });
    const result = await exec.run({ agentId: "claude", input: "x" }, ctx());
    expect(result.output).toBe("ok");
  });

  // ── AGENT-L-11: per-run timeout ────────────────────────────────────
  it("aborts a run that exceeds its per-run timeout", async () => {
    // An adapter whose stream stalls (never yields) until the run signal aborts.
    const stalling = {
      providerId: "claude",
      async *execute(input: AgentInput) {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) return resolve();
          input.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        // After the timeout fires the loop body re-checks the signal and throws.
        yield { type: "adapter:progress", message: "late" } as never;
      },
    };
    const { registry, recordFailure } = fakeRegistry(stalling);
    const exec = new RegistrySubagentExecutor(registry, { timeoutMs: 20 });

    await expect(
      exec.run({ agentId: "claude", input: "x" }, ctx()),
    ).rejects.toMatchObject({ code: "ADAPTER_TIMEOUT" });
    expect(recordFailure).toHaveBeenCalled();
  });
});
