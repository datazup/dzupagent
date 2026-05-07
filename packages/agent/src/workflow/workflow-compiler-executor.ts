/**
 * Pipeline `NodeExecutor` factory used by the workflow compiler.
 *
 * Closes over the per-compilation transform handler map and produces an
 * executor compatible with `PipelineRuntime`. Extracted from
 * `workflow-compiler.ts` so the compiler coordinator can stay focused on
 * lowering `WorkflowNode[]` into `PipelineDefinition`.
 *
 * @module workflow/workflow-compiler-executor
 */
import type { PipelineNode } from '@dzupagent/core/pipeline'
import type { WorkflowContext, WorkflowEvent } from './workflow-types.js'
import type { WorkflowTransformHandler } from './workflow-compiler-types.js'
import type { NodeExecutor, NodeExecutionContext } from '../pipeline/pipeline-runtime-types.js'
import { asAbortSignal } from './workflow-compiler-error-handlers.js'
import { omitUndefined } from '../utils/exact-optional.js'

/**
 * Build a `NodeExecutor` bound to the compilation's handler map.
 *
 * Non-transform pipeline node types (suspend, etc.) are returned as
 * zero-duration no-ops; the canonical `PipelineRuntime` interprets those
 * shapes directly. Transform nodes look up their registered handler by
 * `transformName` and invoke it with a fresh `WorkflowContext` synthesised
 * from the runtime's `NodeExecutionContext`.
 */
export function createNodeExecutorFactory(
  workflowId: string,
  handlers: Map<string, WorkflowTransformHandler>,
): (
  emit: (event: WorkflowEvent) => void,
  onStateObserved: (state: Record<string, unknown>) => void,
) => NodeExecutor {
  return (emit, onStateObserved) => {
    const executor: NodeExecutor = async (
      nodeId: string,
      node: PipelineNode,
      context: NodeExecutionContext,
    ) => {
      onStateObserved(context.state)

      if (node.type !== 'transform') {
        return {
          nodeId,
          output: null,
          durationMs: 0,
        }
      }

      const handler = handlers.get(node.transformName)
      if (!handler) {
        return {
          nodeId,
          output: null,
          durationMs: 0,
          error: `No workflow transform handler found for "${node.transformName}"`,
        }
      }

      const startedAt = Date.now()
      try {
        const workflowCtx: WorkflowContext = omitUndefined({
          workflowId,
          state: context.state,
          signal: asAbortSignal(context.signal),
        })
        const output = await handler(context.state, workflowCtx, emit)
        onStateObserved(context.state)
        return {
          nodeId,
          output: output ?? null,
          durationMs: Date.now() - startedAt,
        }
      } catch (err) {
        return {
          nodeId,
          output: null,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    return executor
  }
}
