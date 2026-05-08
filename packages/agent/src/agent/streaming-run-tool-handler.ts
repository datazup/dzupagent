/**
 * Inner tool-call dispatch for the streaming run loop (MC-026b-1).
 *
 * Extracted from `streaming-run.ts` so the per-tool-call scheduling,
 * stuck-detection event emission, and policy-error short-circuit live
 * in their own module. Behaviour is unchanged; the coordinator drives
 * iteration order while this helper yields the events for a single
 * tool-call batch.
 */

import type { BaseMessage } from '@langchain/core/messages'
import type {
  AgentStreamEvent,
  GenerateOptions,
} from './agent-types.js'
import {
  executeStreamingToolCall,
  type StreamingToolPolicyOptions,
} from './run-engine.js'
import type { PreparedRunState, ToolStatTracker } from './run-engine.js'
import { estimateTokens } from '@dzupagent/core/llm'
import { omitUndefined } from '../utils/exact-optional.js'
import type { StreamRunContext } from './streaming-run-types.js'

/**
 * Result of dispatching one batch of tool calls. The coordinator either
 * keeps streaming (`status === 'continue'`) or stops on the supplied
 * terminal `stopReason`.
 */
export type ToolBatchOutcome =
  | { status: 'continue' }
  | { status: 'stop'; stopReason: 'aborted' | 'approval_pending' | 'stuck' }

/**
 * Yield {@link AgentStreamEvent}s for a single tool-call batch.
 *
 * Pushes resulting tool messages onto `allMessages` in place and
 * returns a {@link ToolBatchOutcome} so the coordinator can decide
 * whether to continue the outer iteration or short-circuit.
 */
export async function* handleStreamToolCalls(
  ctx: StreamRunContext,
  toolCalls: Array<{
    id?: string
    name: string
    args: Record<string, unknown>
  }>,
  state: {
    runState: PreparedRunState
    allMessages: BaseMessage[]
    toolStats: ToolStatTracker
    streamingPolicy: StreamingToolPolicyOptions | undefined
    options: GenerateOptions | undefined
  },
): AsyncGenerator<AgentStreamEvent, ToolBatchOutcome> {
  const { runState, allMessages, toolStats, streamingPolicy, options } = state
  const tokenPlugin = ctx.config.tokenLifecyclePlugin

  for (const toolCall of toolCalls) {
    yield { type: 'tool_call', data: { name: toolCall.name, args: toolCall.args } }

    let execution: Awaited<ReturnType<typeof executeStreamingToolCall>>
    try {
      execution = await executeStreamingToolCall(
        omitUndefined<Parameters<typeof executeStreamingToolCall>[0]>({
          toolCall,
          toolMap: runState.toolMap,
          budget: runState.budget,
          stuckDetector: runState.stuckDetector,
          transformToolResult: (toolName, input, result) =>
            ctx.transformToolResultWithMiddleware(toolName, input, result),
          onToolLatency: (name, durationMs, error) => {
            ctx.config.eventBus?.emit({
              type: 'tool:latency',
              toolName: name,
              durationMs,
              ...(error !== undefined ? { error } : {}),
            })
          },
          statTracker: toolStats,
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
          ...(streamingPolicy ? { policy: streamingPolicy } : {}),
        }),
      )
    } catch (err) {
      // The policy-enabled tool execution stage throws on permission
      // denial (TOOL_PERMISSION_DENIED). Match the non-streaming path's
      // behaviour: surface the error to the caller and end the run.
      const message = err instanceof Error ? err.message : String(err)
      yield { type: 'error', data: { message } }
      return { status: 'stop', stopReason: 'aborted' }
    }

    allMessages.push(execution.message)
    // Charge tool-result bytes against the token lifecycle plugin so the
    // streaming path mirrors the non-streaming executor in its per-phase
    // breakdown contributions.
    if (tokenPlugin && execution.eventResult) {
      tokenPlugin.trackPhase('tool-result', estimateTokens(execution.eventResult))
    }
    yield {
      type: 'tool_result',
      data: { name: toolCall.name, result: execution.eventResult },
    }

    if (execution.approvalPending) {
      return { status: 'stop', stopReason: 'approval_pending' }
    }

    if (execution.stuckReason && execution.stuckRecovery) {
      yield {
        type: 'stuck',
        data: {
          reason: execution.stuckReason,
          recovery: execution.stuckRecovery,
          ...(execution.repeatedTool ? { repeatedTool: execution.repeatedTool } : {}),
        },
      }
      ctx.config.eventBus?.emit({
        type: 'agent:stuck_detected',
        agentId: ctx.agentId,
        reason: execution.stuckReason,
        recovery: execution.stuckRecovery,
        timestamp: Date.now(),
        ...(execution.repeatedTool ? { repeatedTool: execution.repeatedTool } : {}),
        escalationLevel: execution.shouldStop ? 3 : 1,
      })

      if (execution.stuckNudge) {
        allMessages.push(execution.stuckNudge)
      }

      if (execution.shouldStop) {
        return { status: 'stop', stopReason: 'stuck' }
      }
    }
  }

  return { status: 'continue' }
}
