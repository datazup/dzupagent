/**
 * Stage 4 lowerer — skill-chain target.
 *
 * Receives a router-dispatched AST and emits a linear `SkillChain` artifact
 * plus an array of non-fatal warnings.
 *
 * The skill-chain target is intentionally linear: `SkillChainStep` supports
 * only `skillName`, `condition`, `suspendBefore`, `stateTransformer`,
 * `timeoutMs`, and `retryPolicy`. It cannot natively express forks, joins,
 * multi-branch dispatch, or suspend-with-branches.
 *
 * Per the Wave 12 parity audit, this lowerer must accept every non-`for_each`
 * FlowNode variant and perform a best-effort degradation, emitting warnings
 * whenever semantic fidelity is lost. Only `for_each` is a true
 * router-contract violation (pipeline-only).
 */

import type {
  ActionNode,
  ApprovalNode,
  BranchNode,
  ClarificationNode,
  CompleteNode,
  FlowNode,
  MemoryNode,
  ParallelNode,
  PersonaNode,
  ResolvedTool,
  RouteNode,
} from '@dzupagent/flow-ast'
import type { SkillChain, SkillChainStep, SkillHandle } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LowerSkillChainInput {
  ast: FlowNode
  resolved: Map<string, ResolvedTool>
  /**
   * Human-readable name for the emitted chain.
   * Defaults to `"flow"` when not provided.
   */
  name?: string
}

export function lowerSkillChain(input: LowerSkillChainInput): {
  artifact: SkillChain
  warnings: string[]
} {
  const warnings: string[] = []
  const steps: SkillChainStep[] = []

  walkNode(input.ast, 'root', input.resolved, steps, warnings)

  if (steps.length === 0) {
    throw new Error(
      'lowerSkillChain: no action nodes found in AST — cannot emit an empty SkillChain',
    )
  }

  const artifact: SkillChain = {
    name: input.name ?? 'flow',
    steps,
  }

  return { artifact, warnings }
}

// ---------------------------------------------------------------------------
// AST walk
// ---------------------------------------------------------------------------

