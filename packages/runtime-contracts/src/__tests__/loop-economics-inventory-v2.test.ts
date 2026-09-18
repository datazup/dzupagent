import { describe, expect, it } from "vitest";
import { canonicalInputDigest } from "../idempotency.js";
import {
  buildLoopEconomicsLeafInventoryV2,
  type LoopEconomicsInventoryDiagnosticCodeV2,
  type LoopEconomicsLeafInventoryV2,
} from "../loop-economics-evidence-v2.js";
import type {
  PipelineDefinition,
  PipelineEdge,
  PipelineNode,
} from "../pipeline-artifact/definition.js";

/**
 * Hand-built compiled artifact mirroring what the flow compiler emits for
 *
 *   for_each items (id: items)
 *     body[0] action worker        -> agent-resolved   (AgentNode)
 *     body[1] branch decide        -> gate
 *       then[0] prompt ask         -> ToolNode dzup.runtime.prompt
 *       then[1] set yes            -> ToolNode dzup.runtime.set
 *       else[0] action notify      -> tool-resolved    (ToolNode, effectClass)
 *     body[2] adapter.run codex    -> ToolNode dzup.runtime.adapter.run
 *     body[3] validate.schema ok   -> ToolNode dzup.runtime.validate.schema
 *
 * with independent generated runtime ids.
 */
const LOOP_PATH = "root.nodes[0]";

interface Authored {
  readonly key: string;
  readonly rel: string;
  readonly nodeType: string;
  readonly nodeId: string;
  readonly runtime: "agent" | "tool" | "gate";
  readonly effectClass?: string;
}

const AUTHORED: readonly Authored[] = [
  { key: "worker", rel: "body[0]", nodeType: "action", nodeId: "worker", runtime: "agent" },
  { key: "decide", rel: "body[1]", nodeType: "branch", nodeId: "decide", runtime: "gate" },
  { key: "ask", rel: "body[1].then[0]", nodeType: "prompt", nodeId: "ask", runtime: "tool" },
  { key: "yes", rel: "body[1].then[1]", nodeType: "set", nodeId: "yes", runtime: "tool" },
  { key: "notify", rel: "body[1].else[0]", nodeType: "action", nodeId: "notify", runtime: "tool", effectClass: "network_write" },
  { key: "codex", rel: "body[2]", nodeType: "adapter.run", nodeId: "codex", runtime: "tool" },
  { key: "ok", rel: "body[3]", nodeType: "validate.schema", nodeId: "ok", runtime: "tool" },
];

interface Fixture {
  readonly definition: PipelineDefinition;
  readonly ids: Record<string, string>;
}

function fixture(
  idFor: (key: string) => string = (key) => `rt-${key}`,
  authored: readonly Authored[] = AUTHORED,
): Fixture {
  const ids: Record<string, string> = { loop: idFor("loop") };
  for (const entry of authored) ids[entry.key] = idFor(entry.key);
  const bodyNodes: PipelineNode[] = authored.map((entry) => {
    const source = { kind: "flow-node" as const, path: `${LOOP_PATH}.${entry.rel}`, nodeType: entry.nodeType, nodeId: entry.nodeId };
    const effect = entry.effectClass !== undefined ? { effectClass: entry.effectClass } : {};
    if (entry.runtime === "agent") return { id: ids[entry.key]!, type: "agent", agentId: entry.nodeId, source, ...effect };
    if (entry.runtime === "gate") return { id: ids[entry.key]!, type: "gate", gateType: "quality", condition: "check", source };
    return { id: ids[entry.key]!, type: "tool", toolName: `dzup.runtime.${entry.nodeType}`, source, ...effect };
  });
  const thenFirst = authored.find((entry) => entry.rel === "body[1].then[0]");
  const elseFirst = authored.find((entry) => entry.rel === "body[1].else[0]");
  const edges: PipelineEdge[] = [
    {
      type: "conditional",
      sourceNodeId: ids.decide!,
      predicateName: `branch__${ids.decide}__predicate`,
      branches: {
        ...(thenFirst !== undefined ? { true: ids[thenFirst.key]! } : {}),
        ...(elseFirst !== undefined ? { false: ids[elseFirst.key]! } : {}),
      },
    },
  ];
  const loop: PipelineNode = {
    id: ids.loop!,
    type: "loop",
    name: "forEach:item",
    source: { kind: "flow-node", path: LOOP_PATH, nodeType: "for_each", nodeId: "items" },
    bodyNodeIds: bodyNodes.map((node) => node.id),
    bodyGraph: { entryNodeId: bodyNodes[0]!.id, normalExitNodeIds: [], suspendedExitNodeIds: [], terminalExitNodeIds: [], errorExitNodeIds: [] },
    maxIterations: 1000,
    continuePredicateName: "forEach__item__predicate",
    forEach: { source: "items", as: "item", order: "input", concurrency: 1, empty: { body: "skip", aggregate: "empty-array" } },
  };
  return {
    ids,
    definition: {
      id: "inventory-fixture",
      name: "inventory fixture",
      version: "1",
      schemaVersion: "1.0.0",
      entryNodeId: ids.loop!,
      nodes: [loop, ...bodyNodes],
      edges,
    },
  };
}

