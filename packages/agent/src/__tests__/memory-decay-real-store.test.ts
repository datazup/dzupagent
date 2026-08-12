/**
 * Real-store coverage for the memory decay sweep.
 *
 * The sweep previously read `_key` off records returned by `get()`. Records
 * carry no such field, so every entry was dropped and the sweep pruned
 * nothing. A spy-based `MemoryService` could not detect this: it only observes
 * that `get` was called, never that the resulting prune actually happened.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@langchain/langgraph";
import { MemoryService } from "@dzupagent/memory";
import { maybeWriteBackMemory } from "../agent/agent-finalizers.js";

const NS = "facts";
const SCOPE = { tenantId: "t1" };

/** A decay payload well below the prune threshold. */
const weakDecay = {
  strength: 0.001,
  accessCount: 0,
  lastAccessedAt: 0,
  createdAt: 0,
  halfLifeMs: 1,
};

describe("memory decay sweep (real store)", () => {
  it("prunes weak records from the namespace", async () => {
    const memory = new MemoryService(new InMemoryStore(), [
      { name: NS, scopeKeys: ["tenantId"], searchable: false },
    ]);

    for (const k of ["a", "b", "c"]) {
      await memory.put(NS, SCOPE, k, { text: k, _decay: { ...weakDecay } });
    }

    const before = await memory.getKeyed(NS, SCOPE);
    expect(before).toHaveLength(3);

    await maybeWriteBackMemory({
      agentId: "agent-1",
      content: "new observation",
      config: {
        memory,
        memoryNamespace: NS,
        memoryScope: SCOPE,
        memoryDecayThreshold: 1,
        // Disable the other fire-and-forget sweeps so this test isolates decay.
        memoryPolicy: { pruneFinalizer: false, consolidateFinalizer: false },
      },
    } as never);

    await vi.waitFor(async () => {
      const after = await memory.getKeyed(NS, SCOPE);
      expect(after.length).toBeLessThan(before.length);
    });
  });
});
