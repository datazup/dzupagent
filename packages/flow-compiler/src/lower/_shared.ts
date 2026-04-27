/**
 * _shared.ts — Shared lowering helper for pipeline lowerers.
 *
 * Both lower-pipeline-flat.ts (allowForEach: false) and
 * lower-pipeline-loop.ts (allowForEach: true) import from here.
 *
 * Maps each FlowNode variant to PipelineNode + PipelineEdge constructs
 * from @dzupagent/core pipeline-definition types.
 *
 * @module lower/_shared
 */

import type {
  ActionNode,
  ApprovalNode,
  BranchNode,
  ClarificationNode,
  CompleteNode,
  FlowNode,
  ForEachNode,
  ParallelNode,
  PersonaNode,
  ResolvedTool,
  RouteNode,
} from '@dzupagent/flow-ast'
import type {
  AgentHandle,
  AgentNode,
  ForkNode,
  GateNode,
  JoinNode,
  LoopNode,
  McpToolHandle,
  PipelineEdge,
  PipelineNode,
  SequentialEdge,
  SkillHandle,
  SuspendNode,
  ToolNode,
  WorkflowHandle,
} from '@dzupagent/core'

// Re-export handle types for internal consumers that previously imported
// them from this module. Keeps the public surface of this file stable while
// the canonical definitions now live in @dzupagent/core.
export type { AgentHandle, McpToolHandle, SkillHandle, WorkflowHandle }

// ---------------------------------------------------------------------------
// Context and result types
// ---------------------------------------------------------------------------

export interface LowerPipelineContext {
  resolved: Map<string, ResolvedTool>
  resolvedPersonas: Map<string, string>
  /**
   * lower-pipeline-flat passes false; lower-pipeline-loop passes true.
   * When false, encountering a for_each node throws a router-contract error.
   */
  allowForEach: boolean
  /**
   * ID generator for fresh node IDs.
   * Defaults to crypto.randomUUID when not provided.
   */
  idGen?: () => string
}

