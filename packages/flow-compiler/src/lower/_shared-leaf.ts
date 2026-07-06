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
} from "@dzupagent/flow-ast";
import type {
  AgentNode,
  LoopNode,
  SuspendNode,
  ToolNode,
} from "@dzupagent/core/orchestration";

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from "./_shared-types.js";
import { nodeDurabilityFields } from "./_shared-durability.js";
import { freshId, loweringMode, lowerChildren } from "./_shared-utils.js";

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
        `${message}; executable lowering rejects unresolved semantic references`,
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
    ...durability,
  };
  return { nodes: [toolNode], edges: [], warnings };
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
      `router-contract violation: for_each in flat target at ${path}`,
    );
  }

  // Lower the body nodes as a sequence
  const bodyResult = lowerChildren(
    node.body,
    ctx,
    (idx) => `${path}.body[${idx}]`,
    lowerOne,
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
  return {
    nodes: [loopNode, ...bodyResult.nodes],
    edges: bodyResult.edges,
    warnings: bodyResult.warnings,
    tailNodeIds: [loopNode.id],
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
  return { nodes: [suspendNode], edges: [], warnings: [] };
}
