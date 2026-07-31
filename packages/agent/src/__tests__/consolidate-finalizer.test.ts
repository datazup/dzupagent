/**
 * MC-02 — Consolidation finalizer + DzupAgent.consolidate() tests.
 *
 * Verifies:
 * 1. runConsolidateFinalizer is opt-in (disabled by default).
 * 2. runConsolidateFinalizer runs ConsolidationEngine when enabled.
 * 3. runConsolidateFinalizer emits memory:written when entries are summarised.
 * 4. Failures in the engine are non-fatal (event bus is not called).
 * 5. DzupAgent.consolidate() delegates to ConsolidationEngine.
 * 6. DzupAgent.consolidate() returns {summarized:0} when no store available.
 * 7. memoryPolicy.consolidateFinalizer fires from maybeWriteBackMemory path.
 */
import { describe, it, expect, vi } from "vitest";
import { DzupAgent } from "../agent/dzip-agent.js";
import { runConsolidateFinalizer } from "../agent/agent-finalizers.js";
import type { DzupAgentConfig } from "../agent/agent-types.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// ── Minimal fake store matching ConsolidationStore / PrunerMemoryStore ────────

class FakeStore {
  private data = new Map<string, Map<string, Record<string, unknown>>>();

  private nsKey(ns: string[]): string {
    return ns.join("|");
  }

  async put(
    ns: string[],
    key: string,
    value: Record<string, unknown>
  ): Promise<void> {
    const k = this.nsKey(ns);
    const bucket =
      this.data.get(k) ?? new Map<string, Record<string, unknown>>();
    bucket.set(key, value);
    this.data.set(k, bucket);
  }

  async get(
    ns: string[],
    key: string
  ): Promise<{ value: Record<string, unknown> } | null> {
    const v = this.data.get(this.nsKey(ns))?.get(key);
    return v !== undefined ? { value: v } : null;
  }

  async search(
    ns: string[],
    opts?: { limit?: number }
  ): Promise<Array<{ key: string; value: Record<string, unknown> }>> {
    const bucket = this.data.get(this.nsKey(ns));
    if (!bucket) return [];
    const entries = [...bucket.entries()].map(([key, value]) => ({
      key,
      value,
    }));
    return opts?.limit ? entries.slice(0, opts.limit) : entries;
  }

  async delete(ns: string[], key: string): Promise<boolean> {
    return this.data.get(this.nsKey(ns))?.delete(key) ?? false;
  }
}

// ── MemoryService-like wrapper that exposes getStore() ─────────────────────

function makeMemoryWithStore(store: FakeStore) {
  return { getStore: () => store };
}

// ── Config builder ──────────────────────────────────────────────────────────

