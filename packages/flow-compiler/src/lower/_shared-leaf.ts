/**
 * _shared-leaf.ts — Per-variant lowerers for leaf and self-contained nodes:
 * action, for_each, clarification, complete.
 *
 * These lowerers either produce no children (leaf) or own their own body
 * lowering and do not pair with composite control-flow constructs.
 *
 * @module lower/_shared-leaf
 */

import type {
  ActionNode,
  ClarificationNode,
  CompleteNode,
  FlowNode,
  ForEachNode,
  LoopNode as FlowLoopNode,
} from "@dzupagent/flow-ast";
import type {
  AgentNode,
  LoopNode,
  PipelineNodeSource,
  SuspendNode,
  ToolNode,
} from "@dzupagent/core/orchestration";

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from "./_shared-types.js";
import { nodeDurabilityFields } from "./_shared-durability.js";
import {
  freshId,
  loweringMode,
  lowerChildren,
  portsOf,
} from "./_shared-utils.js";

/**
 * action → look up resolved tool, emit ToolNode or AgentNode depending on kind.
 */
export function lowerAction(
  node: ActionNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: (
    child: FlowNode,
    ctx: LowerPipelineContext,
    path: string
  ) => LowerPipelineResult
): LowerPipelineResult {
  void lowerOne; // action has no children but signature kept symmetric
  const warnings: string[] = [];
  const rt = ctx.resolved.get(path);
  const durability = nodeDurabilityFields(node);

  if (rt === undefined) {
    const message = `lower/action: no resolved tool at path '${path}' (toolRef='${node.toolRef}')`;
    if (loweringMode(ctx) === "executable") {
      throw new Error(
        `${message}; executable lowering rejects unresolved semantic references`
      );
    }

    warnings.push(`${message}; emitting diagnostic stub`);
    const stub: ToolNode = {
      id: freshId(ctx),
      type: "tool",
      name: node.toolRef,
      toolName: node.toolRef,
      arguments: node.input,
      ...durability,
    };
    return { nodes: [stub], edges: [], warnings };
  }

  const id = freshId(ctx);
  const source = flowNodeSource(node, path);

  // W1 durability wiring (Slice 1): carry the node's declared per-node
  // durability from the AST onto the runtime node. Each field is only set when
  // declared, so an action with no durability decls lowers byte-identically to
  // before (the spread of `{}` is a no-op).
  if (rt.kind === "agent") {
    const agentNode: AgentNode = {
      id,
      type: "agent",
      name: node.toolRef,
      agentId: rt.ref,
      source,
      ...durability,
    };
    return { nodes: [agentNode], edges: [], warnings };
  }

  // mcp-tool | skill | workflow all lower to ToolNode
  const toolNode: ToolNode = {
    id,
    type: "tool",
    name: node.toolRef,
    toolName: rt.ref,
    arguments: node.input,
    source,
    ...durability,
  };
  return { nodes: [toolNode], edges: [], warnings };
}

function flowNodeSource(node: ActionNode, path: string): PipelineNodeSource {
  return {
    kind: "flow-node",
    path,
    nodeType: node.type,
    ...(node.id !== undefined ? { nodeId: node.id } : {}),
  };
}

/**
 * for_each — if allowForEach, emit a LoopNode wrapping the lowered body;
 * else throw a router-contract violation error.
 */
export function lowerForEach(
  node: ForEachNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: (
    child: FlowNode,
    ctx: LowerPipelineContext,
    path: string
  ) => LowerPipelineResult
): LowerPipelineResult {
  if (!ctx.allowForEach) {
    throw new Error(
      `router-contract violation: for_each in flat target at ${path}`
    );
  }

  // Lower the body nodes as a sequence
  const bodyResult = lowerChildren(
    node.body,
    ctx,
    (idx) => `${path}.body[${idx}]`,
    lowerOne
  );
  const bodyNodeIds = bodyResult.nodes.map((n) => n.id);

  const loopNode: LoopNode = {
    id: freshId(ctx),
    type: "loop",
    name: `forEach:${node.as}`,
    bodyNodeIds,
    maxIterations: 1000, // reasonable upper bound; runtime may override
    continuePredicateName: `forEach__${node.as}__predicate`,
    forEach: forEachContract(node),
    ...nodeDurabilityFields(node),
  };

  // The loop node acts as the container; body nodes remain in the flat list
  // alongside it. Sequential edges from the body are kept.
  //
  // The loop contract discards the body's NORMAL tails (iteration control
  // returns to the loop node), but the body's suspended/terminal exits are
  // real outcomes of the fragment — a `complete` inside the body ends the
  // whole flow — so the ports propagate them instead of swallowing them.
  const bodyPorts = portsOf(bodyResult);
  return {
    nodes: [loopNode, ...bodyResult.nodes],
    edges: bodyResult.edges,
    warnings: bodyResult.warnings,
    tailNodeIds: [loopNode.id],
    ports: {
      entryNodeIds: [loopNode.id],
      normalExits: [loopNode.id],
      suspendedExits: bodyPorts.suspendedExits,
      terminalExits: bodyPorts.terminalExits,
      errorExits: bodyPorts.errorExits,
    },
  };
}