export interface LowerPipelineResult {
  /**
   * Flat list of PipelineNode objects produced by lowering this subtree.
   * Consumers accumulate these into PipelineDefinition.nodes.
   *
   * Type: PipelineNode[]
   */
  nodes: PipelineNode[]
  /**
   * Flat list of PipelineEdge objects produced by lowering this subtree.
   * Consumers accumulate these into PipelineDefinition.edges.
   */
  edges: PipelineEdge[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Narrowing helpers — cast ResolvedTool.handle by kind
//
// `ResolvedTool.handle` is typed `unknown` in flow-ast per ADR §5.3 (the AST
// package must not depend on runtime handle shapes). These helpers verify
// the `kind` discriminant, then perform the single sanctioned cast into the
// properly-typed handle interface exported by @dzupagent/core.
// ---------------------------------------------------------------------------

export function asSkillHandle(rt: ResolvedTool): SkillHandle {
  if (rt.kind !== 'skill') {
    throw new Error(
      `asSkillHandle: expected kind 'skill', got '${rt.kind}' for ref '${rt.ref}'`,
    )
  }
  return rt.handle as SkillHandle
}

export function asMcpToolHandle(rt: ResolvedTool): McpToolHandle {
  if (rt.kind !== 'mcp-tool') {
    throw new Error(
      `asMcpToolHandle: expected kind 'mcp-tool', got '${rt.kind}' for ref '${rt.ref}'`,
    )
  }
  return rt.handle as McpToolHandle
}

export function asWorkflowHandle(rt: ResolvedTool): WorkflowHandle {
  if (rt.kind !== 'workflow') {
    throw new Error(
      `asWorkflowHandle: expected kind 'workflow', got '${rt.kind}' for ref '${rt.ref}'`,
    )
  }
  return rt.handle as WorkflowHandle
}

export function asAgentHandle(rt: ResolvedTool): AgentHandle {
  if (rt.kind !== 'agent') {
    throw new Error(
      `asAgentHandle: expected kind 'agent', got '${rt.kind}' for ref '${rt.ref}'`,
    )
  }
  return rt.handle as AgentHandle
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function freshId(ctx: LowerPipelineContext): string {
  return ctx.idGen !== undefined ? ctx.idGen() : crypto.randomUUID()
}

function seqEdge(sourceNodeId: string, targetNodeId: string): SequentialEdge {
  return { type: 'sequential', sourceNodeId, targetNodeId }
}

/**
 * Chain a linear sequence of node IDs with sequential edges.
 * Returns edges connecting each consecutive pair.
 */
function chainEdges(nodeIds: string[]): SequentialEdge[] {
  const edges: SequentialEdge[] = []
  for (let i = 0; i < nodeIds.length - 1; i++) {
    const src = nodeIds[i]
    const tgt = nodeIds[i + 1]
    // noUncheckedIndexedAccess: both are defined by loop bounds
    if (src !== undefined && tgt !== undefined) {
      edges.push(seqEdge(src, tgt))
    }
  }
  return edges
}

/**
 * Merge an array of LowerPipelineResult into a single accumulator result.
 * Does NOT add any inter-result edges — callers are responsible for stitching.
 */
function mergeResults(parts: LowerPipelineResult[]): LowerPipelineResult {
  const nodes: PipelineNode[] = []
  const edges: PipelineEdge[] = []
  const warnings: string[] = []
  for (const part of parts) {
    nodes.push(...part.nodes)
    edges.push(...part.edges)
    warnings.push(...part.warnings)
  }
  return { nodes, edges, warnings }
}

// ---------------------------------------------------------------------------
// Main lowerer
// ---------------------------------------------------------------------------

/**
 * Lower a single FlowNode (and its subtree) into a flat list of
 * PipelineNode + PipelineEdge pairs.
 *
 * @param node  The FlowNode to lower.
 * @param ctx   Lowering context (resolver maps, allowForEach, idGen).
 * @param path  Dot-notation AST path (mirrors semantic stage keys) used for
 *              node naming and resolved-map lookups.
 */
export function lowerNodeToPipeline(
  node: FlowNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  switch (node.type) {
    case 'sequence':
      return lowerSequence(node.nodes, ctx, path)

    case 'action':
      return lowerAction(node, ctx, path)

    case 'for_each':
      return lowerForEach(node, ctx, path)

    case 'branch':
      return lowerBranch(node, ctx, path)

    case 'parallel':
      return lowerParallel(node, ctx, path)

    case 'approval':
      return lowerApproval(node, ctx, path)

    case 'clarification':
      return lowerClarification(node, ctx, path)

    case 'persona':
      return lowerPersona(node, ctx, path)

    case 'route':
      return lowerRoute(node, ctx, path)

    case 'complete':
      return lowerComplete(node, ctx, path)

    case 'spawn':
    case 'classify':
    case 'emit':
    case 'memory':
    case 'checkpoint':
    case 'restore':
      // These nodes are runtime-executed and not lowered to graph edges.
      return { nodes: [], edges: [], warnings: [] }

    default: {
      // Exhaustiveness guard — adding a FlowNode variant without a case fails here.
      const _exhaustive: never = node
      void _exhaustive
      return { nodes: [], edges: [], warnings: [] }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-variant lowerers
// ---------------------------------------------------------------------------

/**
 * sequence → recurse each child, concatenate, add sequential edges between
 * the last node of each child result and the first node of the next.
 */
function lowerSequence(
  children: FlowNode[],
  ctx: LowerPipelineContext,
  parentPath: string,
): LowerPipelineResult {
  if (children.length === 0) {
    return { nodes: [], edges: [], warnings: [] }
  }

  const parts: LowerPipelineResult[] = children.map((child, idx) =>
    lowerNodeToPipeline(child, ctx, `${parentPath}.nodes[${idx}]`),
  )

  const merged = mergeResults(parts)

  // Add sequential edges between last node of part[i] and first node of part[i+1]
  for (let i = 0; i < parts.length - 1; i++) {
    const cur = parts[i]
    const nxt = parts[i + 1]
    if (cur === undefined || nxt === undefined) continue
    const lastNode = cur.nodes[cur.nodes.length - 1]
    const firstNode = nxt.nodes[0]
    if (lastNode !== undefined && firstNode !== undefined) {
      merged.edges.push(seqEdge(lastNode.id, firstNode.id))
    }
  }

  return merged
}

/**
 * action → look up resolved tool, emit ToolNode or AgentNode depending on kind.
 */
function lowerAction(
  node: ActionNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  const warnings: string[] = []
  const rt = ctx.resolved.get(path)

  if (rt === undefined) {
    // Semantic stage should have already caught unresolved refs. Emit a warning
    // and produce a stub ToolNode so downstream lowerers can still proceed.
    warnings.push(
      `lower/action: no resolved tool at path '${path}' (toolRef='${node.toolRef}'); emitting stub`,
    )
    const stub: ToolNode = {
      id: freshId(ctx),
      type: 'tool',
      name: node.toolRef,
      toolName: node.toolRef,
      arguments: node.input,
    }
    return { nodes: [stub], edges: [], warnings }
  }

  const id = freshId(ctx)

  if (rt.kind === 'agent') {
    const agentNode: AgentNode = {
      id,
      type: 'agent',
      name: node.toolRef,
      agentId: rt.ref,
    }
    return { nodes: [agentNode], edges: [], warnings }
  }

  // mcp-tool | skill | workflow all lower to ToolNode
  const toolNode: ToolNode = {
    id,
    type: 'tool',
    name: node.toolRef,
    toolName: rt.ref,
    arguments: node.input,
  }
  return { nodes: [toolNode], edges: [], warnings }
}

/**
 * for_each — if allowForEach, emit a LoopNode wrapping the lowered body;
 * else throw a router-contract violation error.
 */
function lowerForEach(
  node: ForEachNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  if (!ctx.allowForEach) {
    throw new Error(
      `router-contract violation: for_each in flat target at ${path}`,
    )
  }

  // Lower the body nodes as a sequence
  const bodyResult = lowerSequence(node.body, ctx, `${path}.body`)
  const bodyNodeIds = bodyResult.nodes.map((n) => n.id)

  const loopNode: LoopNode = {
    id: freshId(ctx),
    type: 'loop',
    name: `forEach:${node.as}`,
    bodyNodeIds,
    maxIterations: 1000, // reasonable upper bound; runtime may override
    continuePredicateName: `forEach__${node.as}__predicate`,
  }

  // The loop node acts as the container; body nodes remain in the flat list
  // alongside it. Sequential edges from the body are kept.
  return {
    nodes: [loopNode, ...bodyResult.nodes],
    edges: bodyResult.edges,
    warnings: bodyResult.warnings,
  }
}

/**
 * branch → GateNode (condition) with conditional edge branching to then/else
 * sub-graphs.
 */
function lowerBranch(
  node: BranchNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  const gateId = freshId(ctx)
  const gateNode: GateNode = {
    id: gateId,
    type: 'gate',
    gateType: 'quality',
    name: `branch:${path}`,
    condition: node.condition,
  }

  const thenResult = lowerSequence(node.then, ctx, `${path}.then`)
  const elseResult =
    node.else !== undefined
      ? lowerSequence(node.else, ctx, `${path}.else`)
      : { nodes: [], edges: [], warnings: [] }

  const thenFirst = thenResult.nodes[0]
  const elseFirst = elseResult.nodes[0]

  const warnings: string[] = [
    ...thenResult.warnings,
    ...elseResult.warnings,
  ]

  // Build a ConditionalEdge from the gate to then/else branches
  const branchMap: Record<string, string> = {}
  if (thenFirst !== undefined) {
    branchMap['true'] = thenFirst.id
  }
  if (elseFirst !== undefined) {
    branchMap['false'] = elseFirst.id
  }

  const conditionalEdge: PipelineEdge = {
    type: 'conditional',
    sourceNodeId: gateId,
    predicateName: `branch__${gateId}__predicate`,
    branches: branchMap,
  }

  return {
    nodes: [gateNode, ...thenResult.nodes, ...elseResult.nodes],
    edges: [conditionalEdge, ...thenResult.edges, ...elseResult.edges],
    warnings,
  }
}

/**
 * parallel → ForkNode → (one branch per parallel branch) → JoinNode.
 * Each branch is lowered as a sequence; ForkNode and JoinNode share a forkId.
 */
function lowerParallel(
  node: ParallelNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  const forkId = freshId(ctx)
  const joinId = freshId(ctx)
  const sharedForkKey = forkId // stable key shared between Fork+Join

  const forkNode: ForkNode = {
    id: forkId,
    type: 'fork',
    name: `parallel-fork:${path}`,
    forkId: sharedForkKey,
  }

  const joinNode: JoinNode = {
    id: joinId,
    type: 'join',
    name: `parallel-join:${path}`,
    forkId: sharedForkKey,
    mergeStrategy: 'all',
  }

  const allNodes: PipelineNode[] = [forkNode]
  const allEdges: PipelineEdge[] = []
  const warnings: string[] = []

  for (let bIdx = 0; bIdx < node.branches.length; bIdx++) {
    const branch = node.branches[bIdx]
    if (branch === undefined) continue

    const branchResult = lowerSequence(branch, ctx, `${path}.branches[${bIdx}]`)
    allNodes.push(...branchResult.nodes)
    allEdges.push(...branchResult.edges)
    warnings.push(...branchResult.warnings)

    const firstNode = branchResult.nodes[0]
    const lastNode = branchResult.nodes[branchResult.nodes.length - 1]

    if (firstNode !== undefined) {
      allEdges.push(seqEdge(forkId, firstNode.id))
    }
    if (lastNode !== undefined) {
      allEdges.push(seqEdge(lastNode.id, joinId))
    }
  }

  allNodes.push(joinNode)

  return { nodes: allNodes, edges: allEdges, warnings }
}

/**
 * approval → GateNode(approval) suspend + onApprove/onReject branches.
 */
function lowerApproval(
  node: ApprovalNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  const gateId = freshId(ctx)
  const gateNode: GateNode = {
    id: gateId,
    type: 'gate',
    gateType: 'approval',
    name: `approval:${path}`,
    condition: node.question,
  }

  const approveResult = lowerSequence(node.onApprove, ctx, `${path}.onApprove`)
  const rejectResult =
    node.onReject !== undefined
      ? lowerSequence(node.onReject, ctx, `${path}.onReject`)
      : { nodes: [], edges: [], warnings: [] }

  const approveFirst = approveResult.nodes[0]
  const rejectFirst = rejectResult.nodes[0]

  const branchMap: Record<string, string> = {}
  if (approveFirst !== undefined) {
    branchMap['approved'] = approveFirst.id
  }
  if (rejectFirst !== undefined) {
    branchMap['rejected'] = rejectFirst.id
  }

  const conditionalEdge: PipelineEdge = {
    type: 'conditional',
    sourceNodeId: gateId,
    predicateName: `approval__${gateId}__predicate`,
    branches: branchMap,
  }

  return {
    nodes: [gateNode, ...approveResult.nodes, ...rejectResult.nodes],
    edges: [conditionalEdge, ...approveResult.edges, ...rejectResult.edges],
    warnings: [...approveResult.warnings, ...rejectResult.warnings],
  }
}

/**
 * clarification → SuspendNode (leaf; no sub-graph).
 * The question and expected-input metadata are carried in the node name/description.
 */
function lowerClarification(
  node: ClarificationNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  const suspendNode: SuspendNode = {
    id: freshId(ctx),
    type: 'suspend',
    name: `clarification:${path}`,
    description: node.question,
    resumeCondition: node.expected === 'choice'
      ? `clarification__choice__${node.choices?.join('|') ?? ''}`
      : undefined,
  }
  return { nodes: [suspendNode], edges: [], warnings: [] }
}

/**
 * persona → SuspendNode carrying persona metadata + lowered body sub-graph.
 * Uses ctx.resolvedPersonas to confirm the persona ref was resolved.
 */
function lowerPersona(
  node: PersonaNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  const warnings: string[] = []
  const confirmedPersona = ctx.resolvedPersonas.get(path)
  if (confirmedPersona === undefined) {
    warnings.push(
      `lower/persona: persona '${node.personaId}' not confirmed in resolvedPersonas at '${path}'`,
    )
  }

  const suspendId = freshId(ctx)
  const suspendNode: SuspendNode = {
    id: suspendId,
    type: 'suspend',
    name: `persona:${node.personaId}`,
    description: confirmedPersona ?? node.personaId,
    resumeCondition: `persona__${node.personaId}__activated`,
  }

  const bodyResult = lowerSequence(node.body, ctx, `${path}.body`)
  warnings.push(...bodyResult.warnings)

  const firstBodyNode = bodyResult.nodes[0]
  const edges: PipelineEdge[] = [...bodyResult.edges]
  if (firstBodyNode !== undefined) {
    edges.push(seqEdge(suspendId, firstBodyNode.id))
  }

  return {
    nodes: [suspendNode, ...bodyResult.nodes],
    edges,
    warnings,
  }
}

/**
 * route → SuspendNode with route metadata + lowered body sub-graph.
 * Strategy and provider/tags are carried in the node name/description.
 */
function lowerRoute(
  node: RouteNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  const suspendId = freshId(ctx)
  const routeMeta = node.provider ?? node.tags?.join(',') ?? node.strategy
  const suspendNode: SuspendNode = {
    id: suspendId,
    type: 'suspend',
    name: `route:${node.strategy}`,
    description: routeMeta,
    resumeCondition: `route__${node.strategy}__resolved`,
  }

  const bodyResult = lowerSequence(node.body, ctx, `${path}.body`)
  const firstBodyNode = bodyResult.nodes[0]
  const edges: PipelineEdge[] = [...bodyResult.edges]
  if (firstBodyNode !== undefined) {
    edges.push(seqEdge(suspendId, firstBodyNode.id))
  }

  return {
    nodes: [suspendNode, ...bodyResult.nodes],
    edges,
    warnings: bodyResult.warnings,
  }
}

/**
 * complete → terminal SuspendNode (no outgoing edges; result is captured as
 * description since PipelineNode has no dedicated terminal type).
 */
function lowerComplete(
  node: CompleteNode,
  ctx: LowerPipelineContext,
  path: string,
): LowerPipelineResult {
  const suspendNode: SuspendNode = {
    id: freshId(ctx),
    type: 'suspend',
    name: `complete:${path}`,
    description: node.result,
    // No resumeCondition — this node is terminal.
  }
  return { nodes: [suspendNode], edges: [], warnings: [] }
}

// Re-export chain-edge utility so lowerers can stitch top-level results
export { chainEdges }
