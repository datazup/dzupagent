/**
 * F-R4 runtime join — registering the typed-loop continue predicate.
 *
 * `lowerTypedLoop` names a `loopTyped__*` predicate but deliberately does not
 * register it, so a host without a reviewed evaluator fails closed. These
 * tests pin the bridge that closes that seam: the registry is keyed by the
 * exact name the artifact carries, evaluation is capability-gated, and a
 * condition that cannot be decided throws rather than guessing a direction.
 *
 * Predicates are built from a REAL lowered artifact rather than a hand-written
 * LoopNode — a fixture that drifts from what the compiler emits would pin
 * nothing. The `false`/`true` continuation cases vary only the bindings, so
 * neither direction can pass vacuously.
 */
import type {
  ActionNode,
  FlowNode,
  ResolvedTool,
  ToolResolver,
} from "@dzupagent/flow-ast";
import type { LoopNode, PipelineNode } from "@dzupagent/core/pipeline";
import { InMemoryDomainToolRegistry } from "@dzupagent/app-tools";
import { describe, expect, it } from "vitest";

import { lowerPipelineLoop } from "../lower/lower-pipeline-loop.js";
import {
  FLOW_TYPED_CONDITION_CAPABILITY,
  TypedLoopPredicateError,
  createTypedLoopPredicate,
  createTypedLoopPredicates,
} from "../typed-loop-predicates.js";

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

/** `status == "pending"` — true while polling should continue. */
const EXPRESSION = {
  op: "eq",
  left: { op: "ref", path: "state.status" },
  right: { op: "literal", value: "pending" },
} as const;

const action = (toolRef: string): ActionNode => ({
  type: "action",
  toolRef,
  input: {},
});

function lowerLoop(loopFields: Record<string, unknown>): {
  nodes: readonly PipelineNode[];
} {
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
  const { artifact } = lowerPipelineLoop({
    ast,
    resolved,
    resolvedPersonas: new Map(),
    idGen: makeIdGen(),
    id: "pipeline-1",
  });
  return { nodes: artifact.nodes };
}

/** A `for_each` loop — lowers to a real LoopNode that carries no typedWhile. */
function lowerForEachLoop(): readonly PipelineNode[] {
  const resolver = makeResolver(["items.process"]);
  const resolved = new Map<string, ResolvedTool>();
  const rt = resolver.resolve("items.process");
  if (rt !== null) resolved.set("root.body[0]", rt);
  const ast: FlowNode = {
    type: "for_each",
    source: "$.items",
    as: "item",
    body: [action("items.process")],
  } as FlowNode;
  const { artifact } = lowerPipelineLoop({
    ast,
    resolved,
    resolvedPersonas: new Map(),
    idGen: makeIdGen(),
    id: "pipeline-foreach",
  });
  return artifact.nodes;
}

function typedLoopNodes(): readonly PipelineNode[] {
  return lowerLoop({
    typedCondition: {
      schema: "dzupagent.flowTypedCondition/v1",
      expression: EXPRESSION,
    },
  }).nodes;
}

function loopNodeOf(nodes: readonly PipelineNode[]): LoopNode {
  const node = nodes.find((n) => n.type === "loop");
  if (node === undefined) throw new Error("expected a lowered LoopNode");
  return node as LoopNode;
}

const GRANTED = {
  hostCapabilities: [FLOW_TYPED_CONDITION_CAPABILITY],
} as const;

