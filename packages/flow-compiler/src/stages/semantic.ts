import type {
  AsyncToolResolver,
  FlowNode,
  ResolvedTool,
  ToolResolver,
  ValidationError,
} from '@dzupagent/flow-ast'
import { flowNodeSchema } from '@dzupagent/flow-ast'

import type { AsyncPersonaResolver, PersonaResolver } from '../types.js'

import type { WalkContext } from './semantic-context.js'
import { validateCheckpointRestore, visit } from './semantic-walk.js'

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
 *
 * Implementation is split across focused sub-passes — see `semantic-walk.ts`
 * (AST traversal + checkpoint/restore validation), `semantic-tool-resolver.ts`
 * (tool refs), `semantic-persona-resolver.ts` (persona refs), and
 * `semantic-condition.ts` (condition expressions + suggestion ranking).
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
        category: 'shape',
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