/**
 * loop with a canonical typed condition — emit a LoopNode wrapping the
 * lowered body (F-R4), mirroring lowerForEach. The typed condition rides the
 * artifact as the `typedWhile` compile-time contract so a runtime holding a
 * reviewed evaluator can decide continuation without re-reading the AST.
 * The continue predicate keeps the registered-name indirection: a host that
 * never registers it fails closed at execution instead of iterating on
 * semantics it cannot evaluate. String-condition loops never reach here —
 * the composite dispatcher keeps their legacy flattened lowering.
 */
export function lowerTypedLoop(
  node: FlowLoopNode,
  ctx: LowerPipelineContext,
  path: string,
  lowerOne: (
    child: FlowNode,
    ctx: LowerPipelineContext,
    path: string
  ) => LowerPipelineResult
): LowerPipelineResult {
  if (!ctx.allowForEach) {
    throw new Error(
      `router-contract violation: typed loop in flat target at ${path}`
    );
  }
  const typedCondition = node.typedCondition;
  if (typedCondition === undefined) {
    throw new Error(
      `lowerTypedLoop: loop at ${path} has no typedCondition — dispatcher contract violated`
    );
  }

  const bodyResult = lowerChildren(
    node.body,
    ctx,
    (idx) => `${path}.body[${idx}]`,
    lowerOne
  );
  const bodyNodeIds = bodyResult.nodes.map((n) => n.id);

  const loopNode: LoopNode = {
    id: freshId(ctx),
    type: "loop",
    name: `loop:${node.id ?? path}`,
    bodyNodeIds,
    maxIterations: node.maxIterations ?? 100,
    continuePredicateName: `loopTyped__${node.id ?? path}__predicate`,
    // Exhaustion is fail-closed: a typed while-loop hitting maxIterations
    // means its condition never released — silently continuing would commit
    // downstream effects on a state the author declared not-ready. An
    // author-facing onExhausted override is R4-remainder for the R4+R6 join.
    failOnMaxIterations: true,
    typedWhile: {
      conditionSchema: typedCondition.schema,
      condition: typedCondition.expression as unknown as Record<
        string,
        unknown
      >,
      onExhausted: "fail",
      ...(node.progressKey !== undefined
        ? { progressKey: node.progressKey }
        : {}),
    },
    ...nodeDurabilityFields(node),
  };

  // Same port contract as lowerForEach: iteration control returns to the
  // loop node (body NORMAL tails are discarded) while suspended/terminal
  // exits of the body remain real outcomes of the fragment.
  const bodyPorts = portsOf(bodyResult);
  return {
    nodes: [loopNode, ...bodyResult.nodes],
    edges: bodyResult.edges,
    warnings: bodyResult.warnings,
    tailNodeIds: [loopNode.id],
    ports: {
      entryNodeIds: [loopNode.id],
      normalExits: [loopNode.id],
      suspendedExits: bodyPorts.suspendedExits,
      terminalExits: bodyPorts.terminalExits,
      errorExits: bodyPorts.errorExits,
    },
  };
}

function forEachContract(node: ForEachNode): NonNullable<LoopNode["forEach"]> {
  return {
    source: node.source,
    as: node.as,
    order: "input",
    ...(node.attachAs !== undefined ? { attachAs: node.attachAs } : {}),
    ...(node.collect !== undefined
      ? { collect: { ...node.collect, order: "input" } }
      : {}),
    ...(node.accumulator !== undefined
      ? { accumulator: node.accumulator }
      : {}),
    concurrency: node.concurrency ?? 1,
    failFast: node.failFast ?? false,
    empty: {
      body: "skip",
      aggregate: "empty-array",
    },
  };
}

/**
 * clarification → SuspendNode (leaf; no sub-graph).
 * The question and expected-input metadata are carried in the node name/description.
 */
export function lowerClarification(
  node: ClarificationNode,
  ctx: LowerPipelineContext,
  path: string
): LowerPipelineResult {
  const suspendNode: SuspendNode = {
    id: freshId(ctx),
    type: "suspend",
    name: `clarification:${path}`,
    description: node.question,
    resumeCondition:
      node.expected === "choice"
        ? `clarification__choice__${node.choices?.join("|") ?? ""}`
        : undefined,
    ...nodeDurabilityFields(node),
  };
  return { nodes: [suspendNode], edges: [], warnings: [] };
}

/**
 * complete → terminal SuspendNode (no outgoing edges; result is captured as
 * description since PipelineNode has no dedicated terminal type).
 */
export function lowerComplete(
  node: CompleteNode,
  ctx: LowerPipelineContext,
  path: string
): LowerPipelineResult {
  const suspendNode: SuspendNode = {
    id: freshId(ctx),
    type: "suspend",
    name: `complete:${path}`,
    description: node.result,
    // No resumeCondition — this node is terminal.
    ...nodeDurabilityFields(node),
  };
  // Empty tailNodeIds: terminal — no sibling may be wired after complete,
  // otherwise resume would continue past it along the sequential edge.
  return {
    nodes: [suspendNode],
    edges: [],
    warnings: [],
    tailNodeIds: [],
    ports: {
      entryNodeIds: [suspendNode.id],
      normalExits: [],
      suspendedExits: [],
      terminalExits: [suspendNode.id],
      errorExits: [],
    },
  };
}
