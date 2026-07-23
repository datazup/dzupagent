import type {
  AsyncToolResolver,
  AsyncToolsetResolver,
  FlowNode,
  ResolvedTool,
  ToolResolver,
  ToolsetResolver,
} from '@dzupagent/flow-ast'
import { flowNodeSchema } from '@dzupagent/flow-ast'
import type {
  FlowReferenceBindings,
  FlowReferencePolicy,
} from '@dzupagent/flow-ast/expressions'

import type { ProfileRegistry, ResolvedProfile } from '../profile-registry.js'
import type {
  AsyncPersonaResolver,
  FlowReferencePortBindings,
  FlowReferenceClassificationBindings,
  FlowReferencePortClassificationBindings,
  FlowReferenceTypeBindings,
  FlowAdmissionProfile,
  PersonaResolver,
} from '../types.js'

import type { WalkContext } from './semantic-context.js'
import type { SemanticDiagnostic } from './semantic-diagnostic.js'
import { validateCheckpointRestore, visit } from './semantic-walk.js'
import { analyzeReferenceFlow } from './reference-flow-analysis.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SemanticOptions {
  toolResolver: ToolResolver | AsyncToolResolver
  personaResolver?: PersonaResolver | AsyncPersonaResolver
  /**
   * Resolves `toolset: <name>` references on AgentNodes into expanded
   * `tools[]` arrays. See {@link CompilerOptions.toolsetResolver}.
   */
  toolsetResolver?: ToolsetResolver | AsyncToolsetResolver
  /**
   * Resolves `profile: <name>` references on AgentNodes into flattened
   * model/provider/instructions/toolset/policy fields at compile time.
   * After Stage 1.5 the lowered artifact is profile-free: `node.profile`
   * is stripped from the AST after resolution. See
   * {@link CompilerOptions.profileRegistry}.
   *
   * When absent, agent nodes with `profile` set retain the ref and a
   * single MISSING_PROFILE_REGISTRY warning is recorded.
   */
  profileRegistry?: ProfileRegistry
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
  /** Compatibility-preserving default; opt into strict reference validation. */
  referencePolicy?: FlowReferencePolicy
  /** Fail-closed compile admission for unattended execution. */
  admissionProfile?: FlowAdmissionProfile
  /** Declared names by reference root for strict missing-reference checks. */
  referenceBindings?: FlowReferenceBindings
  /** Names available before the first node executes. */
  referenceAvailabilityBindings?: FlowReferenceBindings
  /** Compiler- and host-derived first-segment value types. */
  referenceTypeBindings?: FlowReferenceTypeBindings
  /** Explicit canonical output ports by stable step id. */
  referencePortBindings?: FlowReferencePortBindings
  /** Compiler- and host-derived first-segment data classifications. */
  referenceClassificationBindings?: FlowReferenceClassificationBindings
  /** Reviewed data classifications for canonical output ports. */
  referencePortClassificationBindings?: FlowReferencePortClassificationBindings
}

export interface SemanticResult {
  /** The same AST passed in (object identity preserved). */
  ast: FlowNode
  /** Aggregated unresolved-ref errors and close-miss diagnostics. */
  errors: SemanticDiagnostic[]
  /**
   * Non-fatal diagnostics. Currently used for forward-reference advisories on
   * `checkpoint.captureOutputOf` (the node id may resolve at runtime, so it is
   * not a hard error). Always present; empty array when no warnings.
   */
  warnings: SemanticDiagnostic[]
  /** Map from dot-notation node path to resolved tool metadata. */
  resolved: Map<string, ResolvedTool>
  /** Map from dot-notation node path to the persona ref that was confirmed. */
  resolvedPersonas: Map<string, string>
  /**
   * Map from AgentNode path to the post-expansion `tools[]` list (inline +
   * toolset, de-duplicated). Empty when no agent nodes declared a toolset.
   * The AST itself is also mutated so downstream lowering and runtime see
   * the expanded list; this map is exposed for observability and tests.
   */
  expandedAgentTools: Map<string, readonly string[]>
  /**
   * Map from AgentNode path → the profile ref that was flattened, along
   * with the resolved profile snapshot. Empty when no profile registry
   * was supplied or no agent nodes declared a profile. The AST itself is
   * also mutated: model/provider/instructions/toolset/policy are filled
   * in, and `node.profile` is stripped after a successful resolve.
   */
  expandedAgentProfiles: Map<string, { ref: string; resolved: ResolvedProfile }>
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
  const errors: SemanticDiagnostic[] = []
  const warnings: SemanticDiagnostic[] = []
  const resolved = new Map<string, ResolvedTool>()
  const resolvedPersonas = new Map<string, string>()
  const expandedAgentTools = new Map<string, readonly string[]>()
  const expandedAgentProfiles = new Map<string, { ref: string; resolved: ResolvedProfile }>()

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
  let availableToolsetsCache: string[] | null = null
  const getAvailableToolsets = (): string[] => {
    if (availableToolsetsCache === null) {
      availableToolsetsCache =
        opts.toolsetResolver !== undefined ? opts.toolsetResolver.listAvailable() : []
    }
    return availableToolsetsCache
  }

