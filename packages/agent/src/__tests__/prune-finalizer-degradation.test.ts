/**
 * MC-02 — the prune finalizer must report degraded sweeps.
 *
 * `MemoryPruner.prune()` is non-fatal by design: when the store's `search`
 * throws it returns zero counts plus `status: 'degraded'` and a structured
 * `degradations[]`. The consolidation finalizer already forwards those
 * degradations onto the event bus as `memory:error`; the prune finalizer
 * used to drop them, so a pruner whose store failed on every run looked
 * exactly like one that had nothing to prune.
 *
 * These tests pin both directions: a degraded sweep emits `memory:error`,
 * and a healthy sweep does not.
 */
import { describe, it, expect, vi } from "vitest";
import { maybeWriteBackMemory } from "../agent/agent-finalizers.js";
import type { DzupAgentConfig } from "../agent/agent-types.js";

type Rec = Record<string, unknown>;

/** Store satisfying isPrunerStore (search/put/delete all functions). */
class FakePrunerStore {
  putCalls: Array<{ ns: string[]; key: string }> = [];
  constructor(
    private readonly onSearch: () => Promise<Array<{ key: string; value: Rec }>>
  ) {}

  async put(ns: string[], key: string, _value: Rec): Promise<void> {
    this.putCalls.push({ ns, key });
  }

  async search(
    _ns: string[],
    _opts?: { limit?: number }
  ): Promise<Array<{ key: string; value: Rec }>> {
    return this.onSearch();
  }

  async get(_ns: string[], _key: string): Promise<{ value: Rec } | null> {
    return null;
  }

  async delete(_ns: string[], _key: string): Promise<boolean> {
    return true;
  }
}

function makeConfig(
  store: FakePrunerStore,
  emit: (e: unknown) => void
): DzupAgentConfig {
  return {
    id: "agent-test",
    name: "Test Agent",
    memoryNamespace: "test-ns",
    memoryScope: { tenant: "tenant-1" },
    memoryWriteBack: true,
    memory: { getStore: () => store, put: async () => undefined },
    eventBus: { emit },
    // Consolidation is a sibling fire-and-forget sweep; keep it off so the
    // only memory:error under test can come from the pruner.
    memoryPolicy: { pruneFinalizer: true, consolidateFinalizer: false },
  } as unknown as DzupAgentConfig;
}

/** Let the fire-and-forget `void runMemoryPruner(...)` chain settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("prune finalizer degradation reporting", () => {
  it("emits memory:error when the prune sweep degrades", async () => {
    const store = new FakePrunerStore(() =>
      Promise.reject(new Error("store offline"))
    );
    const events: Array<Record<string, unknown>> = [];
    const config = makeConfig(store, (e) =>
      events.push(e as Record<string, unknown>)
    );

    await maybeWriteBackMemory({
      agentId: "agent-test",
      content: "some content",
      config,
    });
    await flushMicrotasks();

    const errors = events.filter((e) => e["type"] === "memory:error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({
      type: "memory:error",
      agentId: "agent-test",
      namespace: "test-ns",
    });
    // The message must carry the failing operation and the underlying reason,
    // otherwise the event says "something broke" without saying what.
    expect(String(errors[0]?.["message"])).toContain("search");
    expect(String(errors[0]?.["message"])).toContain("store offline");
  });

  it("does not emit memory:error when the prune sweep is healthy", async () => {
    const store = new FakePrunerStore(async () => []);
    const events: Array<Record<string, unknown>> = [];
    const config = makeConfig(store, (e) =>
      events.push(e as Record<string, unknown>)
    );

    await maybeWriteBackMemory({
      agentId: "agent-test",
      content: "some content",
      config,
    });
    await flushMicrotasks();

    expect(events.filter((e) => e["type"] === "memory:error")).toEqual([]);
    // The write-back itself still reported success.
    expect(events.some((e) => e["type"] === "memory:written")).toBe(true);
  });
});
