/**
 * @dzupagent/flow-compiler — public entry point.
 *
 * Exports the `createFlowCompiler` factory, convenience re-exports of each
 * pipeline stage, and all public types.
 *
 * Stage pipeline:
 *   1. parseFlow       — JSON/object → FlowNode AST  (errors: stage 1)
 *   2. validateShape   — structural validation         (errors: stage 2)
 *   3. semanticResolve — tool/persona ref resolution  (errors: stage 3, halts)
 *   4. routeTarget + lower — emit artifact            (errors: stage 4)
 *
 * Since Wave 11 `compile()` is always asynchronous. Sync resolvers pay a
 * single unconditional microtask per compile — a negligible cost relative to
 * parse + shape-validate + lower. See ADR `DECISIONS_WAVE_11.md`.
 */

import { parseFlow } from '@dzupagent/flow-ast'
import type { ParseInput } from '@dzupagent/flow-ast'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { validateShape } from './stages/shape-validate.js'
import { semanticResolve } from './stages/semantic.js'
import { routeTarget } from './route-target.js'
import { lowerSkillChain } from './lower/lower-skill-chain.js'
import { lowerPipelineFlat } from './lower/lower-pipeline-flat.js'
import { lowerPipelineLoop } from './lower/lower-pipeline-loop.js'
import { hasOnError } from './route-target.js'
import { prepareFlowInputFromDocument, prepareFlowInputFromDsl } from './authoring-input.js'
import { compileTextInput, isFlowDocumentJson } from './cli-input.js'

import type {
  CompilerOptions,
  CompilationError,
  CompilationTarget,
  CompilationTargetReason,
  CompilationWarning,
  CompileFailure,
  FlowCompiler,
  CompileSuccess,
} from './types.js'

export * from './types.js'
export { prepareFlowInputFromDocument, prepareFlowInputFromDsl } from './authoring-input.js'
export { compileTextInput, isFlowDocumentJson } from './cli-input.js'
export { validateShape } from './stages/shape-validate.js'
export { semanticResolve } from './stages/semantic.js'
export type { SemanticOptions, SemanticResult } from './stages/semantic.js'
export { routeTarget, computeFeatureBitmask, hasOnError, FEATURE_BITS } from './route-target.js'
export { lowerCheckpointNode, lowerRestoreNode } from './lower/lower-checkpoint.js'
export type {
  LoweredNode,
  LoweredCheckpointNode,
  LoweredRestoreNode,
} from './lower/lower-checkpoint.js'
export { parseFlow } from '@dzupagent/flow-ast'
export type { ParseInput } from '@dzupagent/flow-ast'

// ---------------------------------------------------------------------------
// Compiler factory
// ---------------------------------------------------------------------------

// Flow compiler event shapes are part of the canonical `DzupEvent` union in
// `@dzupagent/core` (Wave 11 ADR §4). We narrow to the relevant subset here
// so `emit` site types remain tight without reintroducing the legacy cast.
type FlowCompileEvent = Extract<
  DzupEvent,
  {
    type:
      | 'flow:compile_started'
      | 'flow:compile_parsed'
      | 'flow:compile_shape_validated'
      | 'flow:compile_semantic_resolved'
      | 'flow:compile_lowered'
      | 'flow:compile_completed'
      | 'flow:compile_failed'
  }
>

const NOOP_EMIT: (_e: FlowCompileEvent) => void = () => {
  /* no-op; forwardInnerEvents is off or no bus provided */
}

/**
 * Create a reusable flow compiler bound to the supplied resolver options.
 *
 * The returned `compile(input)` function runs the four-stage pipeline:
 *   1. Parse (stage 1)
 *   2. Shape validation (stage 2)
 *   3. Semantic resolution (stage 3) — halts on any error
 *   4. Lowering to compilation target (stage 4)
 *
 * Stages 1 and 2 errors are combined into a single returned `errors` array.
 * Stage 3 errors halt the pipeline (lowering cannot proceed without resolved
 * refs). Stage 4 errors are structural invariant violations (e.g. `on_error`
 * in a skill-chain-routed flow) that survive all earlier gates.
 *
 * Returns `Promise<CompileSuccess | CompileFailure>`. Both result shapes
 * carry a `compileId: string` (UUIDv4) so external correlation with emitted
 * lifecycle events on the shared `DzupEventBus` is trivial.
 *
 * @throws {Error} if `opts.forwardInnerEvents === true` and `opts.eventBus`
 *   is not supplied. Construct-time throw, never at compile time.
 */