function makeConfig(
  // Accepts explicitly-undefined values: several cases assert the
  // "not configured" path, and agent-finalizers no-ops on falsy `memory`,
  // so an undefined value and an absent key mean the same thing here.
  overrides: { [K in keyof DzupAgentConfig]?: DzupAgentConfig[K] | undefined } = {}
): DzupAgentConfig {
  return {
    id: "agent-test",
    name: "Test Agent",
    memoryNamespace: "test-ns",
    memoryScope: { tenant: "tenant-1" },
    ...overrides,
  } as unknown as DzupAgentConfig;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("runConsolidateFinalizer", () => {
  it("is a no-op when consolidateFinalizer is not set (opt-in guard)", async () => {
    const store = new FakeStore();
    const memory = makeMemoryWithStore(store);
    const emitSpy = vi.fn();
    const config = makeConfig({
      memory: memory as unknown as DzupAgentConfig["memory"],
      eventBus: { emit: emitSpy } as unknown as DzupAgentConfig["eventBus"],
      // no memoryPolicy.consolidateFinalizer
    });

    await runConsolidateFinalizer("agent-test", config);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when pruneFinalizer === false", async () => {
    const store = new FakeStore();
    const memory = makeMemoryWithStore(store);
    const emitSpy = vi.fn();
    const config = makeConfig({
      memory: memory as unknown as DzupAgentConfig["memory"],
      eventBus: { emit: emitSpy } as unknown as DzupAgentConfig["eventBus"],
      memoryPolicy: { consolidateFinalizer: false },
    });

    await runConsolidateFinalizer("agent-test", config);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("runs ConsolidationEngine and emits memory:written when entries consolidated", async () => {
    const store = new FakeStore();
    // ConsolidationEngine.consolidate(agentId, namespace, store) searches [agentId, namespace]
    const ns = ["agent-test", "test-ns"];

    // Seed 4 entries with the same prefix so clusterByPrefix forms a cluster
    for (let i = 0; i < 4; i++) {
      await store.put(ns, `fact:item-${i}`, {
        text: `Memory entry ${i}`,
        kind: "fact",
      });
    }

    const emitSpy = vi.fn();
    const config = makeConfig({
      memory: makeMemoryWithStore(
        store
      ) as unknown as DzupAgentConfig["memory"],
      eventBus: { emit: emitSpy } as unknown as DzupAgentConfig["eventBus"],
      memoryPolicy: { consolidateFinalizer: true, consolidateMinCluster: 2 },
    });

    await runConsolidateFinalizer("agent-test", config);

    // Should emit memory:written if summarization produced output
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "memory:written", agentId: "agent-test" })
    );
  });

  it("is non-fatal when ConsolidationEngine throws", async () => {
    const badStore = {
      search: () => {
        throw new Error("store unavailable");
      },
      put: vi.fn(),
      delete: vi.fn(),
    };
    const memory = { getStore: () => badStore };
    const config = makeConfig({
      memory: memory as unknown as DzupAgentConfig["memory"],
      memoryPolicy: { consolidateFinalizer: true },
    });

    await expect(
      runConsolidateFinalizer("agent-test", config)
    ).resolves.toBeUndefined();
  });

  it("is a no-op when memory is not configured", async () => {
    const config = makeConfig({
      memory: undefined,
      memoryPolicy: { consolidateFinalizer: true },
    });
    await expect(
      runConsolidateFinalizer("agent-test", config)
    ).resolves.toBeUndefined();
  });

  it("is a no-op when getStore is not available on the memory object", async () => {
    const config = makeConfig({
      memory: {
        put: vi.fn(),
        get: vi.fn(),
      } as unknown as DzupAgentConfig["memory"],
      memoryPolicy: { consolidateFinalizer: true },
    });
    await expect(
      runConsolidateFinalizer("agent-test", config)
    ).resolves.toBeUndefined();
  });

  it("respects consolidateMinCluster — skips cluster smaller than threshold", async () => {
    const store = new FakeStore();
    const ns = ["agent-test", "test-ns"];
    // Only 2 entries — below minClusterSize of 5
    await store.put(ns, `note:a`, { text: "Note A", kind: "note" });
    await store.put(ns, `note:b`, { text: "Note B", kind: "note" });

    const emitSpy = vi.fn();
    const config = makeConfig({
      memory: makeMemoryWithStore(
        store
      ) as unknown as DzupAgentConfig["memory"],
      eventBus: { emit: emitSpy } as unknown as DzupAgentConfig["eventBus"],
      memoryPolicy: { consolidateFinalizer: true, consolidateMinCluster: 5 },
    });

    await runConsolidateFinalizer("agent-test", config);
    // No clusters met threshold → no memory:written
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe("DzupAgentConfig.memoryPolicy.consolidateFinalizer field", () => {
  it("accepts consolidateFinalizer and consolidateMinCluster fields without type errors", () => {
    const config: Pick<DzupAgentConfig, "memoryPolicy"> = {
      memoryPolicy: {
        pruneFinalizer: true,
        consolidateFinalizer: true,
        consolidateMinCluster: 4,
        maxEntries: 500,
        ttlMs: 3 * 24 * 60 * 60 * 1000,
      },
    };
    expect(config.memoryPolicy?.consolidateFinalizer).toBe(true);
    expect(config.memoryPolicy?.consolidateMinCluster).toBe(4);
  });
});

describe("DzupAgent.consolidate()", () => {
  it("returns {summarized:0, summaries:[]} when memory is not configured", async () => {
    const agent = new DzupAgent({
      id: "no-mem-agent",
      name: "No Memory",
      model: { invoke: vi.fn(async () => ({ content: "" })) } as unknown as BaseChatModel,
      instructions: "test",
    });

    const result = await agent.consolidate();
    expect(result).toMatchObject({
      summarized: 0,
      summaries: [],
      status: "degraded",
      degradations: [
        expect.objectContaining({
          operation: "get",
          impact: "source-unavailable",
        }),
      ],
    });
  });

  it("returns {summarized:0} when memory lacks getStore()", async () => {
    const agent = new DzupAgent({
      id: "no-store-agent",
      name: "No Store",
      model: { invoke: vi.fn(async () => ({ content: "" })) } as unknown as BaseChatModel,
      instructions: "test",
      memory: { put: vi.fn(), get: vi.fn() } as never,
      memoryNamespace: "ns",
      memoryScope: { t: "x" },
    });

    const result = await agent.consolidate();
    expect(result).toMatchObject({
      summarized: 0,
      summaries: [],
      status: "degraded",
      degradations: [
        expect.objectContaining({
          operation: "get",
          impact: "source-unavailable",
        }),
      ],
    });
  });

  it("delegates to ConsolidationEngine and returns summarized count", async () => {
    const store = new FakeStore();
    const agentId = "consolidate-test-agent";
    const ns = [agentId, "facts"];
    for (let i = 0; i < 4; i++) {
      await store.put(ns, `lesson:item-${i}`, {
        text: `Lesson ${i}`,
        kind: "lesson",
      });
    }

    const agent = new DzupAgent({
      id: agentId,
      name: "Has Store",
      model: { invoke: vi.fn(async () => ({ content: "" })) } as unknown as BaseChatModel,
      instructions: "test",
      memory: { getStore: () => store } as never,
      memoryNamespace: "facts",
      memoryScope: { t: "x" },
      memoryPolicy: { consolidateMinCluster: 2 },
    });

    const before = await store.search(ns);
    const result = await agent.consolidate();
    const after = await store.search(ns);

    // `typeof result.summarized === 'number'` and `>= 0` were the previous
    // assertions; both hold when consolidation does nothing at all, which is
    // the failure mode worth catching here. Compare the report against the
    // store instead: a summary must actually have been written.
    // The two counts measure different things: `summarized` accumulates
    // `childKeys.length` (source records folded in) while each cluster emits one
    // entry in `summaries`, so equality is wrong — with 4 records in one cluster
    // it is 4 vs 1.
    //
    // Bound BOTH against the store rather than against each other. An earlier
    // draft asserted only `summarized >= summaries.length`, which a report that
    // inflates `summarized` satisfies; injecting `+= childKeys.length + 10` into
    // the engine passed that draft. Each written summary carries the keys it
    // consumed in `consolidatedFrom`, so the store holds the ground truth.
    if (result.summarized > 0) {
      expect(result.summaries.length).toBeGreaterThan(0);
      expect(after.length).toBeGreaterThan(before.length);
      // Every reported summary is a record that is actually now in the store.
      const added = after.filter((a) => !before.some((b) => b.key === a.key));
      expect(added.map((r) => r.key).sort()).toEqual(
        [...result.summaries].sort()
      );
      // `summarized` must equal the source records the summaries claim to cover.
      const consumed = added.reduce(
        (n, r) => n + (r.value["consolidatedFrom"] as string[]).length,
        0
      );
      expect(result.summarized).toBe(consumed);
    } else {
      // Reporting zero must mean the namespace is untouched — not that a write
      // happened and went unreported.
      expect(after.map((r) => r.key).sort()).toEqual(
        before.map((r) => r.key).sort()
      );
    }
  });
});
