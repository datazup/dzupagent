/**
 * Unit tests for lower-pipeline-flat Stage 4 lowerer.
 *
 * Gold-file test: a `branch` whose `then` contains a `parallel` with two
 * `action` leaves → expected PipelineDefinition snapshot (no LoopNode).
 *
 * ID generation is made deterministic by injecting an `_idGen` counter via
 * the internal hook on `LowerPipelineFlatInput`. The public signature is
 * unchanged; only tests use this path.
 */

import type {
  ActionNode,
  BranchNode,
  FlowNode,
  ParallelNode,
  ResolvedTool,
  SequenceNode,
} from "@dzupagent/flow-ast";
import type {
  AgentNode,
  GateNode,
  ForkNode,
  JoinNode,
  PipelineDefinition,
  ToolNode,
} from "@dzupagent/core/pipeline";
import { InMemoryDomainToolRegistry } from "@dzupagent/app-tools";
import { describe, expect, it } from "vitest";

import { lowerPipelineFlat } from "../lower/lower-pipeline-flat.js";

// ---------------------------------------------------------------------------
// Deterministic ID generator for snapshot stability
// ---------------------------------------------------------------------------

function makeIdGen(prefix = "id"): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

// ---------------------------------------------------------------------------
// AST constructor helpers
// ---------------------------------------------------------------------------

const action = (toolRef: string): ActionNode => ({
  type: "action",
  toolRef,
  input: {},
});

const sequence = (...nodes: FlowNode[]): SequenceNode => ({
  type: "sequence",
  nodes,
});

const branch = (
  condition: string,
  thenNodes: FlowNode[],
  elseNodes?: FlowNode[]
): BranchNode => ({
  type: "branch",
  condition,
  then: thenNodes,
  ...(elseNodes !== undefined ? { else: elseNodes } : {}),
});

const parallel = (...branches: FlowNode[][]): ParallelNode => ({
  type: "parallel",
  branches,
});

// ---------------------------------------------------------------------------
// Resolver helpers
// ---------------------------------------------------------------------------

function makeResolver(skillNames: string[]) {
  const registry = new InMemoryDomainToolRegistry();
  for (const name of skillNames) {
    const namespace = name.split(".")[0] ?? name;
    registry.register({
      name,
      description: `test skill ${name}`,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      permissionLevel: "read",
      sideEffects: [],
      namespace,
    });
  }
  return {
    resolve(ref: string): ResolvedTool | null {
      const def = registry.get(ref);
      if (!def) return null;
      return { ref, kind: "skill", inputSchema: def.inputSchema, handle: def };
    },
    listAvailable: () => registry.list().map((t) => t.name),
  };
}

/**
 * Build the resolved side-table using the paths that _shared.ts generates.
 *
 * _shared.ts calls lowerSequence with parentPath, then calls
 * lowerNodeToPipeline(child, ctx, `${parentPath}.nodes[${idx}]`).
 * When lowerBranch calls lowerSequence(node.then, ctx, `${path}.then`),
 * actions inside get path `root.then[0]`, etc.
 * When lowerParallel calls lowerSequence(branch, ctx, `${path}.branches[${bIdx}]`),
 * actions inside get path `root.branches[0][0]`, etc.
 *
 * In the gold-file test the branch is the top-level node (path = 'root'),
 * and the parallel is inside the then-branch (path = 'root.then[0]').
 */