export function createFlowCompiler(opts: CompilerOptions): FlowCompiler {
  if (opts.forwardInnerEvents === true && opts.eventBus === undefined) {
    throw new Error(
      'flow-compiler: forwardInnerEvents=true requires an eventBus — ' +
        'pass `eventBus` in CompilerOptions or leave forwardInnerEvents unset.',
    )
  }

  // Capture `emit` once at factory time. When forwarding is off the callable
  // is a no-op; emission sites pay a single indirect call and no branch.
  // See ADR §4.5 for the branchless-hot-path rationale.
  const emit: (e: FlowCompileEvent) => void =
    opts.forwardInnerEvents === true && opts.eventBus !== undefined
      ? ((bus: DzupEventBus) => (e: FlowCompileEvent) => bus.emit(e))(opts.eventBus)
      : NOOP_EMIT

  async function compile(input: ParseInput): Promise<CompileSuccess | CompileFailure> {
      const compileId = crypto.randomUUID()
      const startedAt = Date.now()

      emit({
        type: 'flow:compile_started',
        compileId,
        inputKind: typeof input === 'string' ? 'json-string' : 'object',
      })

      // -----------------------------------------------------------------------
      // Stage 1: Parse
      // -----------------------------------------------------------------------
      const parseResult = parseFlow(input)

      const stage1Errors: CompilationError[] = parseResult.errors.map((e) => ({
        stage: 1 as const,
        code: e.code,
        message: e.message,
        nodePath: jsonPointerToNodePath(e.pointer),
      }))

      emit({
        type: 'flow:compile_parsed',
        compileId,
        astNodeType: parseResult.ast === null ? null : parseResult.ast.type,
        errorCount: stage1Errors.length,
      })

      if (parseResult.ast === null) {
        emit({
          type: 'flow:compile_failed',
          compileId,
          stage: 1,
          errorCount: stage1Errors.length,
          durationMs: Date.now() - startedAt,
        })
        return { errors: stage1Errors, compileId }
      }

      const ast = parseResult.ast

      // -----------------------------------------------------------------------
      // Stage 2: Shape validation
      // -----------------------------------------------------------------------
      const shapeErrors = validateShape(ast)

      const stage2Errors: CompilationError[] = shapeErrors.map((e) => ({
        stage: 2 as const,
        code: e.code,
        message: e.message,
        nodePath: e.nodePath,
      }))

      emit({
        type: 'flow:compile_shape_validated',
        compileId,
        errorCount: stage2Errors.length,
      })

      // Stages 1 + 2 combine. If either set is non-empty, return early.
      const combinedEarly = [...stage1Errors, ...stage2Errors]
      if (combinedEarly.length > 0) {
        // Failing stage is whichever produced errors; stage 2 supersedes
        // stage 1 here only if stage 1 was clean (ast !== null implies
        // stage 1 at least yielded an AST, possibly with recoverable
        // warnings; the failing stage from the caller's perspective is 2
        // when stage 1 reported zero errors).
        const failingStage: 1 | 2 = stage1Errors.length > 0 ? 1 : 2
        emit({
          type: 'flow:compile_failed',
          compileId,
          stage: failingStage,
          errorCount: combinedEarly.length,
          durationMs: Date.now() - startedAt,
        })
        return { errors: combinedEarly, compileId }
      }

      // -----------------------------------------------------------------------
      // Stage 3: Semantic resolution — halts on any error
      // -----------------------------------------------------------------------
      const semanticResult = await semanticResolve(ast, {
        toolResolver: opts.toolResolver,
        personaResolver: opts.personaResolver,
        ...(opts.target !== undefined ? { target: opts.target } : {}),
      })

      emit({
        type: 'flow:compile_semantic_resolved',
        compileId,
        resolvedCount: semanticResult.resolved.size,
        personaCount: semanticResult.resolvedPersonas.size,
        errorCount: semanticResult.errors.length,
      })

      if (semanticResult.errors.length > 0) {
        const stage3Errors: CompilationError[] = semanticResult.errors.map((e) => ({
          stage: 3 as const,
          code: e.code,
          message: e.message,
          nodePath: e.nodePath,
          ...extractSuggestionFromMessage(e.message),
        }))
        emit({
          type: 'flow:compile_failed',
          compileId,
          stage: 3,
          errorCount: stage3Errors.length,
          durationMs: Date.now() - startedAt,
        })
        return { errors: stage3Errors, compileId }
      }

      const { resolved, resolvedPersonas } = semanticResult

      // -----------------------------------------------------------------------
      // Stage 4: Route + lower
      // -----------------------------------------------------------------------
      const { target, bitmask } = routeTarget(ast)

      // Stage 4 defense-in-depth: skill-chain target must not carry on_error.
      // validateShape (stage 2) already catches this via OI-4, but if a caller
      // constructs an AST directly and bypasses stage 2, this backstop fires.
      if (target === 'skill-chain' && hasOnError(ast)) {
        const stage4Error: CompilationError = {
          stage: 4,
          code: 'UNSUPPORTED_FIELD',
          message: 'on_error is only legal in pipeline-targeted flows',
          nodePath: 'root',
        }
        emit({
          type: 'flow:compile_failed',
          compileId,
          stage: 4,
          errorCount: 1,
          durationMs: Date.now() - startedAt,
        })
        return { errors: [stage4Error], compileId }
      }

      let artifact: unknown
      let warnings: string[]
      if (target === 'skill-chain') {
        const out = lowerSkillChain({ ast, resolved, mode: 'executable' })
        artifact = out.artifact
        warnings = out.warnings
      } else if (target === 'workflow-builder') {
        const out = lowerPipelineFlat({
          ast,
          resolved,
          resolvedPersonas,
          mode: 'executable',
        })
        artifact = out.artifact
        warnings = out.warnings
      } else {
        // target === 'pipeline'
        const out = lowerPipelineLoop({
          ast,
          resolved,
          resolvedPersonas,
          mode: 'executable',
        })
        artifact = out.artifact
        warnings = out.warnings
      }

      // Best-effort node/edge counts. The `artifact` shapes differ by target;
      // we read common fields defensively to keep the emit site target-agnostic.
      const { nodeCount, edgeCount } = countArtifact(target, artifact)

      emit({
        type: 'flow:compile_lowered',
        compileId,
        target,
        nodeCount,
        edgeCount,
        warningCount: warnings.length,
      })

      emit({
        type: 'flow:compile_completed',
        compileId,
        target,
        durationMs: Date.now() - startedAt,
      })

      return {
        target,
        artifact,
        warnings: toCompilationWarnings(warnings),
        reasons: targetReasons(target, bitmask),
        compileId,
      }
  }

  async function compileDocument(document: unknown): Promise<CompileSuccess | CompileFailure> {
    const prepared = prepareFlowInputFromDocument(document)
    if (!prepared.ok) {
      return {
        compileId: crypto.randomUUID(),
        errors: prepared.errors,
      }
    }
    return compile(prepared.flowInput)
  }

  async function compileDsl(source: unknown): Promise<CompileSuccess | CompileFailure> {
    const prepared = prepareFlowInputFromDsl(source)
    if (!prepared.ok) {
      return {
        compileId: crypto.randomUUID(),
        errors: prepared.errors,
      }
    }
    return compile(prepared.flowInput)
  }

  return {
    compile,
    compileDocument,
    compileDsl,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count nodes/edges on a lowered artifact for telemetry. Returns zeroes
 * defensively on unexpected shapes — telemetry must never crash a compile.
 */
function countArtifact(
  target: 'skill-chain' | 'workflow-builder' | 'pipeline',
  artifact: unknown,
): { nodeCount: number; edgeCount: number } {
  if (artifact === null || typeof artifact !== 'object') {
    return { nodeCount: 0, edgeCount: 0 }
  }
  const obj = artifact as { nodes?: unknown; edges?: unknown; steps?: unknown }
  if (target === 'skill-chain') {
    return {
      nodeCount: Array.isArray(obj.steps) ? obj.steps.length : 0,
      edgeCount: 0,
    }
  }
  return {
    nodeCount: Array.isArray(obj.nodes) ? obj.nodes.length : 0,
    edgeCount: Array.isArray(obj.edges) ? obj.edges.length : 0,
  }
}

function jsonPointerToNodePath(pointer: string): string | undefined {
  if (pointer.length === 0) return 'root'

  const parts = pointer
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))

  let path = 'root'
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      path += `[${part}]`
    } else {
      path += `.${part}`
    }
  }
  return path
}

