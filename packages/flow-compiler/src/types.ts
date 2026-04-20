import type { AsyncToolResolver, ToolResolver } from '@dzupagent/flow-ast'
import type { DzupEventBus } from '@dzupagent/core'

export interface CompilerOptions {
  toolResolver: ToolResolver | AsyncToolResolver
  personaResolver?: PersonaResolver | AsyncPersonaResolver
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

export interface CompilationResult {
  target: CompilationTarget
  // The compiled artifact — typed as unknown here; each consumer casts to the right type
  artifact: unknown
  warnings: string[]
}

export interface CompilationError {
  stage: 1 | 2 | 3 | 4
  message: string
  nodePath?: string
}