  const ctx: WalkContext = {
    errors,
    warnings,
    resolved,
    resolvedPersonas,
    expandedAgentTools,
    expandedAgentProfiles,
    toolResolver: opts.toolResolver,
    toolsetResolver: opts.toolsetResolver,
    personaResolver: opts.personaResolver,
    profileRegistry: opts.profileRegistry,
    suggestionDistance,
    getAvailable,
    getAvailableToolsets,
    missingPersonaResolverEmitted: false,
    missingToolsetResolverEmitted: false,
    missingProfileRegistryEmitted: false,
    target: opts.target,
    referencePolicy: opts.referencePolicy ?? 'compat-v1',
    admissionProfile: opts.admissionProfile ?? 'interactive',
    referenceBindings: opts.referenceBindings,
    referenceAvailabilityBindings:
      opts.referenceAvailabilityBindings ?? opts.referenceBindings,
    referenceTypeBindings: opts.referenceTypeBindings,
    referencePortBindings: opts.referencePortBindings,
    referenceClassificationBindings: opts.referenceClassificationBindings,
    referencePortClassificationBindings:
      opts.referencePortClassificationBindings,
  }

  validateAdmissionProfile(ast, opts, ctx.referencePolicy, errors)

  const referenceFlow = analyzeReferenceFlow(ast, {
    policy: ctx.referencePolicy,
    ...(ctx.referenceBindings !== undefined
      ? { declarationBindings: ctx.referenceBindings }
      : {}),
    ...(ctx.referenceAvailabilityBindings !== undefined
      ? { initialBindings: ctx.referenceAvailabilityBindings }
      : {}),
    ...(ctx.referenceTypeBindings !== undefined
      ? { typeBindings: ctx.referenceTypeBindings }
      : {}),
    ...(ctx.referencePortBindings !== undefined
      ? { portBindings: ctx.referencePortBindings }
      : {}),
  })
  errors.push(...referenceFlow.errors)
  warnings.push(...referenceFlow.warnings)

  await visit(ast, ROOT_PATH, ctx)

  // Cross-cutting checkpoint/restore validation:
  //   • checkpoint.captureOutputOf must reference a nodeId that appears
  //     earlier in the flow (forward refs become non-fatal warnings).
  //   • restore.checkpointLabel must match a checkpoint label somewhere in
  //     the flow (missing match is a hard error).
  validateCheckpointRestore(ast, errors, warnings)

  return { ast, errors, warnings, resolved, resolvedPersonas, expandedAgentTools, expandedAgentProfiles }
}

function validateAdmissionProfile(
  ast: FlowNode,
  opts: SemanticOptions,
  referencePolicy: FlowReferencePolicy,
  errors: SemanticDiagnostic[],
): void {
  if (opts.admissionProfile !== "unattended") return
  if (referencePolicy !== "strict") {
    errors.push({
      nodeType: ast.type,
      nodePath: "root",
      code: "UNATTENDED_STRICT_ADMISSION_REQUIRED",
      category: "policy",
      message:
        'unattended admission requires referencePolicy "strict"; compatibility warnings are not sufficient for autonomous execution',
    })
  }
  for (const input of opts.referenceBindings?.["inputs"] ?? []) {
    if (opts.referenceClassificationBindings?.["inputs"]?.[input] !== undefined) {
      continue
    }
    errors.push({
      nodeType: ast.type,
      nodePath: `root.inputs.${input}.classification`,
      code: "UNATTENDED_INPUT_CLASSIFICATION_REQUIRED",
      category: "policy",
      message: `unattended admission requires an explicit classification for input "${input}"`,
    })
  }
}