function extractSuggestionFromMessage(message: string): { suggestion?: string } {
  const match = /Did you mean:\s*"([^"]+)"/.exec(message)
  return match ? { suggestion: match[1] } : {}
}

function toCompilationWarnings(warnings: string[]): CompilationWarning[] {
  return warnings.map((message) => ({
    stage: 4 as const,
    code: 'LOWERING_WARNING',
    message,
  }))
}

function targetReasons(
  target: CompilationTarget,
  bitmask: number,
): CompilationTargetReason[] {
  const reasons: CompilationTargetReason[] = []

  if (bitmask === 0 && target === 'skill-chain') {
    reasons.push({
      code: 'SEQUENTIAL_ONLY',
      message: 'No branching, suspend, or loop features were detected; routed to skill-chain.',
    })
    return reasons
  }

  if ((bitmask & (1 << 0)) !== 0) {
    reasons.push({
      code: 'BRANCH_PRESENT',
      message: 'Branch control flow is present; skill-chain is not sufficient.',
    })
  }
  if ((bitmask & (1 << 1)) !== 0) {
    reasons.push({
      code: 'PARALLEL_PRESENT',
      message: 'Parallel control flow is present; graph-style lowering is required.',
    })
  }
  if ((bitmask & (1 << 2)) !== 0) {
    reasons.push({
      code: 'SUSPEND_PRESENT',
      message: 'Suspend-capable nodes are present; routed beyond skill-chain.',
    })
  }
  if ((bitmask & (1 << 3)) !== 0) {
    reasons.push({
      code: 'FOR_EACH_PRESENT',
      message: 'Loop semantics are present; routed to pipeline.',
    })
  }

  return reasons
}