function buildResolved(
  resolver: ReturnType<typeof makeResolver>,
  entries: Array<{ nodePath: string; toolRef: string }>
): Map<string, ResolvedTool> {
  const map = new Map<string, ResolvedTool>();
  for (const { nodePath, toolRef } of entries) {
    const rt = resolver.resolve(toolRef);
    if (rt !== null) {
      map.set(nodePath, rt);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Gold-file test: branch → parallel(action, action)
// ---------------------------------------------------------------------------

describe("lowerPipelineFlat", () => {
  it("gold-file: branch whose then contains parallel with two action leaves", () => {
    /*
     * AST shape:
     *   branch(condition='check.score > 0.5')
     *     then:
     *       parallel
     *         branch[0]: [action('svc.alpha')]
     *         branch[1]: [action('svc.beta')]
     *
     * Expected pipeline:
     *   GateNode(gate, id-1)  ← top-level branch
     *   ForkNode(fork, id-2)  ← parallel fork
     *   ToolNode(tool, id-3)  ← svc.alpha
     *   ToolNode(tool, id-4)  ← svc.beta
     *   JoinNode(join, id-5)  ← parallel join
     *
     * Edges:
     *   conditional: id-1 → { true: id-2 }
     *   sequential:  id-2 → id-3  (fork → alpha)
     *   sequential:  id-3 → id-5  (alpha → join)
     *   sequential:  id-2 → id-4  (fork → beta)
     *   sequential:  id-4 → id-5  (beta → join)
     *
     * No LoopNode emitted.
     */

    const resolver = makeResolver(["svc.alpha", "svc.beta"]);

    const astProper = branch("check.score > 0.5", [
      parallel([action("svc.alpha")], [action("svc.beta")]),
    ]);

    /*
     * Path trace through _shared.ts:
     * lowerPipelineFlat calls lowerNodeToPipeline(ast, ctx, 'root')
     *   -> lowerBranch: path='root'
     *     -> lowerSequence(node.then, ctx, 'root.then')
     *       -> lowerNodeToPipeline(parallel, ctx, 'root.then[0]')
     *         -> lowerParallel: path='root.then[0]'
     *           -> lowerSequence(branch[0], ctx, 'root.then[0].branches[0]')
     *             -> lowerNodeToPipeline(action('svc.alpha'), ctx, 'root.then[0].branches[0][0]')
     *           -> lowerSequence(branch[1], ctx, 'root.then[0].branches[1]')
     *             -> lowerNodeToPipeline(action('svc.beta'), ctx, 'root.then[0].branches[1][0]')
     */
    const resolved = buildResolved(resolver, [
      {
        nodePath: "root.then[0].branches[0][0]",
        toolRef: "svc.alpha",
      },
      {
        nodePath: "root.then[0].branches[1][0]",
        toolRef: "svc.beta",
      },
    ]);

    const { artifact, warnings } = lowerPipelineFlat({
      ast: astProper,
      resolved,
      resolvedPersonas: new Map(),
      name: "incident-pipeline",
      version: "1.0.0",
      _idGen: makeIdGen("id"),
    });

    // Top-level shape
    expect(artifact.name).toBe("incident-pipeline");
    expect(artifact.version).toBe("1.0.0");
    expect(artifact.schemaVersion).toBe("1.0.0");

    // No LoopNode in the output
    const loopNodes = artifact.nodes.filter((n) => n.type === "loop");
    expect(loopNodes).toHaveLength(0);

    // Node types in order: gate, fork, tool(alpha), tool(beta), join
    const nodeTypes = artifact.nodes.map((n) => n.type);
    expect(nodeTypes).toEqual(["gate", "fork", "tool", "tool", "join"]);

    // Entry node is the gate (first node)
    const gateNode = artifact.nodes[0] as GateNode;
    expect(gateNode.type).toBe("gate");
    expect(gateNode.gateType).toBe("quality");
    expect(gateNode.condition).toBe("check.score > 0.5");
    expect(artifact.entryNodeId).toBe(gateNode.id);

    const forkNode = artifact.nodes[1] as ForkNode;
    expect(forkNode.type).toBe("fork");

    const alphaNode = artifact.nodes[2] as ToolNode;
    expect(alphaNode.type).toBe("tool");
    expect(alphaNode.toolName).toBe("svc.alpha");

    const betaNode = artifact.nodes[3] as ToolNode;
    expect(betaNode.type).toBe("tool");
    expect(betaNode.toolName).toBe("svc.beta");

    const joinNode = artifact.nodes[4] as JoinNode;
    expect(joinNode.type).toBe("join");
    expect(joinNode.forkId).toBe(forkNode.forkId);
    expect(joinNode.mergeStrategy).toBe("all");

    // Edge structure: one conditional from gate, four sequential for parallel
    const conditionalEdges = artifact.edges.filter(
      (e) => e.type === "conditional"
    );
    expect(conditionalEdges).toHaveLength(1);
    const conditionalEdge = conditionalEdges[0];
    expect(conditionalEdge).toBeDefined();
    if (conditionalEdge?.type === "conditional") {
      expect(conditionalEdge.sourceNodeId).toBe(gateNode.id);
      expect(conditionalEdge.branches["true"]).toBe(forkNode.id);
    }

    const sequentialEdges = artifact.edges.filter(
      (e) => e.type === "sequential"
    );
    expect(sequentialEdges).toHaveLength(4);

    // fork → alpha, fork → beta, alpha → join, beta → join
    const seqPairs = sequentialEdges
      .filter((e) => e.type === "sequential")
      .map((e) =>
        e.type === "sequential" ? `${e.sourceNodeId}->${e.targetNodeId}` : ""
      );
    expect(seqPairs).toContain(`${forkNode.id}->${alphaNode.id}`);
    expect(seqPairs).toContain(`${forkNode.id}->${betaNode.id}`);
    expect(seqPairs).toContain(`${alphaNode.id}->${joinNode.id}`);
    expect(seqPairs).toContain(`${betaNode.id}->${joinNode.id}`);

    // No unresolved-ref warnings expected
    expect(warnings).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Additional cases
  // ---------------------------------------------------------------------------

  it("single action at root produces one ToolNode", () => {
    const resolver = makeResolver(["tools.run"]);
    const resolved = buildResolved(resolver, [
      { nodePath: "root", toolRef: "tools.run" },
    ]);

    const { artifact, warnings } = lowerPipelineFlat({
      ast: action("tools.run"),
      resolved,
      resolvedPersonas: new Map(),
      name: "single-action",
      _idGen: makeIdGen("n"),
    });

    expect(artifact.nodes).toHaveLength(1);
    const node = artifact.nodes[0] as ToolNode;
    expect(node.type).toBe("tool");
    expect(node.toolName).toBe("tools.run");
    expect(artifact.entryNodeId).toBe(node.id);
    expect(warnings).toHaveLength(0);
  });

  it("lowers W1 per-node durability fields from action metadata", () => {
    const resolver = makeResolver(["tools.write"]);
    const resolved = buildResolved(resolver, [
      { nodePath: "root", toolRef: "tools.write" },
    ]);
    const ast: ActionNode = {
      type: "action",
      toolRef: "tools.write",
      input: { id: 1 },
      idempotency: "exactly-once-required",
      effectClass: "db_write",
      meta: {
        mutation: {
          policy: "mutating",
          idempotencyKey: "ticket-123",
        },
      },
    };

    const { artifact, warnings } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      name: "durable-action",
      _idGen: makeIdGen("w1"),
    });

    const node = artifact.nodes[0] as ToolNode;

    expect(warnings).toHaveLength(0);
    expect(node).toMatchObject({
      type: "tool",
      toolName: "tools.write",
      arguments: { id: 1 },
      declaredIdempotencyKey: "ticket-123",
      idempotency: "exactly-once-required",
      effectClass: "db_write",
    });
  });

  it("sequence of two actions produces two ToolNodes with a sequential edge", () => {
    const resolver = makeResolver(["step.a", "step.b"]);
    const ast = sequence(action("step.a"), action("step.b"));
    const resolved = buildResolved(resolver, [
      { nodePath: "root.nodes[0]", toolRef: "step.a" },
      { nodePath: "root.nodes[1]", toolRef: "step.b" },
    ]);

    const { artifact, warnings } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      name: "two-step",
      _idGen: makeIdGen("s"),
    });

    expect(artifact.nodes).toHaveLength(2);
    expect(artifact.nodes.map((n) => n.type)).toEqual(["tool", "tool"]);

    const seqEdges = artifact.edges.filter((e) => e.type === "sequential");
    expect(seqEdges).toHaveLength(1);
    const edge = seqEdges[0];
    expect(edge).toBeDefined();
    if (edge?.type === "sequential") {
      expect(edge.sourceNodeId).toBe(artifact.nodes[0]?.id);
      expect(edge.targetNodeId).toBe(artifact.nodes[1]?.id);
    }
    expect(warnings).toHaveLength(0);
  });

  it("for_each at root throws router-contract violation error", () => {
    const ast: FlowNode = {
      type: "for_each",
      source: "items",
      as: "item",
      body: [action("tools.process")],
    };
    expect(() =>
      lowerPipelineFlat({
        ast,
        resolved: new Map(),
        resolvedPersonas: new Map(),
        _idGen: makeIdGen("x"),
      })
    ).toThrow(/router-contract violation/);
  });

  it("unresolved action throws in executable mode", () => {
    const ast = action("unknown.tool");
    const resolved = new Map<string, ResolvedTool>();

    expect(() =>
      lowerPipelineFlat({
        ast,
        resolved,
        resolvedPersonas: new Map(),
        _idGen: makeIdGen("w"),
      })
    ).toThrow(/executable lowering rejects unresolved semantic references/);
  });

  it("unresolved action emits warning and stubs a ToolNode in diagnostic mode", () => {
    const ast = action("unknown.tool");
    const resolved = new Map<string, ResolvedTool>();

    const { artifact, warnings } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      _idGen: makeIdGen("w"),
      mode: "diagnostic",
    });

    expect(artifact.nodes).toHaveLength(1);
    const node = artifact.nodes[0] as ToolNode;
    expect(node.type).toBe("tool");
    expect(node.toolName).toBe("unknown.tool");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no resolved tool at path");
  });

  it('defaults name to "flow-pipeline" and version to "0.1.0" when omitted', () => {
    const resolver = makeResolver(["svc.x"]);
    const resolved = buildResolved(resolver, [
      { nodePath: "root", toolRef: "svc.x" },
    ]);

    const { artifact } = lowerPipelineFlat({
      ast: action("svc.x"),
      resolved,
      resolvedPersonas: new Map(),
      _idGen: makeIdGen("d"),
    });

    expect(artifact.name).toBe("flow-pipeline");
    expect(artifact.version).toBe("0.1.0");
  });

  it("gold-file: branch(then, else) → action wires BOTH branch tails into the continuation", () => {
    /*
     * Regression for FLOW-H-01: branch lowering previously exposed only the
     * last node emitted (the else-tail) as terminal, so the then-path
     * dead-ended after the branch resolved. A `branch → action` flow must
     * connect BOTH the then-tail AND the else-tail to the following action.
     *
     * AST shape:
     *   sequence
     *     [0] branch(condition='flag')
     *           then:  [action('path.yes')]
     *           else:  [action('path.no')]
     *     [1] action('after.join')
     *
     * Expected nodes (in order):
     *   GateNode  (b-1)  ← branch gate
     *   ToolNode  (b-2)  ← path.yes (then-tail)
     *   ToolNode  (b-3)  ← path.no  (else-tail)
     *   ToolNode  (b-5)  ← after.join (continuation)
     *
     * Expected sequential continuation edges:
     *   b-2 (then-tail) → b-5 (continuation)
     *   b-3 (else-tail) → b-5 (continuation)
     */
    const resolver = makeResolver(["path.yes", "path.no", "after.join"]);
    const ast = sequence(
      branch("flag", [action("path.yes")], [action("path.no")]),
      action("after.join")
    );
    const resolved = buildResolved(resolver, [
      { nodePath: "root.nodes[0].then[0]", toolRef: "path.yes" },
      { nodePath: "root.nodes[0].else[0]", toolRef: "path.no" },
      { nodePath: "root.nodes[1]", toolRef: "after.join" },
    ]);

    const { artifact, warnings } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      name: "branch-then-action",
      _idGen: makeIdGen("b"),
    });

    expect(warnings).toHaveLength(0);

    // gate, then-tool, else-tool, continuation-tool — no extra join node.
    expect(artifact.nodes.map((n) => n.type)).toEqual([
      "gate",
      "tool",
      "tool",
      "tool",
    ]);

    const gateNode = artifact.nodes[0] as GateNode;
    const thenNode = artifact.nodes[1] as ToolNode;
    const elseNode = artifact.nodes[2] as ToolNode;
    const continuationNode = artifact.nodes[3] as ToolNode;

    expect(gateNode.type).toBe("gate");
    expect(thenNode.toolName).toBe("path.yes");
    expect(elseNode.toolName).toBe("path.no");
    expect(continuationNode.toolName).toBe("after.join");
    expect(artifact.entryNodeId).toBe(gateNode.id);

    // The gate fans out to both then and else via a single conditional edge.
    const condEdges = artifact.edges.filter((e) => e.type === "conditional");
    expect(condEdges).toHaveLength(1);
    const condEdge = condEdges[0];
    if (condEdge?.type === "conditional") {
      expect(condEdge.sourceNodeId).toBe(gateNode.id);
      expect(condEdge.branches["true"]).toBe(thenNode.id);
      expect(condEdge.branches["false"]).toBe(elseNode.id);
    }

    // BOTH tails must connect to the continuation action — this is the fix.
    const seqPairs = artifact.edges
      .filter((e) => e.type === "sequential")
      .map((e) =>
        e.type === "sequential" ? `${e.sourceNodeId}->${e.targetNodeId}` : ""
      );

    expect(seqPairs).toContain(`${thenNode.id}->${continuationNode.id}`);
    expect(seqPairs).toContain(`${elseNode.id}->${continuationNode.id}`);

    // No dangling node: the continuation has exactly two inbound sequential
    // edges (one per branch path) and no node is left without an inbound edge
    // except the entry gate.
    const inboundCount = new Map<string, number>();
    for (const e of artifact.edges) {
      if (e.type === "sequential") {
        inboundCount.set(
          e.targetNodeId,
          (inboundCount.get(e.targetNodeId) ?? 0) + 1
        );
      } else if (e.type === "conditional") {
        for (const target of Object.values(e.branches)) {
          inboundCount.set(target, (inboundCount.get(target) ?? 0) + 1);
        }
      }
    }
    expect(inboundCount.get(continuationNode.id)).toBe(2);
    expect(inboundCount.get(thenNode.id)).toBe(1);
    expect(inboundCount.get(elseNode.id)).toBe(1);
    // Entry gate has no inbound edges.
    expect(inboundCount.get(gateNode.id)).toBeUndefined();
  });

  it("branch(then-only) → action wires both the then-tail and the gate false-path into the continuation", () => {
    /*
     * Regression for FLOW-H-01: a branch with no `else` must still route its
     * `false` outcome to the continuation — otherwise the false-path dead-ends.
     * The gate itself is the false-path tail, so the continuation receives an
     * edge from the then-tail AND from the gate.
     */
    const resolver = makeResolver(["path.yes", "after.join"]);
    const ast = sequence(
      branch("flag", [action("path.yes")]),
      action("after.join")
    );
    const resolved = buildResolved(resolver, [
      { nodePath: "root.nodes[0].then[0]", toolRef: "path.yes" },
      { nodePath: "root.nodes[1]", toolRef: "after.join" },
    ]);

    const { artifact, warnings } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      name: "branch-then-only-action",
      _idGen: makeIdGen("t"),
    });

    expect(warnings).toHaveLength(0);
    expect(artifact.nodes.map((n) => n.type)).toEqual(["gate", "tool", "tool"]);

    const gateNode = artifact.nodes[0] as GateNode;
    const thenNode = artifact.nodes[1] as ToolNode;
    const continuationNode = artifact.nodes[2] as ToolNode;

    const seqPairs = artifact.edges
      .filter((e) => e.type === "sequential")
      .map((e) =>
        e.type === "sequential" ? `${e.sourceNodeId}->${e.targetNodeId}` : ""
      );

    // then-tail → continuation (true path) and gate → continuation (false path)
    expect(seqPairs).toContain(`${thenNode.id}->${continuationNode.id}`);
    expect(seqPairs).toContain(`${gateNode.id}->${continuationNode.id}`);
  });

  it("branch with else branch produces two conditional branches", () => {
    const resolver = makeResolver(["path.yes", "path.no"]);
    const ast = branch("flag", [action("path.yes")], [action("path.no")]);
    const resolved = buildResolved(resolver, [
      { nodePath: "root.then[0]", toolRef: "path.yes" },
      { nodePath: "root.else[0]", toolRef: "path.no" },
    ]);

    const { artifact } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      _idGen: makeIdGen("b"),
    });

    // gate + then ToolNode + else ToolNode
    expect(artifact.nodes).toHaveLength(3);
    expect(artifact.nodes[0]?.type).toBe("gate");

    const condEdges = artifact.edges.filter((e) => e.type === "conditional");
    expect(condEdges).toHaveLength(1);
    const condEdge = condEdges[0];
    if (condEdge?.type === "conditional") {
      expect(Object.keys(condEdge.branches)).toEqual(
        expect.arrayContaining(["true", "false"])
      );
    }
  });
});

