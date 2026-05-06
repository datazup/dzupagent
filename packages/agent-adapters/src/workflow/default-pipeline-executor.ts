/**
 * Default `PipelineExecutorFactory` implementation that wires the
 * canonical `PipelineRuntime` from `@dzupagent/agent` behind the
 * dependency-inverted `PipelineExecutorPort` contract published by
 * `@dzupagent/adapter-types`.
 *
 * Keeping this adapter in its own module is what allows
 * `adapter-workflow.ts` (the home of `AdapterWorkflowBuilder`) to drop
 * its static import of the concrete runtime class. The builder code
 * only knows about the port; this file is the single seam where the
 * runtime is bound, and it can be swapped out by callers via DI.
 */
import { PipelineRuntime } from '@dzupagent/agent/pipeline'
import type { PipelineDefinition, PipelineNode } from '@dzupagent/core'
import type {
  PipelineExecutorConfig,
  PipelineExecutorFactory,
  PipelineExecutorPort,
} from '@dzupagent/adapter-types'

/**
 * Factory that constructs a `PipelineRuntime` and surfaces it via the
 * `PipelineExecutorPort` contract. This is the default factory used by
 * `defineWorkflow` when callers do not supply their own.
 */
export const defaultPipelineExecutorFactory: PipelineExecutorFactory<
  PipelineDefinition,
  PipelineNode
> = (
  config: PipelineExecutorConfig<PipelineDefinition, PipelineNode>,
): PipelineExecutorPort => {
  return new PipelineRuntime({
    definition: config.definition,
    nodeExecutor: config.nodeExecutor,
    ...(config.predicates !== undefined ? { predicates: config.predicates } : {}),
    ...(config.signal !== undefined ? { signal: config.signal } : {}),
    ...(config.onEvent !== undefined
      ? { onEvent: config.onEvent as ConstructorParameters<typeof PipelineRuntime>[0]['onEvent'] }
      : {}),
  })
}
