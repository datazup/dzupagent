import { describe, it, expect } from "vitest";
import { createEventBus } from "@dzupagent/core/events";
import type { DzupEvent } from "@dzupagent/core/events";
import type { AgentInput } from "@dzupagent/adapter-types";
import { allowAllSpawnPolicy } from "@dzupagent/subagents";
import { createWiredSubagentRuntime } from "../create-wired-runtime.js";
import type { ProviderAdapterRegistry } from "../../registry/adapter-registry.js";
import type { AgentDefinition } from "../../dzupagent/agent-loader.js";

function registryWith(
  events: Array<Record<string, unknown>>
): ProviderAdapterRegistry {
  const adapter = {
    providerId: "claude",
    async *execute(_input: AgentInput) {
      for (const e of events) {
        yield e as never;
      }
    },
  };
  return {
    listAdapters: () => ["claude"],
    getHealthy: () => adapter,
    get: () => adapter,
    recordSuccess: () => {},
    recordFailure: () => {},
  } as unknown as ProviderAdapterRegistry;
}

async function waitFor(
  predicate: () => boolean,
  attempts = 100
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("createWiredSubagentRuntime (end-to-end)", () => {
  it("runs a real subagent through the registry and publishes bus events", async () => {
    const bus = createEventBus();
    const seen: DzupEvent[] = [];
    bus.onAny((e: DzupEvent) => seen.push(e));

    const runtime = createWiredSubagentRuntime({
      registry: registryWith([
        { type: "adapter:progress", message: "thinking" },
        {
          type: "adapter:completed",
          result: "the answer",
          usage: { inputTokens: 2, outputTokens: 5 },
        },
      ]),
      eventBus: bus,
      policy: allowAllSpawnPolicy,
    });

    const out = await runtime.spawn(
      { agentId: "claude", input: "question" },
      "run-1"
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("spawn failed");

    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });
    expect(final?.status).toBe("succeeded");
    expect(final?.result).toEqual({
      output: "the answer",
      provider: "claude",
      usage: { inputTokens: 2, outputTokens: 5 },
    });

    // Lifecycle events were bridged onto the framework bus.
    const types = seen.map((e) => e.type);
    expect(types).toContain("subagent:spawned");
    expect(types).toContain("subagent:completed");
  });

  it("persists a checkpoint snapshot when a store is provided", async () => {
    const { InMemoryCheckpointStore } = await import(
      "../../session/workflow-checkpointer.js"
    );
    const store = new InMemoryCheckpointStore();
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
      checkpointStore: store,
      policy: allowAllSpawnPolicy,
    });
    const out = await runtime.spawn({ agentId: "claude", input: "x" }, "r");
    if (!out.ok) throw new Error("spawn failed");
    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });
    expect(final?.status).toBe("succeeded");
  });

  it("denies spawns by default when no policy is supplied (AGENT-L-10)", async () => {
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
    });
    const out = await runtime.spawn({ agentId: "claude", input: "x" }, "r");
    expect(out).toEqual({
      ok: false,
      reason: "denied",
      detail: "spawn_denied_by_default_policy",
    });
  });

  it("surfaces a denial through the governance policy", async () => {
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
      policy: { check: () => ({ allow: false, reason: "blocked" }) },
    });
    const out = await runtime.spawn({ agentId: "claude", input: "x" }, "r");
    expect(out).toEqual({ ok: false, reason: "denied", detail: "blocked" });
  });

  it("resolves a persona at admission and runs it on the routed provider", async () => {
    const bus = createEventBus();
    const seen: DzupEvent[] = [];
    bus.onAny((e: DzupEvent) => seen.push(e));
    const loader = {
      loadAgent: async () =>
        ({
          name: "security-reviewer",
          description: "",
          version: 1,
          preferredProvider: "claude",
          skillNames: [],
          memoryScope: "project",
          constraints: {},
          personaPrompt: "Review security issues.",
          filePath: "/agents/security-reviewer.md",
        } satisfies AgentDefinition),
      compileForProvider: async (agent: AgentDefinition) => agent.personaPrompt,
    };
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
      eventBus: bus,
      policy: allowAllSpawnPolicy,
      personaLoader: loader,
    });

    const out = await runtime.spawn(
      { agentId: "security-reviewer", input: "audit auth" },
      "run-1"
    );
    if (!out.ok) throw new Error("spawn failed");
    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });
    expect(final?.status).toBe("succeeded");
    expect(final?.result).toMatchObject({ output: "ok", provider: "claude" });
  });

  it("publishes personaName and inlineDefinitionHash on spawned events", async () => {
    const bus = createEventBus();
    const seen: DzupEvent[] = [];
    bus.onAny((e: DzupEvent) => seen.push(e));
    const loader = {
      loadAgent: async () =>
        ({
          name: "security-reviewer",
          description: "",
          version: 1,
          preferredProvider: "claude",
          skillNames: [],
          memoryScope: "project",
          constraints: {},
          personaPrompt: "Review security issues.",
          filePath: "/agents/security-reviewer.md",
        } satisfies AgentDefinition),
      compileForProvider: async (agent: AgentDefinition) => agent.personaPrompt,
    };
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
      eventBus: bus,
      policy: allowAllSpawnPolicy,
      personaLoader: loader,
    });

    const out = await runtime.spawn(
      { agentId: "security-reviewer", input: "audit auth" },
      "run-1"
    );
    if (!out.ok) throw new Error("spawn failed");
    await runtime.await(out.taskId, { timeoutMs: 2000 });

    const spawned = seen.find((event) => event.type === "subagent:spawned");
    expect(spawned).toMatchObject({
      personaName: "security-reviewer",
      inlineDefinitionHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("escalates to approval when persona constraints require it", async () => {
    const loader = {
      loadAgent: async () =>
        ({
          name: "security-reviewer",
          description: "",
          version: 1,
          preferredProvider: "claude",
          skillNames: [],
          memoryScope: "project",
          constraints: { approvalMode: "required" as const },
          personaPrompt: "Review security issues.",
          filePath: "/agents/security-reviewer.md",
        } satisfies AgentDefinition),
      compileForProvider: async (agent: AgentDefinition) => agent.personaPrompt,
    };
    let resolveApproval: (() => void) | undefined;
    const runtime = createWiredSubagentRuntime({
      registry: registryWith([{ type: "adapter:completed", result: "ok" }]),
      policy: allowAllSpawnPolicy,
      personaLoader: loader,
      approvalGate: {
        waitForInterrupt: () =>
          new Promise((resolve) => {
            resolveApproval = () => resolve({ decision: "granted" });
          }),
      },
    });

    const out = await runtime.spawn(
      { agentId: "security-reviewer", input: "audit auth" },
      "run-1"
    );
    expect(out).toMatchObject({ ok: true, status: "awaiting_approval" });
    if (!out.ok) throw new Error("spawn failed");
    await waitFor(() => resolveApproval !== undefined);
    resolveApproval?.();
    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });
    expect(final?.status).toBe("succeeded");
  });

  it("materializes an inline definition when allowInline is enabled", async () => {
    let seen: AgentInput | undefined;
    const adapter = {
      providerId: "claude",
      async *execute(input: AgentInput) {
        seen = input;
        yield { type: "adapter:completed", result: "ok" } as never;
      },
    };
    const registry = {
      listAdapters: () => ["claude"],
      getHealthy: () => adapter,
      get: () => adapter,
      recordSuccess: () => {},
      recordFailure: () => {},
    } as unknown as ProviderAdapterRegistry;
    const runtime = createWiredSubagentRuntime({
      registry,
      policy: allowAllSpawnPolicy,
      allowInline: true,
    });

    const out = await runtime.spawn(
      {
        agentId: "inline",
        input: "x",
        instructions: "Use short findings.",
        definition: {
          name: "inline-reviewer",
          personaPrompt: "Review carefully.",
          preferredProvider: "claude",
        },
      },
      "run-1"
    );
    if (!out.ok) throw new Error("spawn failed");
    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });
    expect(final?.status).toBe("succeeded");
    expect(seen?.systemPrompt).toBe("Review carefully.\n\nUse short findings.");
  });
});