// ---------------------------------------------------------------------------
// W1 durability wiring — T5 (no-op half) / T6 / T7 (lowering half)
// ---------------------------------------------------------------------------

describe("lowerPipelineFlat — W1 durability wiring (T5, T7)", () => {
  it("T5: a bare action with NO durability decls lowers WITHOUT declaredIdempotencyKey/idempotency/effectClass (byte-identical no-op)", () => {
    const resolver = makeResolver(["tools.read"]);
    const resolved = buildResolved(resolver, [
      { nodePath: "root", toolRef: "tools.read" },
    ]);
    const ast: ActionNode = {
      type: "action",
      toolRef: "tools.read",
      input: { id: 1 },
      // No idempotency / effectClass / meta.mutation.
    };

    const { artifact, warnings } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      name: "plain-action",
      _idGen: makeIdGen("plain"),
    });

    const node = artifact.nodes[0] as ToolNode;
    expect(warnings).toHaveLength(0);
    expect(node.type).toBe("tool");
    expect(node.toolName).toBe("tools.read");
    expect(node.arguments).toEqual({ id: 1 });

    // No-op: the W1 fields must be entirely absent, not present-but-undefined.
    expect("declaredIdempotencyKey" in node).toBe(false);
    expect("idempotency" in node).toBe(false);
    expect("effectClass" in node).toBe(false);
  });

  it("T5: an agent-kind action with NO durability decls also lowers without W1 fields", () => {
    const registry = new InMemoryDomainToolRegistry();
    registry.register({
      name: "agents.researcher",
      description: "test agent",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      permissionLevel: "read",
      sideEffects: [],
      namespace: "agents",
    });
    const agentDef = registry.get("agents.researcher");
    if (agentDef === undefined) {
      throw new Error("test setup: agents.researcher not registered");
    }
    const resolved = new Map<string, ResolvedTool>([
      [
        "root",
        {
          ref: "agent-1",
          kind: "agent" as const,
          inputSchema: { type: "object" },
          handle: agentDef,
        },
      ],
    ]);
    const ast: ActionNode = {
      type: "action",
      toolRef: "agents.researcher",
      input: {},
    };

    const { artifact, warnings } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      name: "plain-agent-action",
      _idGen: makeIdGen("agent-plain"),
    });

    expect(warnings).toHaveLength(0);
    const node = artifact.nodes[0];
    expect(node).toBeDefined();
    const agentNode = node as AgentNode;
    expect(agentNode.type).toBe("agent");
    expect("declaredIdempotencyKey" in agentNode).toBe(false);
    expect("idempotency" in agentNode).toBe(false);
    expect("effectClass" in agentNode).toBe(false);
  });

  it("T7: round-trip — a lowered action WITH decls honors the declared key when fed through nodeIdempotencyContext-shaped access; WITHOUT decls yields identical field-shape to the pre-W1 baseline", () => {
    const resolver = makeResolver(["tools.write"]);
    const resolved = buildResolved(resolver, [
      { nodePath: "root", toolRef: "tools.write" },
    ]);

    const astWithDecls: ActionNode = {
      type: "action",
      toolRef: "tools.write",
      input: { id: 1 },
      idempotency: "exactly-once-required",
      effectClass: "db_write",
      meta: {
        mutation: {
          policy: "mutating",
          idempotencyKey: "ticket-456",
        },
      },
    };
    const astWithoutDecls: ActionNode = {
      type: "action",
      toolRef: "tools.write",
      input: { id: 1 },
    };

    const withDecls = lowerPipelineFlat({
      ast: astWithDecls,
      resolved,
      resolvedPersonas: new Map(),
      name: "roundtrip-with",
      _idGen: makeIdGen("rt-with"),
    });
    const withoutDecls = lowerPipelineFlat({
      ast: astWithoutDecls,
      resolved,
      resolvedPersonas: new Map(),
      name: "roundtrip-without",
      _idGen: makeIdGen("rt-without"),
    });

    const nodeWithDecls = withDecls.artifact.nodes[0] as ToolNode;
    const nodeWithoutDecls = withoutDecls.artifact.nodes[0] as ToolNode;

    // The declared node carries exactly the fields the runtime's
    // nodeIdempotencyContext reads to short-circuit to the declared key
    // (dzup:v1:declared:ticket-456) — see the agent-package T7 runtime half
    // in packages/agent/src/__tests__/pipeline-idempotency.test.ts, which
    // asserts this exact node shape produces that literal key. Cross-package
    // import of the runtime honor functions is avoided here since
    // @dzupagent/flow-compiler does not depend on @dzupagent/agent.
    expect(nodeWithDecls.declaredIdempotencyKey).toBe("ticket-456");
    expect(nodeWithDecls.idempotency).toBe("exactly-once-required");
    expect(nodeWithDecls.effectClass).toBe("db_write");

    // The undeclared node's field-shape is identical to the pre-W1 baseline:
    // no W1 keys present at all (not just undefined-valued).
    expect("declaredIdempotencyKey" in nodeWithoutDecls).toBe(false);
    expect("idempotency" in nodeWithoutDecls).toBe(false);
    expect("effectClass" in nodeWithoutDecls).toBe(false);
    expect(nodeWithoutDecls).toMatchObject({
      type: "tool",
      toolName: "tools.write",
      arguments: { id: 1 },
    });
  });
});

describe("lowerPipelineFlat — W1 Slice 2 document checkpoint strategy", () => {
  it("does NOT set checkpointStrategy when the input omits it (byte-identical no-op)", () => {
    const resolver = makeResolver(["tools.read"]);
    const resolved = buildResolved(resolver, [
      { nodePath: "root", toolRef: "tools.read" },
    ]);
    const ast: ActionNode = {
      type: "action",
      toolRef: "tools.read",
      input: {},
    };

    const { artifact } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      name: "no-strategy",
      _idGen: makeIdGen("no-strat"),
    });

    // Absent ⇒ the key must not be present at all, not present-but-undefined.
    expect("checkpointStrategy" in artifact).toBe(false);
  });

  it("stamps the translated runtime checkpointStrategy on the artifact when provided", () => {
    const resolver = makeResolver(["tools.read"]);
    const resolved = buildResolved(resolver, [
      { nodePath: "root", toolRef: "tools.read" },
    ]);
    const ast: ActionNode = {
      type: "action",
      toolRef: "tools.read",
      input: {},
    };

    const { artifact } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      name: "with-strategy",
      checkpointStrategy: "manual",
      _idGen: makeIdGen("with-strat"),
    });

    expect(artifact.checkpointStrategy).toBe("manual");
  });
});
