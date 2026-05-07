/**
 * Internal shared types for the workflow compiler split modules.
 *
 * These types are exported across the compiler coordinator, error handlers,
 * node-builders, and executor factory modules, but are not part of the
 * public package surface (they are not re-exported from `index.ts`).
 *
 * @module workflow/workflow-compiler-types
 */
import type { PipelineDefinition } from '@dzupagent/core/pipeline'
import type { WorkflowContext, WorkflowEvent } from './workflow-types.js'
import type { NodeExecutor } from '../pipeline/pipeline-runtime-types.js'

/**
 * Handler signature stored in the per-compilation transform handler map.
 * Returns `undefined` when the step had no observable output (e.g. a
 * recovery branch); `Record<string, unknown>` otherwise.
 */
export type WorkflowTransformHandler = (
  state: Record<string, unknown>,
  ctx: WorkflowContext,
  emit: (event: WorkflowEvent) => void,
) => Promise<Record<string, unknown> | undefined>

/**
 * Result of `compileWorkflow`. Consumed by `CompiledWorkflow` to bind the
 * generated pipeline to a `PipelineRuntime` instance.
 */
export interface WorkflowCompilation {
  definition: PipelineDefinition
  predicates: Record<string, (state: Record<string, unknown>) => boolean | string>
  suspendReasons: Map<string, string>
  createNodeExecutor: (
    emit: (event: WorkflowEvent) => void,
    onStateObserved: (state: Record<string, unknown>) => void,
  ) => NodeExecutor
}