function walkNode(
  node: FlowNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  steps: SkillChainStep[],
  warnings: string[],
): void {
  switch (node.type) {
    case 'sequence': {
      if (node.nodes.length === 1) {
        warnings.push(
          `Redundant single-child sequence wrapper at "${path}" — consider inlining the child node.`,
        )
      }
      for (let i = 0; i < node.nodes.length; i++) {
        const child = node.nodes[i]
        // noUncheckedIndexedAccess: child may be undefined (index out of bounds).
        // In practice this cannot happen because i < node.nodes.length, but we
        // must satisfy the compiler.
        if (child === undefined) continue
        walkNode(child, `${path}.nodes[${i}]`, resolved, steps, warnings)
      }
      return
    }

    case 'action': {
      const step = lowerAction(node, path, resolved, warnings)
      steps.push(step)
      return
    }

    case 'branch': {
      walkBranch(node, path, resolved, steps, warnings)
      return
    }

    case 'parallel': {
      walkParallel(node, path, resolved, steps, warnings)
      return
    }

    case 'approval': {
      walkApproval(node, path, resolved, steps, warnings)
      return
    }

    case 'clarification': {
      walkClarification(node, path, steps, warnings)
      return
    }

    case 'persona': {
      walkPersona(node, path, resolved, steps, warnings)
      return
    }

    case 'route': {
      walkRoute(node, path, resolved, steps, warnings)
      return
    }

    case 'complete': {
      walkComplete(node, path, warnings)
      return
    }

    case 'for_each': {
      // Router contract violated — for_each is pipeline-only per ADR.
      throw new Error(
        `lowerSkillChain: for_each node encountered at "${path}". ` +
          `for_each is a pipeline-only variant; the router must dispatch such ASTs to the pipeline-loop target.`,
      )
    }

    case 'spawn':
    case 'classify':
    case 'emit':
    case 'checkpoint':
    case 'restore': {
      // Runtime-executed nodes — no skill-chain step emitted; silently pass through.
      return
    }

    case 'memory': {
      walkMemory(node, path, steps)
      return
    }

    default: {
      // Exhaustiveness guard — adding a FlowNode variant without a case fails here.
      const _exhaustive: never = node
      void _exhaustive
      throw new Error(
        `lowerSkillChain: unexpected node type "${(node as FlowNode).type}" at "${path}".`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Action lowering
// ---------------------------------------------------------------------------

/**
 * OI-2 narrowing cast: check `rt.kind === 'skill'` then cast `handle`.
 * Returns `null` when the resolved tool is not a skill.
 */
function asSkillHandle(rt: ResolvedTool): SkillHandle | null {
  if (rt.kind !== 'skill') return null
  // Safe cast — `kind` discriminant verified above; no `any` used.
  return rt.handle as SkillHandle
}

function lowerAction(
  node: ActionNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  warnings: string[],
): SkillChainStep {
  const rt = resolved.get(path)

  if (rt === undefined) {
    // Semantic stage should have caught this; emit a warning and use the raw
    // toolRef so the chain can still be constructed for diagnostic purposes.
    warnings.push(
      `Action at "${path}" has no resolved tool entry — using toolRef "${node.toolRef}" as skillName.`,
    )
    return { skillName: node.toolRef }
  }

  const handle = asSkillHandle(rt)
  if (handle === null) {
    warnings.push(
      `Action at "${path}" resolved to kind "${rt.kind}" — expected "skill". Using ref "${rt.ref}" as skillName.`,
    )
    return { skillName: rt.ref }
  }

  // `handle` is now narrowed; `skillName` comes from the stable ref string.
  void handle // acknowledged — runtime use is by the executor, not this lowerer

  return { skillName: rt.ref }
}

// ---------------------------------------------------------------------------
// Non-action variant walkers (best-effort degradation)
// ---------------------------------------------------------------------------

/**
 * branch → linear concatenation of `then` followed by `else` bodies.
 *
 * Skill chains have no conditional-dispatch primitive that takes a string
 * predicate (SkillChainStep.condition is a runtime callback). We therefore
 * emit both bodies inline and warn — the runtime predicate in `node.condition`
 * is lost.
 */
function walkBranch(
  node: BranchNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  steps: SkillChainStep[],
  warnings: string[],
): void {
  warnings.push(
    `Branch at "${path}" (condition="${node.condition}") lowered as sequential then+else — ` +
      `skill-chain has no native conditional dispatch; predicate is dropped.`,
  )

  for (let i = 0; i < node.then.length; i++) {
    const child = node.then[i]
    if (child === undefined) continue
    walkNode(child, `${path}.then[${i}]`, resolved, steps, warnings)
  }

  if (node.else !== undefined) {
    for (let i = 0; i < node.else.length; i++) {
      const child = node.else[i]
      if (child === undefined) continue
      walkNode(child, `${path}.else[${i}]`, resolved, steps, warnings)
    }
  }
}

/**
 * parallel → sequential concatenation of all branches.
 *
 * Skill chains are linear; parallelism is lost. Each branch is walked in order.
 */
function walkParallel(
  node: ParallelNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  steps: SkillChainStep[],
  warnings: string[],
): void {
  warnings.push(
    `Parallel at "${path}" with ${node.branches.length} branches lowered as sequential — ` +
      `skill-chain has no fork/join; branches will run in order.`,
  )

  for (let bIdx = 0; bIdx < node.branches.length; bIdx++) {
    const branch = node.branches[bIdx]
    if (branch === undefined) continue
    for (let i = 0; i < branch.length; i++) {
      const child = branch[i]
      if (child === undefined) continue
      walkNode(child, `${path}.branches[${bIdx}][${i}]`, resolved, steps, warnings)
    }
  }
}

/**
 * approval → onApprove body with `suspendBefore: true` on the first step.
 *
 * The onReject body cannot be represented on the main linear chain and is
 * dropped with a warning.
 */
function walkApproval(
  node: ApprovalNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  steps: SkillChainStep[],
  warnings: string[],
): void {
  const before = steps.length

  for (let i = 0; i < node.onApprove.length; i++) {
    const child = node.onApprove[i]
    if (child === undefined) continue
    walkNode(child, `${path}.onApprove[${i}]`, resolved, steps, warnings)
  }

  // Mark the first newly-appended approval step for HITL suspension.
  if (steps.length > before) {
    const first = steps[before]
    if (first !== undefined) {
      steps[before] = { ...first, suspendBefore: true }
    }
  } else {
    warnings.push(
      `Approval at "${path}" (question="${node.question}") produced no onApprove steps — suspend hint skipped.`,
    )
  }

  if (node.onReject !== undefined && node.onReject.length > 0) {
    warnings.push(
      `Approval at "${path}" onReject body dropped — skill-chain cannot express branch-on-rejection; ` +
        `${node.onReject.length} reject step(s) lost.`,
    )
  }
}

/**
 * clarification → synthetic suspend step.
 *
 * The question is recorded as a synthetic skillName. suspendBefore is set so
 * the executor pauses for human input before the next real step.
 */
function walkClarification(
  node: ClarificationNode,
  path: string,
  steps: SkillChainStep[],
  warnings: string[],
): void {
  warnings.push(
    `Clarification at "${path}" (question="${node.question}") lowered as synthetic suspend step — ` +
      `skill-chain has no native clarification primitive.`,
  )

  const slug = slugify(node.question)
  steps.push({
    skillName: `__clarification__${slug}`,
    suspendBefore: true,
  })
}

/**
 * persona → body inlined; persona metadata dropped.
 */
function walkPersona(
  node: PersonaNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  steps: SkillChainStep[],
  warnings: string[],
): void {
  warnings.push(
    `Persona "${node.personaId}" at "${path}" lowered as inline body — ` +
      `skill-chain cannot carry persona binding metadata.`,
  )

  for (let i = 0; i < node.body.length; i++) {
    const child = node.body[i]
    if (child === undefined) continue
    walkNode(child, `${path}.body[${i}]`, resolved, steps, warnings)
  }
}

/**
 * route → body inlined; routing metadata dropped.
 */
function walkRoute(
  node: RouteNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  steps: SkillChainStep[],
  warnings: string[],
): void {
  const meta = node.provider ?? node.tags?.join(',') ?? node.strategy
  warnings.push(
    `Route (strategy="${node.strategy}", meta="${meta}") at "${path}" lowered as inline body — ` +
      `skill-chain cannot carry routing metadata.`,
  )

  for (let i = 0; i < node.body.length; i++) {
    const child = node.body[i]
    if (child === undefined) continue
    walkNode(child, `${path}.body[${i}]`, resolved, steps, warnings)
  }
}

/**
 * complete → no step emitted; chain terminus is implicit.
 */
function walkComplete(
  node: CompleteNode,
  path: string,
  warnings: string[],
): void {
  if (node.result !== undefined && node.result.length > 0) {
    warnings.push(
      `Complete at "${path}" (result="${node.result}") dropped — skill-chain has no terminal result field.`,
    )
  }
}

/**
 * memory → synthetic pass-through marker step.
 *
 * Skill chains have no native memory-operation primitive. We emit a
 * structured marker step so the executor can recognise and route the
 * operation at runtime without losing the operation/tier/key metadata.
 */
function walkMemory(
  node: MemoryNode,
  path: string,
  steps: SkillChainStep[],
): void {
  const keySuffix = node.key ? `_${slugify(node.key)}` : ''
  steps.push({
    skillName: `__memory__${node.operation}_${node.tier}${keySuffix}`,
    stateTransformer: (state: Record<string, unknown>) => ({
      ...state,
      __memoryOp: { operation: node.operation, tier: node.tier, key: node.key },
      __memoryPath: path,
    }),
  })
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Reduce a free-form string to a safe skillName suffix.
 * Keeps ASCII alphanumerics and underscores; collapses others to `_`.
 */
function slugify(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 48) : 'unspecified'
}
