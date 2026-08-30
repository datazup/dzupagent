/**
 * F-R4 — Stage 4 lowering of a typed-condition `loop` to a real LoopNode.
 *
 * A loop carrying a canonical typedCondition lowers to
 * `PipelineDefinition.LoopNode` with the `typedWhile` compile-time contract
 * (condition schema + expression, fail-closed exhaustion, progressKey) and a
 * generated registered-predicate name — a host that never registers it fails
 * closed at execution. A legacy string-condition loop keeps the flattened
 * lowering (body only, no LoopNode): the negative control proving the
 * dispatcher is conditioned on typedCondition, not blanket.
 *
 * The emitted artifact must also survive the core serialization schema —
 * an artifact the store rejects is not an artifact.
 */
import type {
  ActionNode,
  FlowNode,
  ResolvedTool,
  ToolResolver,
} from "@dzupagent/flow-ast";
import type { LoopNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { PipelineDefinitionSchema } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { InMemoryDomainToolRegistry } from "@dzupagent/app-tools";
import { describe, expect, it } from "vitest";

import { lowerPipelineLoop } from "../lower/lower-pipeline-loop.js";

function makeIdGen(): () => string {
  let counter = 0;
  return () => `id-${counter++}`;
}

function makeResolver(toolNames: string[]): ToolResolver {
  const registry = new InMemoryDomainToolRegistry();
  for (const name of toolNames) {
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

const EXPRESSION = {
  op: "eq",
  left: { op: "ref", path: "status" },
  right: { op: "literal", value: "pending" },
} as const;

const action = (toolRef: string): ActionNode => ({
  type: "action",
  id: "poll-step",
  toolRef,
  input: {},
});

function lowerLoop(loopFields: Record<string, unknown>) {
  const resolver = makeResolver(["items.process"]);
  const resolved = new Map<string, ResolvedTool>();
  const rt = resolver.resolve("items.process");
  if (rt !== null) resolved.set("root.body[0]", rt);
  const ast: FlowNode = {
    type: "loop",
    id: "poll",
    condition: "false",
    body: [action("items.process")],
    ...loopFields,
  } as FlowNode;
  return lowerPipelineLoop({
    ast,
    resolved,
    resolvedPersonas: new Map(),
    idGen: makeIdGen(),
    id: "pipeline-1",
  });
}

function lowerStructuredBody(body: FlowNode[]) {
  const ast: FlowNode = {
    type: "loop",
    id: "poll",
    condition: "false",
    typedCondition: {
      schema: "dzupagent.flowTypedCondition/v1",
      expression: EXPRESSION,
    },
    body,
  };
  return lowerPipelineLoop({
    ast,
    resolved: new Map(),
    resolvedPersonas: new Map(),
    idGen: makeIdGen(),
    id: "structured-pipeline",
  });
}

describe("F-R4 — typed loop lowering", () => {
  it("lowers a typed-condition loop to a LoopNode carrying the typedWhile contract", () => {
    const { artifact, warnings } = lowerLoop({
      typedCondition: {
        schema: "dzupagent.flowTypedCondition/v1",
        expression: EXPRESSION,
      },
      maxIterations: 7,
      iterationTimeoutMs: 2500,
      iterationBudgetCents: 12.5,
      progressKey: "poll-step",
    });

    expect(warnings).toEqual([]);
    const loopNode = artifact.nodes.find(
      (node): node is LoopNode => node.type === "loop"
    );
    expect(loopNode).toBeDefined();
    if (loopNode === undefined) return;

    // The typed condition rides the artifact verbatim — F-R5 byte-identity
    // and the runtime evaluator both read THIS form.
    const bodyId = loopNode.bodyNodeIds[0];
    expect(loopNode.typedWhile).toEqual({
      conditionSchema: "dzupagent.flowTypedCondition/v1",
      condition: EXPRESSION,
      onExhausted: "fail",
      iterationTimeoutMs: 2500,
      iterationBudgetCents: 12.5,
      progressKey: bodyId,
    });
    expect(loopNode.maxIterations).toBe(7);
    // Exhaustion is fail-closed for typed while-loops.
    expect(loopNode.failOnMaxIterations).toBe(true);
    // Registered-name indirection: unregistered predicate = fail closed.
    expect(loopNode.continuePredicateName).toBe("loopTyped__poll__predicate");
    // The lowered body action is wrapped, not lost.
    expect(loopNode.bodyNodeIds).toHaveLength(1);
    expect(artifact.nodes.some((node) => node.id === bodyId)).toBe(true);
    expect(loopNode.bodyGraph).toEqual({
      entryNodeId: bodyId,
      normalExitNodeIds: [bodyId],
      suspendedExitNodeIds: [],
      suspensionSiteNodeIds: [],
      terminalExitNodeIds: [],
      errorExitNodeIds: [],
    });

    // The artifact must survive the core serialization schema.
    const parsed = PipelineDefinitionSchema.safeParse(artifact);
    expect(
      parsed.success,
      parsed.success ? "" : JSON.stringify(parsed.error.issues)
    ).toBe(true);
  });

  it("omits progressKey from typedWhile when the author did not set one", () => {
    const { artifact } = lowerLoop({
      typedCondition: {
        schema: "dzupagent.flowTypedCondition/v1",
        expression: EXPRESSION,
      },
    });

    const loopNode = artifact.nodes.find(
      (node): node is LoopNode => node.type === "loop"
    );
    expect(loopNode?.typedWhile).toBeDefined();
    expect(loopNode?.typedWhile?.progressKey).toBeUndefined();
    // Unset maxIterations falls back to the documented default.
    expect(loopNode?.maxIterations).toBe(100);
  });

  it("plumbs an authored continue exhaustion policy into a coherent artifact", () => {
    const { artifact } = lowerLoop({
      typedCondition: {
        schema: "dzupagent.flowTypedCondition/v1",
        expression: EXPRESSION,
      },
      maxIterations: 2,
      onExhausted: "continue",
    });

    const loopNode = artifact.nodes.find(
      (node): node is LoopNode => node.type === "loop"
    );
    expect(loopNode?.typedWhile?.onExhausted).toBe("continue");
    expect(loopNode?.failOnMaxIterations).toBe(false);
    expect(PipelineDefinitionSchema.safeParse(artifact).success).toBe(true);
  });

  it("keeps the legacy flattened lowering for string-condition loops (negative control)", () => {
    const { artifact } = lowerLoop({ condition: "{{ state.retry }}" });

    // No LoopNode: the body action is emitted directly, exactly as before
    // F-R4 — proving typed lowering is conditioned on typedCondition.
    expect(artifact.nodes.some((node) => node.type === "loop")).toBe(false);
    expect(artifact.nodes).toHaveLength(1);
    expect(artifact.nodes[0]?.type).toBe("tool");
  });

  it.each([
    [
      "branch",
      {
        type: "branch",
        condition: "true",
        then: [{ type: "set", id: "then", assign: { value: "then" } }],
        else: [{ type: "set", id: "else", assign: { value: "else" } }],
      } satisfies FlowNode,
      "gate",
    ],
    [
      "parallel",
      {
        type: "parallel",
        branches: [
          [{ type: "set", id: "left", assign: { left: true } }],
          [{ type: "set", id: "right", assign: { right: true } }],
        ],
      } satisfies FlowNode,
      "fork",
    ],
    [
      "try_catch",
      {
        type: "try_catch",
        body: [{ type: "set", id: "risky", assign: { risky: true } }],
        catch: [{ type: "set", id: "recover", assign: { caught: true } }],
      } satisfies FlowNode,
      "tool",
    ],
  ])("emits a bounded bodyGraph for structured %s", (_kind, body, entryType) => {
    const { artifact } = lowerStructuredBody([body]);
    const loop = artifact.nodes.find(
      (node): node is LoopNode => node.type === "loop"
    );
    expect(loop?.bodyGraph).toBeDefined();
    if (loop?.bodyGraph === undefined) return;

    expect(loop.bodyNodeIds).toContain(loop.bodyGraph.entryNodeId);
    expect(
      artifact.nodes.find(({ id }) => id === loop.bodyGraph?.entryNodeId)?.type
    ).toBe(entryType);
    for (const boundaryId of [
      ...loop.bodyGraph.normalExitNodeIds,
      ...loop.bodyGraph.suspendedExitNodeIds,
      ...loop.bodyGraph.terminalExitNodeIds,
      ...loop.bodyGraph.errorExitNodeIds,
    ]) {
      expect(loop.bodyNodeIds).toContain(boundaryId);
    }
    expect(artifact.edges.length).toBeGreaterThan(0);
    expect(PipelineDefinitionSchema.safeParse(artifact).success).toBe(true);
  });

  it("lowers complete as a terminal-only structured loop exit", () => {
    const { artifact } = lowerStructuredBody([
      { type: "complete", id: "complete", result: "done" },
    ]);
    const loop = artifact.nodes.find(
      (node): node is LoopNode => node.type === "loop"
    );
    expect(loop?.bodyGraph).toBeDefined();
    if (loop?.bodyGraph === undefined) return;

    expect(loop.bodyGraph.normalExitNodeIds).toEqual([]);
    expect(loop.bodyGraph.suspendedExitNodeIds).toEqual([]);
    expect(loop.bodyGraph.terminalExitNodeIds).toHaveLength(1);
    expect(loop.bodyGraph.terminalExitNodeIds[0]).toBe(
      loop.bodyGraph.entryNodeId
    );
    expect(PipelineDefinitionSchema.safeParse(artifact).success).toBe(true);
  });

  it("retains a terminal complete exit beside a normal conditional branch", () => {
    const { artifact } = lowerStructuredBody([
      {
        type: "branch",
        id: "decision",
        condition: "true",
        then: [{ type: "complete", id: "complete", result: "done" }],
        else: [{ type: "set", id: "continue", assign: { done: false } }],
      },
    ]);
    const loop = artifact.nodes.find(
      (node): node is LoopNode => node.type === "loop"
    );
    expect(loop?.bodyGraph).toBeDefined();
    if (loop?.bodyGraph === undefined) return;

    expect(loop.bodyGraph.normalExitNodeIds).not.toEqual([]);
    expect(loop.bodyGraph.terminalExitNodeIds).toHaveLength(1);
    expect(loop.bodyGraph.normalExitNodeIds).not.toContain(
      loop.bodyGraph.terminalExitNodeIds[0]
    );
    expect(PipelineDefinitionSchema.safeParse(artifact).success).toBe(true);
  });

  it("retains a terminal complete exit inside a try body", () => {
    const { artifact } = lowerStructuredBody([
      {
        type: "try_catch",
        id: "attempt",
        body: [{ type: "complete", id: "complete", result: "done" }],
        catch: [{ type: "set", id: "recover", assign: { caught: true } }],
      },
    ]);
    const loop = artifact.nodes.find(
      (node): node is LoopNode => node.type === "loop"
    );
    expect(loop?.bodyGraph).toBeDefined();
    if (loop?.bodyGraph === undefined) return;

    expect(loop.bodyGraph.terminalExitNodeIds).toHaveLength(1);
    expect(loop.bodyGraph.normalExitNodeIds).not.toContain(
      loop.bodyGraph.terminalExitNodeIds[0]
    );
    expect(PipelineDefinitionSchema.safeParse(artifact).success).toBe(true);
  });
});