describe("F-R4 — typed loop predicate registration", () => {
  it("registers under the exact predicate name the lowered artifact carries", () => {
    const nodes = typedLoopNodes();
    const loopNode = loopNodeOf(nodes);

    const predicates = createTypedLoopPredicates(nodes, GRANTED);

    // The name is the contract between compile and runtime: if lowering renames
    // the predicate, executeLoop's lookup misses and this catches it.
    expect(loopNode.continuePredicateName).toBe("loopTyped__poll__predicate");
    expect(Object.keys(predicates)).toEqual(["loopTyped__poll__predicate"]);
  });

  it("continues while the typed condition holds and stops when it releases", () => {
    const nodes = typedLoopNodes();
    const predicate =
      createTypedLoopPredicates(nodes, GRANTED)["loopTyped__poll__predicate"];
    if (predicate === undefined) throw new Error("predicate not registered");

    // Only the bindings vary between these two assertions — same predicate,
    // same capabilities — so neither direction can pass vacuously.
    expect(predicate({ state: { status: "pending" } })).toBe(true);
    expect(predicate({ state: { status: "done" } })).toBe(false);
  });

  it("skips a string-condition loop, which lowers to no LoopNode at all", () => {
    // A legacy string-condition loop keeps the flattened lowering. Proves
    // registration is conditioned on the typed contract rather than blanket —
    // but note it never reaches the typedWhile guard, since there is no loop
    // node to inspect. The forEach case below is what exercises that guard.
    const nodes = lowerLoop({}).nodes;

    expect(nodes.some((n) => n.type === "loop")).toBe(false);
    expect(createTypedLoopPredicates(nodes, GRANTED)).toEqual({});
  });

  it("skips a forEach LoopNode, which carries no typedWhile contract", () => {
    // forEach DOES lower to a real LoopNode with its own predicate name, so
    // this is the case that actually exercises the typedWhile skip guard:
    // registering here would shadow the forEach executor's own predicate.
    const nodes = lowerForEachLoop();
    const loopNode = loopNodeOf(nodes);

    expect(loopNode.typedWhile).toBeUndefined();
    expect(loopNode.continuePredicateName).toBe("forEach__item__predicate");
    expect(createTypedLoopPredicates(nodes, GRANTED)).toEqual({});
  });

  it("fails closed when the host does not advertise the capability", () => {
    const nodes = typedLoopNodes();
    const predicate = createTypedLoopPredicates(nodes, {
      hostCapabilities: [],
    })["loopTyped__poll__predicate"];
    if (predicate === undefined) throw new Error("predicate not registered");

    // Bindings that WOULD satisfy the condition — isolating capability as the
    // only reason this fails, so the gate cannot pass for the wrong reason.
    expect(() => predicate({ state: { status: "pending" } })).toThrow(
      TypedLoopPredicateError
    );
    try {
      predicate({ state: { status: "pending" } });
      expect.unreachable("capability gate must reject");
    } catch (error) {
      expect((error as TypedLoopPredicateError).code).toBe(
        "TYPED_CONDITION_CAPABILITY_REQUIRED"
      );
    }
  });

  it("throws rather than guessing when a reference is missing", () => {
    const nodes = typedLoopNodes();
    const predicate =
      createTypedLoopPredicates(nodes, GRANTED)["loopTyped__poll__predicate"];
    if (predicate === undefined) throw new Error("predicate not registered");

    // `status` unbound: neither continuing nor stopping is defensible, so the
    // predicate must surface the failure instead of returning a boolean.
    try {
      predicate({});
      expect.unreachable("missing reference must not decide continuation");
    } catch (error) {
      expect(error).toBeInstanceOf(TypedLoopPredicateError);
      expect((error as TypedLoopPredicateError).code).toBe(
        "TYPED_REFERENCE_MISSING"
      );
      expect((error as TypedLoopPredicateError).nodeId).toBe(
        loopNodeOf(nodes).id
      );
    }
  });

  it("decides equality across types as false rather than failing", () => {
    const nodes = typedLoopNodes();
    const predicate =
      createTypedLoopPredicates(nodes, GRANTED)["loopTyped__poll__predicate"];
    if (predicate === undefined) throw new Error("predicate not registered");

    // Structural equality across types is DEFINED as false by the evaluator —
    // an object is simply not the string "pending". Pinned so the error cases
    // below are known to be genuine failures rather than blanket strictness.
    expect(predicate({ state: { status: { nested: true } } })).toBe(false);
  });

  it("throws when an ordered comparison cannot be decided", () => {
    // `attempts >= 3` — unlike eq, an ordered comparison between a string and
    // a number has no defensible answer, so continuation stays undecided.
    const nodes = lowerLoop({
      typedCondition: {
        schema: "dzupagent.flowTypedCondition/v1",
        expression: {
          op: "gte",
          left: { op: "ref", path: "state.attempts" },
          right: { op: "literal", value: 3 },
        },
      },
    }).nodes;
    const predicate =
      createTypedLoopPredicates(nodes, GRANTED)["loopTyped__poll__predicate"];
    if (predicate === undefined) throw new Error("predicate not registered");

    // A numeric binding decides normally — isolating the type mismatch below
    // as the only reason that call fails.
    expect(predicate({ state: { attempts: 5 } })).toBe(true);

    try {
      predicate({ state: { attempts: "many" } });
      expect.unreachable("type mismatch must not decide continuation");
    } catch (error) {
      expect(error).toBeInstanceOf(TypedLoopPredicateError);
      expect((error as TypedLoopPredicateError).code).toBe(
        "TYPED_CONDITION_TYPE_MISMATCH"
      );
    }
  });

  it("rejects building a predicate for a loop carrying no typedWhile", () => {
    const loopNode = {
      id: "n-1",
      type: "loop",
      name: "loop:legacy",
      bodyNodeIds: [],
      maxIterations: 5,
      continuePredicateName: "legacy__predicate",
    } as LoopNode;

    expect(() => createTypedLoopPredicate(loopNode, GRANTED)).toThrow(
      /carries no typedWhile contract/
    );
  });
});
