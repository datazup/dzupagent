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
import type { LoopNode } from "@dzupagent/core/pipeline";
import { PipelineDefinitionSchema } from "@dzupagent/core/pipeline";
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

describe("F-R4 — typed loop lowering", () => {
  it("lowers a typed-condition loop to a LoopNode carrying the typedWhile contract", () => {
    const { artifact, warnings } = lowerLoop({
      typedCondition: {
        schema: "dzupagent.flowTypedCondition/v1",
        expression: EXPRESSION,
      },
      maxIterations: 7,
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
    expect(loopNode.typedWhile).toEqual({
      conditionSchema: "dzupagent.flowTypedCondition/v1",
      condition: EXPRESSION,
      onExhausted: "fail",
      progressKey: "poll-step",
    });
    expect(loopNode.maxIterations).toBe(7);
    // Exhaustion is fail-closed for typed while-loops.
    expect(loopNode.failOnMaxIterations).toBe(true);
    // Registered-name indirection: unregistered predicate = fail closed.
    expect(loopNode.continuePredicateName).toBe("loopTyped__poll__predicate");
    // The lowered body action is wrapped, not lost.
    expect(loopNode.bodyNodeIds).toHaveLength(1);
    const bodyId = loopNode.bodyNodeIds[0];
    expect(artifact.nodes.some((node) => node.id === bodyId)).toBe(true);

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
});
