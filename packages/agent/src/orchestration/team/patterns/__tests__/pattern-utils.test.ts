/**
 * Unit tests for pure utilities in pattern-utils.ts:
 *   - compactText
 *   - formatCompactedWorkspaceContext
 *   - mapSettledWithConcurrency
 */
import { describe, it, expect, vi } from "vitest";
import {
  compactText,
  formatCompactedWorkspaceContext,
  mapSettledWithConcurrency,
} from "../pattern-utils.js";
import { SharedWorkspace } from "../../team-workspace.js";
import type { ResolvedBlackboardContextPolicy } from "../pattern-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(
  overrides: Partial<ResolvedBlackboardContextPolicy> = {}
): ResolvedBlackboardContextPolicy {
  return {
    maxSerializedChars: 16_000,
    maxEntryChars: 4_000,
    overflowBehavior: "compact",
    ...overrides,
  };
}

async function makeWorkspace(
  entries: Record<string, string>
): Promise<SharedWorkspace> {
  const ws = new SharedWorkspace();
  for (const [key, value] of Object.entries(entries)) {
    await ws.set(key, value, "test");
  }
  return ws;
}

// ---------------------------------------------------------------------------
// compactText
// ---------------------------------------------------------------------------

describe("compactText", () => {
  it("returns value unchanged when length <= maxChars", () => {
    expect(compactText("hello", 10)).toBe("hello");
    expect(compactText("hello", 5)).toBe("hello");
  });

  it("returns value unchanged when length is exactly maxChars", () => {
    const s = "abcde";
    expect(compactText(s, 5)).toBe(s);
  });

  it("compacts a long string with head+marker+tail when budget allows", () => {
    const value = "A".repeat(200);
    const result = compactText(value, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain("[compacted: middle omitted");
  });

  it("marker is present only once in the compacted result", () => {
    const value = "X".repeat(500);
    const result = compactText(value, 150);
    const markerCount = (result.match(/\[compacted:/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  it("falls back to hard slice when maxChars <= marker.length + 2", () => {
    // The marker is ~60 chars; budget of 10 is well below threshold.
    const value = "Z".repeat(100);
    const result = compactText(value, 10);
    expect(result.length).toBeLessThanOrEqual(10);
    // No marker — hard slice path.
    expect(result).not.toContain("[compacted:");
  });

  it("head portion is ~60% of available space after marker", () => {
    const value = "A".repeat(300);
    const maxChars = 160;
    const result = compactText(value, maxChars);
    expect(result.length).toBeLessThanOrEqual(maxChars);
    // Head starts at the beginning of the original value.
    expect(result.startsWith("A")).toBe(true);
    // Tail ends with the original value's characters.
    expect(result.endsWith("A")).toBe(true);
  });

  it("handles empty string", () => {
    expect(compactText("", 10)).toBe("");
  });

  it("handles maxChars of 0 by returning empty or minimal output", () => {
    const result = compactText("hello world", 0);
    expect(result.length).toBeLessThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// formatCompactedWorkspaceContext
// ---------------------------------------------------------------------------

describe("formatCompactedWorkspaceContext", () => {
  it("returns heading-only for an empty workspace", async () => {
    const ws = await makeWorkspace({});
    const result = formatCompactedWorkspaceContext(ws, makePolicy());
    expect(result).toContain("## Shared Workspace");
  });

  it("includes a single entry that fits within the budget without compaction", async () => {
    const ws = await makeWorkspace({ note: "short note" });
    const result = formatCompactedWorkspaceContext(
      ws,
      makePolicy({ maxSerializedChars: 16_000, maxEntryChars: 4_000 })
    );
    expect(result).toContain("note");
    expect(result).toContain("short note");
    expect(result).not.toContain("[compacted:");
  });

  it("skips entries with empty/falsy values", async () => {
    const ws = await makeWorkspace({ present: "value", empty: "" });
    const result = formatCompactedWorkspaceContext(ws, makePolicy());
    expect(result).toContain("present");
    expect(result).not.toContain("### empty");
  });

  it("truncates the formatted output to maxSerializedChars when all entries overflow", async () => {
    const ws = await makeWorkspace({
      a: "A".repeat(200),
      b: "B".repeat(200),
    });
    const policy = makePolicy({
      maxSerializedChars: 50,
      maxEntryChars: 4_000,
      overflowBehavior: "compact",
    });
    const result = formatCompactedWorkspaceContext(ws, policy);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("compacts individual entries that exceed maxEntryChars", async () => {
    const ws = await makeWorkspace({ big: "X".repeat(500) });
    const policy = makePolicy({
      maxEntryChars: 100,
      maxSerializedChars: 16_000,
    });
    const result = formatCompactedWorkspaceContext(ws, policy);
    expect(result).toContain("big");
    // Entry was compacted to fit the per-entry budget.
    expect(result).toContain("[compacted:");
  });

  it("stops adding entries when remaining budget is exhausted", async () => {
    // First entry fills the budget; second should not appear.
    const ws = await makeWorkspace({
      first: "F".repeat(40),
      second: "S".repeat(40),
    });
    const policy = makePolicy({
      maxSerializedChars: 60,
      maxEntryChars: 4_000,
    });
    const result = formatCompactedWorkspaceContext(ws, policy);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("always starts the result with the workspace heading", async () => {
    const ws = await makeWorkspace({ x: "value" });
    const result = formatCompactedWorkspaceContext(ws, makePolicy());
    expect(result.startsWith("## Shared Workspace")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mapSettledWithConcurrency
// ---------------------------------------------------------------------------

describe("mapSettledWithConcurrency", () => {
  it("returns empty array for empty input", async () => {
    const result = await mapSettledWithConcurrency([], 5, async (x) => x);
    expect(result).toEqual([]);
  });

  it("handles a single fulfilled item", async () => {
    const result = await mapSettledWithConcurrency(["a"], 1, async (x) =>
      x.toUpperCase()
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: "fulfilled", value: "A" });
  });

  it("returns rejected result without throwing when a mapper rejects", async () => {
    const result = await mapSettledWithConcurrency(
      ["ok", "fail"],
      2,
      async (x) => {
        if (x === "fail") throw new Error("boom");
        return x;
      }
    );
    expect(result[0]).toMatchObject({ status: "fulfilled", value: "ok" });
    expect(result[1]).toMatchObject({ status: "rejected" });
    expect((result[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  });

  it("preserves input ordering in the result array", async () => {
    const items = [3, 1, 2];
    const result = await mapSettledWithConcurrency(
      items,
      3,
      async (x) => x * 10
    );
    const values = result.map(
      (r) => (r as PromiseFulfilledResult<number>).value
    );
    expect(values).toEqual([30, 10, 20]);
  });

  it("concurrency=1 runs items serially and preserves ordering", async () => {
    const order: number[] = [];
    await mapSettledWithConcurrency([1, 2, 3], 1, async (x) => {
      order.push(x);
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it("concurrency > items.length runs all items simultaneously", async () => {
    const started: number[] = [];
    const resolvers: Array<() => void> = [];

    // Kick off all items but don't resolve them immediately.
    const settled = mapSettledWithConcurrency(
      [1, 2, 3],
      100,
      (x) =>
        new Promise<number>((resolve) => {
          started.push(x);
          resolvers.push(() => resolve(x));
        })
    );

    // Give the event loop a tick to start all workers.
    await Promise.resolve();
    // All 3 should have started before any resolved.
    expect(started).toHaveLength(3);
    // Now resolve them all.
    resolvers.forEach((r) => r());
    await settled;
  });

  it("all-reject scenario: every result is rejected, call does not throw", async () => {
    const result = await mapSettledWithConcurrency(
      ["a", "b", "c"],
      2,
      async () => {
        throw new Error("always fails");
      }
    );
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.status === "rejected")).toBe(true);
  });

  it("mixed fulfilled and rejected items all appear in result at correct indices", async () => {
    const result = await mapSettledWithConcurrency(
      [0, 1, 2, 3],
      4,
      async (x) => {
        if (x % 2 !== 0) throw new Error(`odd: ${x}`);
        return x;
      }
    );
    expect(result[0]).toMatchObject({ status: "fulfilled", value: 0 });
    expect(result[1]).toMatchObject({ status: "rejected" });
    expect(result[2]).toMatchObject({ status: "fulfilled", value: 2 });
    expect(result[3]).toMatchObject({ status: "rejected" });
  });

  it("passes the item index as second argument to the mapper", async () => {
    const indices: number[] = [];
    await mapSettledWithConcurrency(["a", "b", "c"], 3, async (_item, idx) => {
      indices.push(idx);
    });
    expect(indices.sort()).toEqual([0, 1, 2]);
  });
});
