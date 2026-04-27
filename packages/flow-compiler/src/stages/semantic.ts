import type {
  ActionNode,
  AsyncToolResolver,
  FlowNode,
  PersonaNode,
  ResolvedTool,
  ToolResolver,
  ValidationError,
} from '@dzupagent/flow-ast'
import { flowNodeSchema } from '@dzupagent/flow-ast'

import type { AsyncPersonaResolver, PersonaResolver } from '../types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SemanticOptions {
  toolResolver: ToolResolver | AsyncToolResolver
  personaResolver?: PersonaResolver | AsyncPersonaResolver
  /**
   * Maximum Levenshtein distance for "did you mean…?" suggestions.
   * Default: 3. Set to 0 to disable suggestions.
   */
  suggestionDistance?: number
  /**
   * Compilation target hint. When `'codev-runtime'`, any tool reference
   * starting with `codev.` is treated as externally resolved and will
   * never raise `UNRESOLVED_TOOL_REF`. All other validation rules apply.
   */
  target?: 'codev-runtime'
}

export interface SemanticResult {
  /** The same AST passed in (object identity preserved). */
  ast: FlowNode
  /** Aggregated unresolved-ref errors and close-miss diagnostics. */
  errors: ValidationError[]
  /**
   * Non-fatal diagnostics. Currently used for forward-reference advisories on
   * `checkpoint.captureOutputOf` (the node id may resolve at runtime, so it is
   * not a hard error). Always present; empty array when no warnings.
   */
  warnings: ValidationError[]
  /** Map from dot-notation node path to resolved tool metadata. */
  resolved: Map<string, ResolvedTool>
  /** Map from dot-notation node path to the persona ref that was confirmed. */
  resolvedPersonas: Map<string, string>
}

const DEFAULT_SUGGESTION_DISTANCE = 3
const ROOT_PATH = 'root'

/**
 * Stage 3 — Semantic resolution.
 *
 * Walks the AST, calls `toolResolver.resolve(node.toolRef)` for every ActionNode
 * and `personaResolver.resolve(ref)` for every persona reference. Aggregates
 * UNRESOLVED_TOOL_REF / UNRESOLVED_PERSONA_REF errors with "did you mean…?"
 * suggestions sourced from `toolResolver.listAvailable()`.
 *
 * Accepts synchronous or asynchronous resolvers (duck-typed on the return type
 * of `resolve()` per Wave 11 ADR §3.3). When `resolve()` returns a Promise the
 * compiler awaits it; synchronous resolvers never hit the microtask queue.
 * Rejections from async resolvers surface as `RESOLVER_INFRA_ERROR` Stage 3
 * errors carrying the original message + node path — no throw escapes this
 * stage boundary.
 *
 * Does NOT mutate the AST. Returned `resolved` / `resolvedPersonas` side-tables
 * are keyed by the same dot-notation node paths used by STAGE 2.
 */
export async function semanticResolve(
  ast: FlowNode,
  opts: SemanticOptions,
): Promise<SemanticResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []
  const resolved = new Map<string, ResolvedTool>()
  const resolvedPersonas = new Map<string, string>()

  // SC-12: Zod-compatible runtime schema pre-pass.
  //
  // Stage 2 shape-validate already catches structural defects in the common
  // path, but semanticResolve is also used directly (without stage 2) by
  // callers that receive an AST from a trusted source. The schema pre-pass
  // keeps state-transition guarantees honest even when stage 2 is skipped:
  // any mismatch surfaces as a typed ValidationError rather than propagating
  // as a raw throw from a downstream lowerer.
  //
  // Emits zero issues on ASTs that passed stage 2, so this is a no-op in the
  // normal compile() path.
  const schemaResult = flowNodeSchema.safeParse(ast)
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      errors.push({
        nodeType: ast.type,
        nodePath: issue.path,
        code: issue.code,
        message: `Schema validation failed: ${issue.message}`,
      })
    }
  }

  const suggestionDistance = opts.suggestionDistance ?? DEFAULT_SUGGESTION_DISTANCE

  // Cache `listAvailable()` for the duration of this call only — the resolver
  // may build the list lazily and we want the suggestion lookup to remain O(1)
  // on the registry side per unresolved ref. Do NOT cache across calls.
  let availableCache: string[] | null = null
  const getAvailable = (): string[] => {
    if (availableCache === null) {
      availableCache = opts.toolResolver.listAvailable()
    }
    return availableCache
  }

  const ctx: WalkContext = {
    errors,
    warnings,
    resolved,
    resolvedPersonas,
    toolResolver: opts.toolResolver,
    personaResolver: opts.personaResolver,
    suggestionDistance,
    getAvailable,
    missingPersonaResolverEmitted: false,
    target: opts.target,
  }

  await visit(ast, ROOT_PATH, ctx)

  // Cross-cutting checkpoint/restore validation:
  //   • checkpoint.captureOutputOf must reference a nodeId that appears
  //     earlier in the flow (forward refs become non-fatal warnings).
  //   • restore.checkpointLabel must match a checkpoint label somewhere in
  //     the flow (missing match is a hard error).
  validateCheckpointRestore(ast, errors, warnings)

  return { ast, errors, warnings, resolved, resolvedPersonas }
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

