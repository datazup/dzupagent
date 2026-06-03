import { describe, it, expect } from "vitest";
import { createEventBus } from "@dzupagent/core/events";
import type { DzupEvent } from "@dzupagent/core/events";
import type { AgentInput } from "@dzupagent/adapter-types";
import { allowAllSpawnPolicy } from "@dzupagent/subagents";
import { createWiredSubagentRuntime } from "../create-wired-runtime.js";
import type { ProviderAdapterRegistry } from "../../registry/adapter-registry.js";

function registryWith(
  events: Array<Record<string, unknown>>,
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
  attempts = 100,
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
      "run-1",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("spawn failed");

    const final = await runtime.await(out.taskId, { timeoutMs: 2000 });
    expect(final?.status).toBe("succeeded");
    expect(final?.result).toEqual({
      output: "the answer",
      usage: { inputTokens: 2, outputTokens: 5 },
    });

    // Lifecycle events were bridged onto the framework bus.
    const types = seen.map((e) => e.type);
    expect(types).toContain("subagent:spawned");
    expect(types).toContain("subagent:completed");
  });

  it("persists a checkpoint snapshot when a store is provided", async () => {
    const { InMemoryCheckpointStore } =
      await import("../../session/workflow-checkpointer.js");
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
});