function admitted(definition: PipelineDefinition, loopNodeId: string): LoopEconomicsLeafInventoryV2 {
  const result = buildLoopEconomicsLeafInventoryV2(definition, loopNodeId);
  if (result.status !== "admitted") throw new Error(`expected admitted inventory: ${JSON.stringify(result.diagnostics)}`);
  return result.inventory;
}

function deniedCodes(definition: PipelineDefinition, loopNodeId: string): LoopEconomicsInventoryDiagnosticCodeV2[] {
  const result = buildLoopEconomicsLeafInventoryV2(definition, loopNodeId);
  if (result.status !== "denied") throw new Error("expected a denied inventory");
  expect(result).not.toHaveProperty("inventory");
  expect(result.diagnostics.length).toBeGreaterThan(0);
  return [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))];
}

function loopOf(definition: PipelineDefinition) {
  const loop = definition.nodes[0];
  if (loop?.type !== "loop") throw new Error("fixture loop");
  return loop;
}

describe("buildLoopEconomicsLeafInventoryV2", () => {
  it("binds every authored body node to its path, id, runtime id and resolved execution class in authored order", () => {
    const { definition, ids } = fixture();
    const inventory = admitted(definition, ids.loop!);
    expect(inventory.schema).toBe("dzupagent.loopEconomicsLeafInventory/v2");
    expect(inventory.loop).toEqual({ runtimeNodeId: ids.loop, authoredPath: LOOP_PATH, authoredId: "items" });
    expect(inventory.bindings.map((binding) => [binding.order, binding.authoredId, binding.runtimeNodeId, binding.executionClass])).toEqual([
      [0, "worker", ids.worker, { kind: "execution", resolution: "agent" }],
      [1, "decide", ids.decide, { kind: "control", resolution: "branch" }],
      [2, "ask", ids.ask, { kind: "execution", resolution: "prompt" }],
      [3, "yes", ids.yes, { kind: "local", resolution: "set" }],
      [4, "notify", ids.notify, { kind: "effect", resolution: "tool", effectClass: "network_write" }],
      [5, "codex", ids.codex, { kind: "execution", resolution: "adapter.run" }],
      [6, "ok", ids.ok, { kind: "local", resolution: "validate.schema" }],
    ]);
    expect(inventory.bindings.map((binding) => binding.authoredPath)).toEqual(AUTHORED.map((entry) => `${LOOP_PATH}.${entry.rel}`));
    expect(inventory.bindings.map((binding) => binding.nodePath)).toEqual([
      [ids.loop, ids.worker], [ids.loop, ids.decide], [ids.loop, ids.decide, ids.ask], [ids.loop, ids.decide, ids.yes],
      [ids.loop, ids.decide, ids.notify], [ids.loop, ids.codex], [ids.loop, ids.ok],
    ]);
    expect(inventory.controlSelections).toEqual([{ kind: "branch", nodePath: [ids.loop, ids.decide], selectedBranch: null }]);
    expect(inventory.bindings.map((binding) => binding.controlRequirements)).toEqual([
      [], [],
      [{ selectionIndex: 0, kind: "branch", requiredBranch: "then" }],
      [{ selectionIndex: 0, kind: "branch", requiredBranch: "then" }],
      [{ selectionIndex: 0, kind: "branch", requiredBranch: "else" }],
      [], [],
    ]);
  });

  it("yields execution plus linked charge for agent, prompt and adapter.run; effect for a tool-resolved action; nothing for local nodes", () => {
    const { definition, ids } = fixture();
    const inventory = admitted(definition, ids.loop!);
    expect(inventory.leaves.map((leaf) => [leaf.order, leaf.kind, leaf.leafId, leaf.runtimeNodeId])).toEqual([
      [0, "execution", `execution:${LOOP_PATH}.body[0]`, ids.worker],
      [1, "charge", `charge:${LOOP_PATH}.body[0]`, ids.worker],
      [2, "execution", `execution:${LOOP_PATH}.body[1].then[0]`, ids.ask],
      [3, "charge", `charge:${LOOP_PATH}.body[1].then[0]`, ids.ask],
      [4, "effect", `effect:${LOOP_PATH}.body[1].else[0]`, ids.notify],
      [5, "execution", `execution:${LOOP_PATH}.body[2]`, ids.codex],
      [6, "charge", `charge:${LOOP_PATH}.body[2]`, ids.codex],
    ]);
    for (const leaf of inventory.leaves) {
      if (leaf.kind !== "charge") continue;
      const execution = inventory.leaves.find((candidate) => candidate.leafId === leaf.executionLeafId);
      expect(execution?.kind).toBe("execution");
      expect(execution?.order).toBeLessThan(leaf.order);
      expect(execution?.nodePath).toEqual(leaf.nodePath);
      expect(execution?.controlRequirements).toEqual(leaf.controlRequirements);
    }
    expect(inventory.leaves.filter((leaf) => leaf.kind === "execution").map((leaf) => leaf.resolution)).toEqual(["agent", "prompt", "adapter.run"]);
    const effect = inventory.leaves.find((leaf) => leaf.kind === "effect");
    expect(effect).toMatchObject({ effectClass: "network_write", controlRequirements: [{ selectionIndex: 0, kind: "branch", requiredBranch: "else" }] });
    expect(inventory.leaves.some((leaf) => [ids.yes, ids.ok].includes(leaf.runtimeNodeId))).toBe(false);
    for (const leaf of inventory.leaves) {
      expect(leaf).not.toHaveProperty("receiptDigest");
      expect(leaf).not.toHaveProperty("intentDigest");
      expect(leaf.nodePath.at(-1)).toBe(leaf.runtimeNodeId);
    }
  });

  it("keeps a tool-resolved action without a declared effect class as an effect leaf with no fabricated class", () => {
    const authored = AUTHORED.map((entry) => (entry.key === "notify" ? { ...entry, effectClass: undefined } : entry));
    const { definition, ids } = fixture(undefined, authored);
    const inventory = admitted(definition, ids.loop!);
    const effect = inventory.leaves.find((leaf) => leaf.kind === "effect");
    expect(effect).toBeDefined();
    expect(effect).not.toHaveProperty("effectClass");
    expect(inventory.bindings[4]?.executionClass).toEqual({ kind: "effect", resolution: "tool" });
  });

  it("orders an absent else after the then arm and before the suffix, with only the true transition", () => {
    const authored = AUTHORED.filter((entry) => entry.key !== "notify");
    const { definition, ids } = fixture(undefined, authored);
    const inventory = admitted(definition, ids.loop!);
    expect(inventory.bindings.map((binding) => binding.authoredId)).toEqual(["worker", "decide", "ask", "yes", "codex", "ok"]);
    expect(inventory.leaves.map((leaf) => leaf.kind)).toEqual(["execution", "charge", "execution", "charge", "execution", "charge"]);
    expect(inventory.controlSelections).toHaveLength(1);
  });

  it("keeps bodyPlanDigest stable under regenerated runtime ids while definitionDigest moves", () => {
    const first = fixture((key) => `a-${key}`);
    const second = fixture((key) => `b-${key}`);
    const one = admitted(first.definition, first.ids.loop!);
    const two = admitted(second.definition, second.ids.loop!);
    expect(one.bodyPlanDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(two.bodyPlanDigest).toBe(one.bodyPlanDigest);
    expect(two.definitionDigest).not.toBe(one.definitionDigest);
    expect(one.definitionDigest).toBe(`sha256:${canonicalInputDigest(first.definition)}`);
    expect(one.bodyPlanDigest).not.toBe(one.definitionDigest);
    expect(one.leaves.map((leaf) => leaf.leafId)).toEqual(two.leaves.map((leaf) => leaf.leafId));
  });

  it("moves bodyPlanDigest when the authored body changes and when the resolved class changes", () => {
    const base = fixture();
    const baseline = admitted(base.definition, base.ids.loop!).bodyPlanDigest;
    const withoutElse = fixture(undefined, AUTHORED.filter((entry) => entry.key !== "notify"));
    expect(admitted(withoutElse.definition, withoutElse.ids.loop!).bodyPlanDigest).not.toBe(baseline);
    const [worker, ...rest] = AUTHORED;
    const swapped = fixture(undefined, [
      { ...AUTHORED[6]!, rel: "body[0]" },
      ...rest.slice(0, -1),
      { ...worker!, rel: "body[3]" },
    ]);
    expect(admitted(swapped.definition, swapped.ids.loop!).bodyPlanDigest).not.toBe(baseline);
    const toolResolved = fixture(undefined, AUTHORED.map((entry) => (entry.key === "worker" ? { ...entry, runtime: "tool" as const } : entry)));
    const resolved = admitted(toolResolved.definition, toolResolved.ids.loop!);
    expect(resolved.bindings[0]?.executionClass).toEqual({ kind: "effect", resolution: "tool" });
    expect(resolved.bodyPlanDigest).not.toBe(baseline);
    const relocated = fixture();
    for (const node of relocated.definition.nodes) {
      if (node.source !== undefined) node.source = { ...node.source, path: node.source.path.replace(LOOP_PATH, "root.nodes[4]") };
    }
    expect(admitted(relocated.definition, relocated.ids.loop!).bodyPlanDigest).toBe(baseline);
  });

  describe("denies with a distinct diagnostic and no inventory", () => {
    it("missing: loop compiled without provenance", () => {
      const { definition, ids } = fixture();
      delete loopOf(definition).source;
      expect(deniedCodes(definition, ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING"]);
    });

    it("missing: a body node without a source anchor", () => {
      const { definition, ids } = fixture();
      delete definition.nodes.find((node) => node.id === ids.yes)!.source;
      expect(deniedCodes(definition, ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING"]);
    });

    it("missing: an authored descendant omitted from the loop body", () => {
      const { definition, ids } = fixture();
      loopOf(definition).bodyNodeIds = loopOf(definition).bodyNodeIds.filter((id) => id !== ids.codex);
      expect(deniedCodes(definition, ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING"]);
    });

    it("missing: an arm without its gate, and a gate without its conditional edge", () => {
      const orphan = fixture();
      orphan.definition.nodes = orphan.definition.nodes.filter((node) => node.id !== orphan.ids.decide);
      loopOf(orphan.definition).bodyNodeIds = loopOf(orphan.definition).bodyNodeIds.filter((id) => id !== orphan.ids.decide);
      expect(deniedCodes(orphan.definition, orphan.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING"]);
      const edgeless = fixture();
      edgeless.definition.edges = [];
      expect(deniedCodes(edgeless.definition, edgeless.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING"]);
    });

    it("duplicate: a runtime id listed twice, and two nodes bound to one authored path", () => {
      const twice = fixture();
      loopOf(twice.definition).bodyNodeIds = [...loopOf(twice.definition).bodyNodeIds, twice.ids.ok!];
      expect(deniedCodes(twice.definition, twice.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_DUPLICATE_MAPPING"]);
      const samePath = fixture();
      const codex = samePath.definition.nodes.find((node) => node.id === samePath.ids.codex)!;
      codex.source = { ...codex.source!, path: `${LOOP_PATH}.body[3]`, nodeId: "ok-copy" };
      expect(deniedCodes(samePath.definition, samePath.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_DUPLICATE_MAPPING"]);
    });

    it("reordered: runtime body order disagrees with authored order", () => {
      const { definition, ids } = fixture();
      const loop = loopOf(definition);
      loop.bodyNodeIds = [loop.bodyNodeIds[1]!, loop.bodyNodeIds[0]!, ...loop.bodyNodeIds.slice(2)];
      loop.bodyGraph!.entryNodeId = loop.bodyNodeIds[0]!;
      expect(deniedCodes(definition, ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_REORDERED_MAPPING"]);
      const arms = fixture();
      const armLoop = loopOf(arms.definition);
      armLoop.bodyNodeIds = armLoop.bodyNodeIds.map((id) => (id === arms.ids.ask ? arms.ids.notify! : id === arms.ids.notify ? arms.ids.ask! : id));
      expect(deniedCodes(arms.definition, arms.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_REORDERED_MAPPING"]);
    });

    it("foreign: a body id the artifact does not define, and a node authored outside the loop", () => {
      const undefinedId = fixture();
      loopOf(undefinedId.definition).bodyNodeIds.push("rt-stranger");
      expect(deniedCodes(undefinedId.definition, undefinedId.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_FOREIGN_MAPPING"]);
      const outside = fixture();
      const ok = outside.definition.nodes.find((node) => node.id === outside.ids.ok)!;
      ok.source = { ...ok.source!, path: "root.nodes[1]" };
      expect(deniedCodes(outside.definition, outside.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_FOREIGN_MAPPING"]);
    });

    it("contradictory: runtime type against authored type, and an edge against the authored arms", () => {
      const agentSet = fixture();
      const yes = agentSet.definition.nodes.find((node) => node.id === agentSet.ids.yes)!;
      agentSet.definition.nodes[agentSet.definition.nodes.indexOf(yes)] = { id: yes.id, type: "agent", agentId: "yes", source: yes.source };
      expect(deniedCodes(agentSet.definition, agentSet.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING"]);
      const crossed = fixture();
      const edge = crossed.definition.edges[0];
      if (edge?.type !== "conditional") throw new Error("fixture edge");
      edge.branches = { true: crossed.ids.notify!, false: crossed.ids.ask! };
      expect(deniedCodes(crossed.definition, crossed.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING"]);
      const phantomElse = fixture(undefined, AUTHORED.filter((entry) => entry.key !== "notify"));
      const phantomEdge = phantomElse.definition.edges[0];
      if (phantomEdge?.type !== "conditional") throw new Error("fixture edge");
      phantomEdge.branches = { ...phantomEdge.branches, false: phantomElse.ids.codex! };
      expect(deniedCodes(phantomElse.definition, phantomElse.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING"]);
      const gateless = fixture();
      const decide = gateless.definition.nodes.find((node) => node.id === gateless.ids.decide)!;
      gateless.definition.nodes[gateless.definition.nodes.indexOf(decide)] = { id: decide.id, type: "tool", toolName: "dzup.runtime.set", source: decide.source };
      expect(deniedCodes(gateless.definition, gateless.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING"]);
    });

    it("unsupported: an authored node type without an admitted class, and a nested composite path", () => {
      const http = fixture();
      const ok = http.definition.nodes.find((node) => node.id === http.ids.ok)!;
      ok.source = { ...ok.source!, nodeType: "http" };
      expect(deniedCodes(http.definition, http.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_UNSUPPORTED_NODE"]);
      const nested = fixture();
      const codex = nested.definition.nodes.find((node) => node.id === nested.ids.codex)!;
      codex.source = { ...codex.source!, path: `${LOOP_PATH}.body[2].body[0]` };
      expect(deniedCodes(nested.definition, nested.ids.loop!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_UNSUPPORTED_NODE"]);
    });

    it("invalid: an unknown loop id or a node that is not a for_each loop", () => {
      const { definition, ids } = fixture();
      expect(deniedCodes(definition, "rt-nowhere")).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_INVALID"]);
      expect(deniedCodes(definition, ids.worker!)).toEqual(["LOOP_ECONOMICS_V2_INVENTORY_INVALID"]);
    });
  });

  it("does not mutate the artifact", () => {
    const { definition, ids } = fixture();
    const before = JSON.stringify(definition);
    admitted(definition, ids.loop!);
    expect(JSON.stringify(definition)).toBe(before);
  });
});
