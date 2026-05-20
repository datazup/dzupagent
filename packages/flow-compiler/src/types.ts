import type {
  AsyncToolResolver,
  AsyncToolsetResolver,
  FlowDiagnosticCategory,
  ToolResolver,
  ToolsetResolver,
} from '@dzupagent/flow-ast'
import type { ParseInput } from '@dzupagent/flow-ast'
import type { DzupEventBus } from '@dzupagent/core/events'

export interface CompilerOptions {
  toolResolver: ToolResolver | AsyncToolResolver
  personaResolver?: PersonaResolver | AsyncPersonaResolver
  /**
   * Resolves `toolset: <name>` references on AgentNodes into expanded
   * `tools[]` arrays. When absent, agent nodes that declare `toolset` emit
   * `UNRESOLVED_TOOLSET_REF` at Stage 3 (semantic resolution). Agent nodes
   * with only inline `tools[]` (no `toolset`) compile unaffected.
   *
   * See Stage 2 of the Flow DSL implementation plan; runtime enforcement of
   * the expanded list happens in the consuming runtime (codev-app's
   * `flow-node-executor-agent`).
   */
  toolsetResolver?: ToolsetResolver | AsyncToolsetResolver
  /**
   * When `true`, the compiler forwards inner lifecycle events
   * (`flow:compile_started`, `flow:compile_parsed`,
   * `flow:compile_shape_validated`, `flow:compile_semantic_resolved`,
   * `flow:compile_lowered`, `flow:compile_completed`,
   * `flow:compile_failed`) to `eventBus`.
   *
   * Requires `eventBus` to be set when `true`; the factory throws
   * otherwise. When omitted or `false`, the hot path is branchless —
   * events are captured into a no-op closure at factory time.
   *
   * Rationale for injection vs self-owned bus: cleaner separation of
   * concerns, less code (no re-implementation of `subscribe()` on the
   * compiler), and no fan-out coordination needed when multiple
   * subsystems want to observe compilation. See Wave 11 ADR §4.
   */
  forwardInnerEvents?: boolean
  /**
   * Shared bus for lifecycle event forwarding. Only consulted when
   * `forwardInnerEvents === true`. See Wave 11 ADR §4.
   */
  eventBus?: DzupEventBus
  /**
   * Compilation target hint. When set to `'codev-runtime'`, any tool
   * reference starting with `codev.` is treated as externally resolved
   * and will never raise an `UNRESOLVED_TOOL_REF` error. All other
   * validation rules remain in effect.
   *
   * This allows flows that reference `codev.*` namespaced tools
   * (e.g. `codev.planning.create_manifest`, `codev.intake.normalize`)
   * to compile cleanly without needing those tools registered in the
   * local resolver.
   */
  target?: 'codev-runtime'
}

export interface PersonaResolver {
  resolve(ref: string): boolean  // true if persona exists
}

/**
 * Async variant of {@link PersonaResolver}. Mirrors {@link AsyncToolResolver}
 * — stage 3 awaits the result when `resolve()` returns a Promise.
 */
export interface AsyncPersonaResolver {
  resolve(ref: string): Promise<boolean>
}

export type CompilationTarget = 'skill-chain' | 'workflow-builder' | 'pipeline'

export type CompilationStage = 1 | 2 | 3 | 4

export type FlowCompileSourceKind = 'flow-object' | 'flow-json-string' | 'flow-document' | 'dzupflow-dsl'

export interface FlowCompileCorrelation {
  runId?: string
  eventCorrelationId?: string
}

export interface CompileInvocationOptions {
  sourceKind?: FlowCompileSourceKind
  source?: unknown
  correlation?: FlowCompileCorrelation
}

export interface CompilationDiagnostic {
  stage: CompilationStage
  code: string
  message: string
  nodePath?: string
  suggestion?: string
  category?: FlowDiagnosticCategory
}

export interface CompilationWarning {
  stage: 4
  code: string
  message: string
  nodePath?: string
  category?: FlowDiagnosticCategory
}

export interface CompilationTargetReason {
  code: 'SEQUENTIAL_ONLY' | 'BRANCH_PRESENT' | 'PARALLEL_PRESENT' | 'SUSPEND_PRESENT' | 'FOR_EACH_PRESENT'
  message: string
}

export interface CompilationResult {
  target: CompilationTarget
  // The compiled artifact — typed as unknown here; each consumer casts to the right type
  artifact: unknown
  warnings: CompilationWarning[]
  reasons: CompilationTargetReason[]
}

export type CompilationError = CompilationDiagnostic

export interface CompileSuccess {
  compileId: string
  target: CompilationTarget
  artifact: unknown
  warnings: CompilationWarning[]
  reasons: CompilationTargetReason[]
  evidence: FlowCompileEvidence
  diagnosticCountsByCategory?: Record<string, number>
}

export interface CompileFailure {
  compileId: string
  errors: CompilationDiagnostic[]
  diagnosticCountsByCategory?: Record<string, number>
}

export type CompileResult = CompileSuccess | CompileFailure

export interface FlowCompiler {
  compile(input: ParseInput, options?: CompileInvocationOptions): Promise<CompileSuccess | CompileFailure>
  compileDocument(document: unknown): Promise<CompileSuccess | CompileFailure>
  compileDsl(source: unknown): Promise<CompileSuccess | CompileFailure>
}

export interface FlowCompileEvidenceNode {
  type: string
  id?: string
}

export interface FlowCompileEvidence {
  schema: 'dzupagent.flowCompileEvidence/v1'
  sourceKind: FlowCompileSourceKind
  sourceHash: string
  compileId: string
  canonicalNodeIds: string[]
  canonicalNodePaths: Record<string, FlowCompileEvidenceNode>
  loweredTarget: CompilationTarget
  correlationIds: {
    compileId: string
    eventCorrelationId: string
    runId?: string
  }
}