interface WalkContext {
  errors: ValidationError[]
  warnings: ValidationError[]
  resolved: Map<string, ResolvedTool>
  resolvedPersonas: Map<string, string>
  toolResolver: ToolResolver | AsyncToolResolver
  personaResolver: PersonaResolver | AsyncPersonaResolver | undefined
  suggestionDistance: number
  getAvailable: () => string[]
  missingPersonaResolverEmitted: boolean
  target: 'codev-runtime' | undefined
}

async function visit(node: FlowNode, path: string, ctx: WalkContext): Promise<void> {
  switch (node.type) {
    case 'sequence': {
      for (let idx = 0; idx < node.nodes.length; idx++) {
        const child = node.nodes[idx]
        if (child !== undefined) {
          await visit(child, `${path}.nodes[${idx}]`, ctx)
        }
      }
      return
    }
    case 'action': {
      await resolveAction(node, path, ctx)
      return
    }
    case 'for_each': {
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx]
        if (child !== undefined) {
          await visit(child, `${path}.body[${idx}]`, ctx)
        }
      }
      return
    }
    case 'branch': {
      for (let idx = 0; idx < node.then.length; idx++) {
        const child = node.then[idx]
        if (child !== undefined) {
          await visit(child, `${path}.then[${idx}]`, ctx)
        }
      }
      if (node.else !== undefined) {
        for (let idx = 0; idx < node.else.length; idx++) {
          const child = node.else[idx]
          if (child !== undefined) {
            await visit(child, `${path}.else[${idx}]`, ctx)
          }
        }
      }
      return
    }
    case 'parallel': {
      for (let bIdx = 0; bIdx < node.branches.length; bIdx++) {
        const branch = node.branches[bIdx]
        if (branch === undefined) continue
        for (let idx = 0; idx < branch.length; idx++) {
          const child = branch[idx]
          if (child !== undefined) {
            await visit(child, `${path}.branches[${bIdx}][${idx}]`, ctx)
          }
        }
      }
      return
    }
    case 'approval': {
      for (let idx = 0; idx < node.onApprove.length; idx++) {
        const child = node.onApprove[idx]
        if (child !== undefined) {
          await visit(child, `${path}.onApprove[${idx}]`, ctx)
        }
      }
      if (node.onReject !== undefined) {
        for (let idx = 0; idx < node.onReject.length; idx++) {
          const child = node.onReject[idx]
          if (child !== undefined) {
            await visit(child, `${path}.onReject[${idx}]`, ctx)
          }
        }
      }
      return
    }
    case 'clarification': {
      // Leaf — no refs to resolve.
      return
    }
    case 'persona': {
      await resolvePersonaNode(node, path, ctx)
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx]
        if (child !== undefined) {
          await visit(child, `${path}.body[${idx}]`, ctx)
        }
      }
      return
    }
    case 'route': {
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx]
        if (child !== undefined) {
          await visit(child, `${path}.body[${idx}]`, ctx)
        }
      }
      return
    }
    case 'complete': {
      return
    }
    case 'spawn':
    case 'classify':
    case 'emit':
    case 'memory':
    case 'checkpoint':
    case 'restore': {
      // Leaf nodes — no refs to resolve in semantic stage.
      return
    }
    default: {
      // Exhaustiveness guard — adding a FlowNode variant without a case fails
      // compilation here.
      const _exhaustive: never = node
      void _exhaustive
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/** Sentinel returned by {@link resolveToolRef} when the resolver threw. */
const INFRA_FAILURE = Symbol('infra-failure')

async function resolveAction(node: ActionNode, path: string, ctx: WalkContext): Promise<void> {
  // STAGE 2 already complains about missing/empty toolRef. We still try to
  // resolve when present so STAGE 3 stays focused on resolution outcomes.
  if (typeof node.toolRef === 'string' && node.toolRef.length > 0) {
    // codev-runtime target: treat any `codev.*` ref as externally resolved.
    // The runtime will wire these at execution time, so we never emit
    // UNRESOLVED_TOOL_REF for them when compiling for this target.
    if (ctx.target === 'codev-runtime' && node.toolRef.startsWith('codev.')) {
      // Mark as externally resolved — no error, no local registry lookup.
    } else {
      const hit = await resolveToolRef(ctx.toolResolver, node.toolRef, node.type, path, ctx.errors)
      if (hit === INFRA_FAILURE) {
        // Infra error already pushed by resolveToolRef; do NOT also emit
        // UNRESOLVED_TOOL_REF — infra failure supersedes unresolved-ref
        // messaging on the same node.
      } else if (hit !== null) {
        ctx.resolved.set(path, hit)
      } else {
        ctx.errors.push(unresolvedToolError(node.type, path, node.toolRef, ctx))
      }
    }
  }

  if (node.personaRef !== undefined) {
    await resolvePersonaRef(node.type, path, node.personaRef, ctx)
  }
}

/**
 * Duck-typed dispatch: sync resolvers return `ResolvedTool | null`; async
 * resolvers return `Promise<ResolvedTool | null>`. Rejection surfaces as a
 * `RESOLVER_INFRA_ERROR` so the stage boundary never throws, and this
 * function returns the {@link INFRA_FAILURE} sentinel so the caller knows
 * not to layer an UNRESOLVED_TOOL_REF on top.
 */
async function resolveToolRef(
  resolver: ToolResolver | AsyncToolResolver,
  ref: string,
  nodeType: FlowNode['type'],
  nodePath: string,
  errors: ValidationError[],
): Promise<ResolvedTool | null | typeof INFRA_FAILURE> {
  try {
    const maybe = resolver.resolve(ref)
    return maybe instanceof Promise ? await maybe : maybe
  } catch (err) {
    errors.push({
      nodeType,
      nodePath,
      code: 'RESOLVER_INFRA_ERROR',
      message: err instanceof Error ? err.message : String(err),
    })
    return INFRA_FAILURE
  }
}

async function resolvePersonaNode(
  node: PersonaNode,
  path: string,
  ctx: WalkContext,
): Promise<void> {
  if (typeof node.personaId === 'string' && node.personaId.length > 0) {
    await resolvePersonaRef(node.type, path, node.personaId, ctx)
  }
}

async function resolvePersonaRef(
  nodeType: FlowNode['type'],
  path: string,
  ref: string,
  ctx: WalkContext,
): Promise<void> {
  if (ctx.personaResolver === undefined) {
    if (!ctx.missingPersonaResolverEmitted) {
      ctx.missingPersonaResolverEmitted = true
      ctx.errors.push({
        nodeType,
        nodePath: ROOT_PATH,
        code: 'UNRESOLVED_PERSONA_REF',
        message: 'personaResolver not provided',
      })
    }
    return
  }

  let ok: boolean
  try {
    const maybe = ctx.personaResolver.resolve(ref)
    ok = maybe instanceof Promise ? await maybe : maybe
  } catch (err) {
    ctx.errors.push({
      nodeType,
      nodePath: path,
      code: 'RESOLVER_INFRA_ERROR',
      message: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (ok) {
    ctx.resolvedPersonas.set(path, ref)
    return
  }

  ctx.errors.push({
    nodeType,
    nodePath: path,
    code: 'UNRESOLVED_PERSONA_REF',
    message: buildPersonaErrorMessage(ref, ctx.personaResolver),
  })
}

function unresolvedToolError(
  nodeType: FlowNode['type'],
  path: string,
  ref: string,
  ctx: WalkContext,
): ValidationError {
  return {
    nodeType,
    nodePath: path,
    code: 'UNRESOLVED_TOOL_REF',
    message: buildToolErrorMessage(ref, ctx),
  }
}

function buildToolErrorMessage(ref: string, ctx: WalkContext): string {
  const base = `Unresolved tool reference: "${ref}".`
  if (ctx.suggestionDistance <= 0) return base
  const suggestions = topSuggestions(ref, ctx.getAvailable(), ctx.suggestionDistance)
  if (suggestions.length === 0) return base
  return `${base} Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?`
}

function buildPersonaErrorMessage(
  ref: string,
  resolver: PersonaResolver | AsyncPersonaResolver,
): string {
  const base = `Unresolved persona reference: "${ref}".`
  // PersonaResolver.list() is optional and not declared on the interface. If
  // an implementation exposes it, surface "did you mean" candidates as a
  // courtesy. Treat any non-function value as absent.
  const maybeList = (resolver as unknown as { list?: () => string[] }).list
  if (typeof maybeList !== 'function') return base
  const candidates = maybeList.call(resolver)
  if (!Array.isArray(candidates) || candidates.length === 0) return base
  const suggestions = topSuggestions(ref, candidates, DEFAULT_SUGGESTION_DISTANCE)
  if (suggestions.length === 0) return base
  return `${base} Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?`
}

// ---------------------------------------------------------------------------
// Checkpoint / Restore cross-node validation
// ---------------------------------------------------------------------------

/**
 * Walk the AST in flow order, collecting:
 *   • the set of node ids that appear before each `checkpoint` node, and
 *   • the labels declared by every `checkpoint` node anywhere in the flow.
 *
 * Then emit:
 *   • a non-fatal warning when `checkpoint.captureOutputOf` does not match
 *     any preceding node id (forward references are allowed at runtime but
 *     suspicious enough to surface), and
 *   • a hard error when `restore.checkpointLabel` does not match any
 *     declared checkpoint label in the same flow.
 */
function validateCheckpointRestore(
  ast: FlowNode,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  // Pass 1 — collect all checkpoint labels declared anywhere in the flow.
  const declaredLabels = new Set<string>()
  collectCheckpointLabels(ast, declaredLabels)

  // Pass 2 — flow-order walk that maintains the rolling set of "earlier"
  // node ids. Each checkpoint validates against this rolling set; restores
  // validate against the labels collected in pass 1.
  const seenIds = new Set<string>()
  walkCheckpointRestore(ast, ROOT_PATH, seenIds, declaredLabels, errors, warnings)
}

function collectCheckpointLabels(node: FlowNode, out: Set<string>): void {
  switch (node.type) {
    case 'checkpoint': {
      const label = node.label ?? node.id
      if (typeof label === 'string' && label.length > 0) {
        out.add(label)
      }
      return
    }
    case 'sequence': {
      for (const child of node.nodes) collectCheckpointLabels(child, out)
      return
    }
    case 'for_each': {
      for (const child of node.body) collectCheckpointLabels(child, out)
      return
    }
    case 'branch': {
      for (const child of node.then) collectCheckpointLabels(child, out)
      if (node.else !== undefined) {
        for (const child of node.else) collectCheckpointLabels(child, out)
      }
      return
    }
    case 'parallel': {
      for (const branch of node.branches) {
        for (const child of branch) collectCheckpointLabels(child, out)
      }
      return
    }
    case 'approval': {
      for (const child of node.onApprove) collectCheckpointLabels(child, out)
      if (node.onReject !== undefined) {
        for (const child of node.onReject) collectCheckpointLabels(child, out)
      }
      return
    }
    case 'persona':
    case 'route': {
      for (const child of node.body) collectCheckpointLabels(child, out)
      return
    }
    default:
      return
  }
}

function walkCheckpointRestore(
  node: FlowNode,
  path: string,
  seenIds: Set<string>,
  declaredLabels: Set<string>,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  // Validate this node first (so its own id is not yet in `seenIds` — a
  // checkpoint cannot capture itself).
  if (node.type === 'checkpoint') {
    if (!seenIds.has(node.captureOutputOf)) {
      warnings.push({
        nodeType: node.type,
        nodePath: path,
        code: 'MISSING_REQUIRED_FIELD',
        message:
          `checkpoint.captureOutputOf="${node.captureOutputOf}" does not reference any node ` +
          `appearing earlier in the flow (forward reference).`,
      })
    }
  } else if (node.type === 'restore') {
    if (!declaredLabels.has(node.checkpointLabel)) {
      errors.push({
        nodeType: node.type,
        nodePath: path,
        code: 'MISSING_REQUIRED_FIELD',
        message:
          `restore.checkpointLabel="${node.checkpointLabel}" does not match any ` +
          `checkpoint declared in the same flow.`,
      })
    }
  }

  // Then mark this node's id as "seen" before recursing into children — a
  // checkpoint or restore further down may legitimately refer back to the
  // current node.
  if (typeof node.id === 'string' && node.id.length > 0) {
    seenIds.add(node.id)
  }

  switch (node.type) {
    case 'sequence': {
      for (let idx = 0; idx < node.nodes.length; idx++) {
        const child = node.nodes[idx]
        if (child !== undefined) {
          walkCheckpointRestore(
            child,
            `${path}.nodes[${idx}]`,
            seenIds,
            declaredLabels,
            errors,
            warnings,
          )
        }
      }
      return
    }
    case 'for_each': {
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx]
        if (child !== undefined) {
          walkCheckpointRestore(
            child,
            `${path}.body[${idx}]`,
            seenIds,
            declaredLabels,
            errors,
            warnings,
          )
        }
      }
      return
    }
    case 'branch': {
      for (let idx = 0; idx < node.then.length; idx++) {
        const child = node.then[idx]
        if (child !== undefined) {
          walkCheckpointRestore(
            child,
            `${path}.then[${idx}]`,
            seenIds,
            declaredLabels,
            errors,
            warnings,
          )
        }
      }
      if (node.else !== undefined) {
        for (let idx = 0; idx < node.else.length; idx++) {
          const child = node.else[idx]
          if (child !== undefined) {
            walkCheckpointRestore(
              child,
              `${path}.else[${idx}]`,
              seenIds,
              declaredLabels,
              errors,
              warnings,
            )
          }
        }
      }
      return
    }
    case 'parallel': {
      for (let bIdx = 0; bIdx < node.branches.length; bIdx++) {
        const branch = node.branches[bIdx]
        if (branch === undefined) continue
        for (let idx = 0; idx < branch.length; idx++) {
          const child = branch[idx]
          if (child !== undefined) {
            walkCheckpointRestore(
              child,
              `${path}.branches[${bIdx}][${idx}]`,
              seenIds,
              declaredLabels,
              errors,
              warnings,
            )
          }
        }
      }
      return
    }
    case 'approval': {
      for (let idx = 0; idx < node.onApprove.length; idx++) {
        const child = node.onApprove[idx]
        if (child !== undefined) {
          walkCheckpointRestore(
            child,
            `${path}.onApprove[${idx}]`,
            seenIds,
            declaredLabels,
            errors,
            warnings,
          )
        }
      }
      if (node.onReject !== undefined) {
        for (let idx = 0; idx < node.onReject.length; idx++) {
          const child = node.onReject[idx]
          if (child !== undefined) {
            walkCheckpointRestore(
              child,
              `${path}.onReject[${idx}]`,
              seenIds,
              declaredLabels,
              errors,
              warnings,
            )
          }
        }
      }
      return
    }
    case 'persona':
    case 'route': {
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx]
        if (child !== undefined) {
          walkCheckpointRestore(
            child,
            `${path}.body[${idx}]`,
            seenIds,
            declaredLabels,
            errors,
            warnings,
          )
        }
      }
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------------------
// Suggestion ranking
// ---------------------------------------------------------------------------

const MAX_SUGGESTIONS = 3

function topSuggestions(needle: string, haystack: readonly string[], maxDistance: number): string[] {
  const scored: Array<{ name: string; distance: number }> = []
  for (const candidate of haystack) {
    if (candidate === needle) continue
    const distance = levenshtein(needle, candidate)
    if (distance <= maxDistance) {
      scored.push({ name: candidate, distance })
    }
  }
  scored.sort((a, b) => (a.distance - b.distance) || a.name.localeCompare(b.name))
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.name)
}

/**
 * Iterative two-row Levenshtein. Small, dependency-free, O(m*n) time / O(n)
 * space. Adequate for ref strings of typical length (≤64 chars) and registry
 * sizes encountered by the compiler.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  const dp: number[] = new Array(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j

  for (let i = 1; i <= m; i++) {
    let prev = dp[0] ?? 0
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j] ?? 0
      const left = dp[j - 1] ?? 0
      const up = dp[j] ?? 0
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, up, left)
      prev = tmp
    }
  }
  return dp[n] ?? 0
}
