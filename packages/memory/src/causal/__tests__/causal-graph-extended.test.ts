/**
 * Extended tests for CausalGraph — causal link creation, traversal, influence
 * scoring, graph pruning, serialization, and edge cases.
 *
 * The base tests live in causal-graph.test.ts. This file adds 65+ additional
 * tests covering areas not exercised there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CausalGraph } from "../causal-graph.js";
import type { CausalRelation } from "../types.js";
import type { MemoryService } from "../../memory-service.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface PutCall {
  ns: string;
  scope: Record<string, string>;
  key: string;
  value: Record<string, unknown>;
}

type RecordStore = Map<string, Map<string, Record<string, unknown>>>;

function createMockMemoryService(): {
  service: MemoryService;
  putCalls: PutCall[];
  records: RecordStore;
} {
  const putCalls: PutCall[] = [];
  const records: RecordStore = new Map();

  const service = {
    put: vi
      .fn()
      .mockImplementation(
        (
          ns: string,
          scope: Record<string, string>,
          key: string,
          value: Record<string, unknown>,
        ) => {
          putCalls.push({ ns, scope, key, value });
          const nsKey = `${ns}:${JSON.stringify(scope)}`;
          if (!records.has(nsKey)) records.set(nsKey, new Map());
          records.get(nsKey)!.set(key, value);
          return Promise.resolve();
        },
      ),
    get: vi
      .fn()
      .mockImplementation(
        (ns: string, scope: Record<string, string>, key?: string) => {
          const nsKey = `${ns}:${JSON.stringify(scope)}`;
          const nsRecords = records.get(nsKey);
          if (!nsRecords) return Promise.resolve([]);
          if (key) {
            const val = nsRecords.get(key);
            return Promise.resolve(val ? [val] : []);
          }
          return Promise.resolve(Array.from(nsRecords.values()));
        },
      ),
    search: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue(""),
  } as unknown as MemoryService;

  return { service, putCalls, records };
}

const NS = "test-ns";

// ---------------------------------------------------------------------------
// Causal link creation — strength (confidence) and label (evidence)
// ---------------------------------------------------------------------------

describe("CausalGraph – link creation with strength and label", () => {
  let mock: ReturnType<typeof createMockMemoryService>;
  let graph: CausalGraph;

  beforeEach(() => {
    mock = createMockMemoryService();
    graph = new CausalGraph(mock.service);
  });

  it("stores confidence (strength) value exactly as provided", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.75,
    });
    expect(mock.putCalls[0]!.value["confidence"]).toBe(0.75);
  });

  it("stores evidence (label) string verbatim", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.8,
      evidence: "deployment caused outage",
    });
    expect(mock.putCalls[0]!.value["evidence"]).toBe(
      "deployment caused outage",
    );
  });

  it("stores link without evidence when not provided", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.6,
    });
    // evidence key should be absent or undefined
    const val = mock.putCalls[0]!.value;
    expect(val["evidence"] === undefined || val["evidence"] === null).toBe(
      true,
    );
  });

  it("persists cause, causeNamespace, effect, effectNamespace verbatim", async () => {
    await graph.addRelation({
      cause: "mem-001",
      causeNamespace: "lessons",
      effect: "bug-005",
      effectNamespace: "bugs",
      confidence: 0.9,
    });
    const val = mock.putCalls[0]!.value;
    expect(val["cause"]).toBe("mem-001");
    expect(val["causeNamespace"]).toBe("lessons");
    expect(val["effect"]).toBe("bug-005");
    expect(val["effectNamespace"]).toBe("bugs");
  });

  it("createdAt is a valid ISO 8601 timestamp", async () => {
    const before = new Date().toISOString();
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.5,
    });
    const after = new Date().toISOString();
    const ts = mock.putCalls[0]!.value["createdAt"] as string;
    expect(ts >= before).toBe(true);
    expect(ts <= after).toBe(true);
  });

  it("clamps confidence above 1 to exactly 1", async () => {
    await graph.addRelation({
      cause: "X",
      causeNamespace: NS,
      effect: "Y",
      effectNamespace: NS,
      confidence: 2.5,
    });
    expect(mock.putCalls[0]!.value["confidence"]).toBe(1.0);
  });

  it("clamps confidence below 0 to exactly 0", async () => {
    await graph.addRelation({
      cause: "X",
      causeNamespace: NS,
      effect: "Y",
      effectNamespace: NS,
      confidence: -1,
    });
    expect(mock.putCalls[0]!.value["confidence"]).toBe(0);
  });

  it("stores confidence of exactly 0", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0,
    });
    expect(mock.putCalls[0]!.value["confidence"]).toBe(0);
  });

  it("stores confidence of exactly 1", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 1,
    });
    expect(mock.putCalls[0]!.value["confidence"]).toBe(1);
  });

  it("uses composite key causeNs:cause->effectNs:effect", async () => {
    await graph.addRelation({
      cause: "mem1",
      causeNamespace: "ns1",
      effect: "mem2",
      effectNamespace: "ns2",
      confidence: 0.7,
    });
    expect(mock.putCalls[0]!.key).toBe("ns1:mem1->ns2:mem2");
  });

  it("uses __causal namespace for storage", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.5,
    });
    expect(mock.putCalls[0]!.ns).toBe("__causal");
  });
});

// ---------------------------------------------------------------------------
// Link retrieval
// ---------------------------------------------------------------------------

describe("CausalGraph – link retrieval", () => {
  let mock: ReturnType<typeof createMockMemoryService>;
  let graph: CausalGraph;

  beforeEach(() => {
    mock = createMockMemoryService();
    graph = new CausalGraph(mock.service);
  });

  it("retrieves confidence correctly from getRelations", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.77,
    });
    const node = await graph.getRelations("A", NS);
    expect(node.effects[0]!.confidence).toBe(0.77);
  });

  it("retrieves evidence correctly from getRelations", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.8,
      evidence: "test evidence",
    });
    const node = await graph.getRelations("A", NS);
    expect(node.effects[0]!.evidence).toBe("test evidence");
  });

  it("getRelations returns node key and namespace", async () => {
    const node = await graph.getRelations("myKey", "myNs");
    expect(node.key).toBe("myKey");
    expect(node.namespace).toBe("myNs");
  });

  it("getRelations distinguishes cause vs effect for node B in A->B->C", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.8,
    });

    const nodeB = await graph.getRelations("B", NS);
    expect(nodeB.causes).toHaveLength(1);
    expect(nodeB.effects).toHaveLength(1);
    expect(nodeB.causes[0]!.cause).toBe("A");
    expect(nodeB.effects[0]!.effect).toBe("C");
  });

  it("returns multiple outgoing links from a single node", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.8,
    });
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "D",
      effectNamespace: NS,
      confidence: 0.7,
    });

    const nodeA = await graph.getRelations("A", NS);
    expect(nodeA.effects).toHaveLength(3);
    const effectKeys = nodeA.effects.map((e) => e.effect).sort();
    expect(effectKeys).toEqual(["B", "C", "D"]);
  });

  it("returns multiple incoming links to a single node", async () => {
    await graph.addRelation({
      cause: "X",
      causeNamespace: NS,
      effect: "Z",
      effectNamespace: NS,
      confidence: 0.8,
    });
    await graph.addRelation({
      cause: "Y",
      causeNamespace: NS,
      effect: "Z",
      effectNamespace: NS,
      confidence: 0.7,
    });

    const nodeZ = await graph.getRelations("Z", NS);
    expect(nodeZ.causes).toHaveLength(2);
    const causeKeys = nodeZ.causes.map((c) => c.cause).sort();
    expect(causeKeys).toEqual(["X", "Y"]);
  });
});

// ---------------------------------------------------------------------------
// Bidirectional links — A->B and B->A stored independently
// ---------------------------------------------------------------------------

describe("CausalGraph – bidirectional links", () => {
  let mock: ReturnType<typeof createMockMemoryService>;
  let graph: CausalGraph;

  beforeEach(() => {
    mock = createMockMemoryService();
    graph = new CausalGraph(mock.service);
  });

  it("A->B and B->A are stored as separate records with distinct keys", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "A",
      effectNamespace: NS,
      confidence: 0.7,
    });

    expect(mock.putCalls).toHaveLength(2);
    expect(mock.putCalls[0]!.key).not.toBe(mock.putCalls[1]!.key);
    expect(mock.putCalls[0]!.key).toBe("test-ns:A->test-ns:B");
    expect(mock.putCalls[1]!.key).toBe("test-ns:B->test-ns:A");
  });

  it("A->B and B->A have independent confidence values", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "A",
      effectNamespace: NS,
      confidence: 0.3,
    });

    const nodeA = await graph.getRelations("A", NS);
    const nodeB = await graph.getRelations("B", NS);

    expect(nodeA.effects[0]!.confidence).toBe(0.9); // A->B
    expect(nodeB.effects[0]!.confidence).toBe(0.3); // B->A
  });

  it("A sees B in effects AND causes when both directions exist", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "A",
      effectNamespace: NS,
      confidence: 0.5,
    });

    const nodeA = await graph.getRelations("A", NS);
    expect(nodeA.effects).toHaveLength(1); // A->B
    expect(nodeA.causes).toHaveLength(1); // B->A causes A
    expect(nodeA.effects[0]!.effect).toBe("B");
    expect(nodeA.causes[0]!.cause).toBe("B");
  });

  it("removing A->B does not remove B->A", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "A",
      effectNamespace: NS,
      confidence: 0.5,
    });

    await graph.removeRelation("A", NS, "B", NS);

    const nodeA = await graph.getRelations("A", NS);
    const nodeB = await graph.getRelations("B", NS);

    // A->B removed, B->A still there
    expect(nodeA.effects).toHaveLength(0);
    expect(nodeB.effects).toHaveLength(1);
    expect(nodeB.effects[0]!.effect).toBe("A");
  });

  it("traversal in effects direction from A returns B only once even with bidirectional link", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "A",
      effectNamespace: NS,
      confidence: 0.5,
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    expect(result.nodes.filter((n) => n.key === "B")).toHaveLength(1);
    expect(result.nodes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeNode — node removal cascade
// ---------------------------------------------------------------------------

describe("CausalGraph – removeNode", () => {
  let mock: ReturnType<typeof createMockMemoryService>;
  let graph: CausalGraph;

  beforeEach(() => {
    mock = createMockMemoryService();
    graph = new CausalGraph(mock.service);
  });

  it("removeNode returns 0 for node with no relations", async () => {
    const count = await graph.removeNode("orphan", NS);
    expect(count).toBe(0);
  });

  it("removeNode removes all outgoing links", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.8,
    });

    const count = await graph.removeNode("A", NS);
    expect(count).toBe(2);

    const nodeA = await graph.getRelations("A", NS);
    expect(nodeA.effects).toHaveLength(0);
  });

  it("removeNode removes all incoming links", async () => {
    await graph.addRelation({
      cause: "X",
      causeNamespace: NS,
      effect: "Z",
      effectNamespace: NS,
      confidence: 0.8,
    });
    await graph.addRelation({
      cause: "Y",
      causeNamespace: NS,
      effect: "Z",
      effectNamespace: NS,
      confidence: 0.7,
    });

    const count = await graph.removeNode("Z", NS);
    expect(count).toBe(2);

    const nodeZ = await graph.getRelations("Z", NS);
    expect(nodeZ.causes).toHaveLength(0);
  });

  it("removeNode removes both incoming and outgoing links", async () => {
    // X -> B -> Y
    await graph.addRelation({
      cause: "X",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "Y",
      effectNamespace: NS,
      confidence: 0.8,
    });

    const count = await graph.removeNode("B", NS);
    expect(count).toBe(2);

    const nodeB = await graph.getRelations("B", NS);
    expect(nodeB.causes).toHaveLength(0);
    expect(nodeB.effects).toHaveLength(0);
  });

  it("after removeNode, other nodes lose their relations to removed node", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.8,
    });

    await graph.removeNode("B", NS);

    // A should have no effects to B anymore
    const nodeA = await graph.getRelations("A", NS);
    expect(nodeA.effects).toHaveLength(0);

    // C should have no causes from B anymore
    const nodeC = await graph.getRelations("C", NS);
    expect(nodeC.causes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Graph traversal — depth, order, extended scenarios
// ---------------------------------------------------------------------------

describe("CausalGraph – traversal extended", () => {
  let mock: ReturnType<typeof createMockMemoryService>;
  let graph: CausalGraph;

  beforeEach(() => {
    mock = createMockMemoryService();
    graph = new CausalGraph(mock.service);
  });

  it("maxDepth=0 returns empty nodes", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });

    const result = await graph.traverse("A", NS, {
      direction: "effects",
      maxDepth: 0,
    });
    expect(result.nodes).toHaveLength(0);
    expect(result.depth).toBe(0);
  });

  it("maxDepth=2 stops at 2 hops in chain A->B->C->D", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "C",
      causeNamespace: NS,
      effect: "D",
      effectNamespace: NS,
      confidence: 0.9,
    });

    const result = await graph.traverse("A", NS, {
      direction: "effects",
      maxDepth: 2,
    });
    const keys = result.nodes.map((n) => n.key).sort();
    expect(keys).toEqual(["B", "C"]);
    expect(result.nodes.find((n) => n.key === "D")).toBeUndefined();
  });

  it("default maxDepth=5 traverses up to 5 hops", async () => {
    // Chain: A->B->C->D->E->F->G (7 nodes, root A, 6 hops)
    const chain = ["A", "B", "C", "D", "E", "F", "G"];
    for (let i = 0; i < chain.length - 1; i++) {
      await graph.addRelation({
        cause: chain[i]!,
        causeNamespace: NS,
        effect: chain[i + 1]!,
        effectNamespace: NS,
        confidence: 0.9,
      });
    }

    const result = await graph.traverse("A", NS, { direction: "effects" });
    // Default maxDepth=5, so B through F are reachable (5 hops), G is at depth 6 and should be excluded
    const keys = result.nodes.map((n) => n.key);
    expect(keys).toContain("B");
    expect(keys).toContain("F");
    expect(keys).not.toContain("G");
  });

  it("depth-3 cycle A->B->C->A terminates correctly", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.8,
    });
    await graph.addRelation({
      cause: "C",
      causeNamespace: NS,
      effect: "A",
      effectNamespace: NS,
      confidence: 0.7,
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    // Should find B and C but not re-visit A
    const keys = result.nodes.map((n) => n.key).sort();
    expect(keys).toEqual(["B", "C"]);
    expect(result.nodes.filter((n) => n.key === "A")).toHaveLength(0);
  });

  it("self-loop A->A does not loop infinitely", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "A",
      effectNamespace: NS,
      confidence: 0.5,
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    // Root A is already visited, so no new nodes discovered
    expect(result.nodes).toHaveLength(0);
  });

  it("minConfidence=0 includes all links", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.01,
    });

    const result = await graph.traverse("A", NS, {
      direction: "effects",
      minConfidence: 0,
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.key).toBe("B");
  });

  it("minConfidence=1 only includes perfect-confidence links", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 1.0,
    });
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.99,
    });

    const result = await graph.traverse("A", NS, {
      direction: "effects",
      minConfidence: 1.0,
    });
    const keys = result.nodes.map((n) => n.key);
    expect(keys).toContain("B");
    expect(keys).not.toContain("C");
  });

  it("traverse result includes root node identity", async () => {
    const result = await graph.traverse("myRoot", "myNs", {
      direction: "both",
    });
    expect(result.root.key).toBe("myRoot");
    expect(result.root.namespace).toBe("myNs");
  });

  it("traverse result relations list is deduplicated in diamond", async () => {
    // A->B, A->C, B->D, C->D: D is reachable via two paths
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "D",
      effectNamespace: NS,
      confidence: 0.8,
    });
    await graph.addRelation({
      cause: "C",
      causeNamespace: NS,
      effect: "D",
      effectNamespace: NS,
      confidence: 0.8,
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    // 4 unique relations: A->B, A->C, B->D, C->D
    expect(result.relations).toHaveLength(4);
  });

  it("wide fan-out: A->B1...B10 all discovered", async () => {
    for (let i = 1; i <= 10; i++) {
      await graph.addRelation({
        cause: "A",
        causeNamespace: NS,
        effect: `B${i}`,
        effectNamespace: NS,
        confidence: 0.9,
      });
    }

    const result = await graph.traverse("A", NS, { direction: "effects" });
    expect(result.nodes).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Influence scoring via search()
// ---------------------------------------------------------------------------

describe("CausalGraph – influence scoring", () => {
  let mock: ReturnType<typeof createMockMemoryService>;
  let graph: CausalGraph;

  beforeEach(() => {
    mock = createMockMemoryService();
    graph = new CausalGraph(mock.service);
  });

  it("node at depth 1 has higher score than node at depth 2", async () => {
    await graph.addRelation({
      cause: "Root",
      causeNamespace: NS,
      effect: "Near",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "Near",
      causeNamespace: NS,
      effect: "Far",
      effectNamespace: NS,
      confidence: 0.9,
    });

    const results = await graph.search("Root", NS);
    const nearScore = results.find((r) => r.key === "Near")!.score;
    const farScore = results.find((r) => r.key === "Far")!.score;
    expect(nearScore).toBeGreaterThan(farScore);
  });

  it("high-confidence link produces higher score than low-confidence at same depth", async () => {
    await graph.addRelation({
      cause: "Root",
      causeNamespace: NS,
      effect: "Strong",
      effectNamespace: NS,
      confidence: 1.0,
    });
    await graph.addRelation({
      cause: "Root",
      causeNamespace: NS,
      effect: "Weak",
      effectNamespace: NS,
      confidence: 0.1,
    });

    const results = await graph.search("Root", NS);
    const strongScore = results.find((r) => r.key === "Strong")!.score;
    const weakScore = results.find((r) => r.key === "Weak")!.score;
    expect(strongScore).toBeGreaterThan(weakScore);
  });

  it("all scores are positive", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.8,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.5,
    });

    const results = await graph.search("A", NS);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("scores are bounded above by 1 (depth-1 node with confidence=1 => score=1)", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 1.0,
    });

    const results = await graph.search("A", NS);
    const bScore = results.find((r) => r.key === "B")!.score;
    expect(bScore).toBeLessThanOrEqual(1.0);
  });

  it("search respects minConfidence default of 0.1", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.05,
    });

    const results = await graph.search("A", NS);
    // B has confidence 0.05, below the search default 0.1 threshold
    expect(results.find((r) => r.key === "B")).toBeUndefined();
  });

  it("search results are sorted descending by score", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "C",
      causeNamespace: NS,
      effect: "D",
      effectNamespace: NS,
      confidence: 0.9,
    });

    const results = await graph.search("A", NS);
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
    }
  });

  it("limit=1 returns exactly 1 result", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.8,
    });

    const results = await graph.search("A", NS, 1);
    expect(results).toHaveLength(1);
  });

  it("multi-hop influence: search from A reaches C through B", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.9,
    });

    const results = await graph.search("A", NS);
    expect(results.find((r) => r.key === "C")).toBeDefined();
  });

  it("result keys and namespaces are strings", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.8,
    });

    const results = await graph.search("A", NS);
    for (const r of results) {
      expect(typeof r.key).toBe("string");
      expect(typeof r.namespace).toBe("string");
      expect(typeof r.score).toBe("number");
    }
  });

  it("search across namespaces includes cross-namespace results", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: "ns1",
      effect: "B",
      effectNamespace: "ns2",
      confidence: 0.9,
    });

    const results = await graph.search("A", "ns1");
    const bResult = results.find((r) => r.key === "B");
    expect(bResult).toBeDefined();
    expect(bResult!.namespace).toBe("ns2");
  });
});

// ---------------------------------------------------------------------------
// Graph serialization — serialize to/from JSON preserves all links
// ---------------------------------------------------------------------------

describe("CausalGraph – serialization via traversal result", () => {
  let mock: ReturnType<typeof createMockMemoryService>;
  let graph: CausalGraph;

  beforeEach(() => {
    mock = createMockMemoryService();
    graph = new CausalGraph(mock.service);
  });

  it("traversal result serializes to JSON without errors", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.8,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.7,
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    const json = JSON.stringify(result);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("JSON round-trip preserves relation count", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.8,
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.relations).toHaveLength(result.relations.length);
    expect(parsed.nodes).toHaveLength(result.nodes.length);
  });

  it("JSON round-trip preserves confidence values", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.654,
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.relations[0].confidence).toBe(0.654);
  });

  it("JSON round-trip preserves evidence strings", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
      evidence: "serialized evidence",
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.relations[0].evidence).toBe("serialized evidence");
  });

  it("JSON round-trip preserves root node identity", async () => {
    await graph.addRelation({
      cause: "myRoot",
      causeNamespace: "myNs",
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });

    const result = await graph.traverse("myRoot", "myNs", {
      direction: "effects",
    });
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.root.key).toBe("myRoot");
    expect(parsed.root.namespace).toBe("myNs");
  });

  it("raw stored record serializes correctly as JSON", async () => {
    await graph.addRelation({
      cause: "S1",
      causeNamespace: NS,
      effect: "S2",
      effectNamespace: NS,
      confidence: 0.5,
      evidence: "e1",
    });
    const call = mock.putCalls[0]!;
    const serialized = JSON.stringify(call.value);
    const parsed = JSON.parse(serialized);
    expect(parsed.cause).toBe("S1");
    expect(parsed.effect).toBe("S2");
    expect(parsed.confidence).toBe(0.5);
    expect(parsed.evidence).toBe("e1");
  });
});

// ---------------------------------------------------------------------------
// Orphan detection and pruning
// ---------------------------------------------------------------------------

describe("CausalGraph – orphan detection", () => {
  let mock: ReturnType<typeof createMockMemoryService>;
  let graph: CausalGraph;

  beforeEach(() => {
    mock = createMockMemoryService();
    graph = new CausalGraph(mock.service);
  });

  it("isolated node has zero causes and zero effects", async () => {
    const node = await graph.getRelations("isolated", NS);
    expect(node.causes).toHaveLength(0);
    expect(node.effects).toHaveLength(0);
  });

  it("node after all its links are removed becomes isolated", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.removeRelation("A", NS, "B", NS);

    const nodeA = await graph.getRelations("A", NS);
    const nodeB = await graph.getRelations("B", NS);
    expect(nodeA.effects).toHaveLength(0);
    expect(nodeB.causes).toHaveLength(0);
  });

  it("isolated node traversal returns empty nodes and relations", async () => {
    const result = await graph.traverse("orphan", NS, { direction: "both" });
    expect(result.nodes).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
  });

  it("isolated node search returns empty array", async () => {
    const results = await graph.search("orphan", NS);
    expect(results).toHaveLength(0);
  });

  it("node becomes orphan after removeNode", async () => {
    await graph.addRelation({
      cause: "P",
      causeNamespace: NS,
      effect: "Q",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.removeNode("Q", NS);

    const nodeP = await graph.getRelations("P", NS);
    const nodeQ = await graph.getRelations("Q", NS);
    expect(nodeP.effects).toHaveLength(0);
    expect(nodeQ.causes).toHaveLength(0);
    expect(nodeQ.effects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases and robustness
// ---------------------------------------------------------------------------

describe("CausalGraph – edge cases", () => {
  let mock: ReturnType<typeof createMockMemoryService>;
  let graph: CausalGraph;

  beforeEach(() => {
    mock = createMockMemoryService();
    graph = new CausalGraph(mock.service);
  });

  it("node keys with special characters stored correctly", async () => {
    await graph.addRelation({
      cause: "key:with:colons",
      causeNamespace: NS,
      effect: "key-with-dashes",
      effectNamespace: NS,
      confidence: 0.8,
    });
    const node = await graph.getRelations("key:with:colons", NS);
    expect(node.effects[0]!.effect).toBe("key-with-dashes");
  });

  it("updating confidence by re-adding same pair", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.3,
    });
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });

    const node = await graph.getRelations("A", NS);
    // Latest value should be 0.9
    expect(node.effects[0]!.confidence).toBe(0.9);
  });

  it("multiple independent graphs can coexist in same mock store", async () => {
    const mock2 = createMockMemoryService();
    const graph2 = new CausalGraph(mock2.service);

    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph2.addRelation({
      cause: "X",
      causeNamespace: NS,
      effect: "Y",
      effectNamespace: NS,
      confidence: 0.7,
    });

    const nodeA = await graph.getRelations("A", NS);
    const nodeX = await graph2.getRelations("X", NS);

    expect(nodeA.effects).toHaveLength(1);
    expect(nodeX.effects).toHaveLength(1);
    expect(nodeA.effects[0]!.effect).toBe("B");
    expect(nodeX.effects[0]!.effect).toBe("Y");
  });

  it("removeRelation on non-existent relation writes tombstone without error", async () => {
    await expect(
      graph.removeRelation("nonexistent", NS, "also-nonexistent", NS),
    ).resolves.not.toThrow();
  });

  it("traverse does not return root node in result nodes", async () => {
    await graph.addRelation({
      cause: "Root",
      causeNamespace: NS,
      effect: "Child",
      effectNamespace: NS,
      confidence: 0.9,
    });

    const result = await graph.traverse("Root", NS, { direction: "effects" });
    expect(result.nodes.find((n) => n.key === "Root")).toBeUndefined();
  });

  it("single-hop traversal result has depth=1", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    expect(result.depth).toBe(1);
  });

  it("two-hop traversal result has depth=2", async () => {
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.8,
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    expect(result.depth).toBe(2);
  });

  it("nodes in result include their cause and effect relations", async () => {
    // A -> B -> C: when traversing from A, node B should have causes=[A->B] and effects=[B->C]
    await graph.addRelation({
      cause: "A",
      causeNamespace: NS,
      effect: "B",
      effectNamespace: NS,
      confidence: 0.9,
    });
    await graph.addRelation({
      cause: "B",
      causeNamespace: NS,
      effect: "C",
      effectNamespace: NS,
      confidence: 0.8,
    });

    const result = await graph.traverse("A", NS, { direction: "effects" });
    const nodeB = result.nodes.find((n) => n.key === "B")!;
    expect(nodeB).toBeDefined();
    expect(nodeB.causes).toHaveLength(1);
    expect(nodeB.effects).toHaveLength(1);
  });
});
