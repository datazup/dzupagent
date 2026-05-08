/**
 * Non-streaming fallback path for the streaming coordinator (MC-026b-1).
 *
 * Used when the resolved model does not expose a native `stream()`
 * method, or when a middleware `wrapModelCall` interceptor is active
 * (which forces the synchronous request/response pipeline). Wraps
 * {@link executeGenerateRun} and translates its terminal result into
 * the streaming event surface so downstream callers don't need to
 * branch on the underlying transport.
 */

import type { BaseMessage } from '@langchain/core/messages'
import type {
  AgentStreamEvent,
  GenerateOptions,
} from './agent-types.js'
import {
  executeGenerateRun,
  type ExecuteGenerateRunParams,
  type PreparedRunState,
} from './run-engine.js'
import { omitUndefined } from '../utils/exact-optional.js'
import type { StreamRunContext } from './streaming-run-types.js'

/**
 * Adapt {@link executeGenerateRun} into a stream-event sequence. Yields
 * `text` (when content is present), then `done` carrying the resolved
 * stop reason and iteration-limit flag.
 */
export async function* runStreamFallback(
  ctx: StreamRunContext,
  runState: PreparedRunState,
  options: GenerateOptions | undefined,
): AsyncGenerator<AgentStreamEvent> {
  const result = await executeGenerateRun(omitUndefined<ExecuteGenerateRunParams>({
    agentId: ctx.agentId,
    config: ctx.config,
    options,
    runState,
    invokeModel: (model, preparedMessages) =>
      ctx.invokeModelWithMiddleware(model, preparedMessages, runState.tools),
    transformToolResult: (toolName, input, result) =>
      ctx.transformToolResultWithMiddleware(toolName, input, result),
    maybeUpdateSummary: (allMessages: BaseMessage[], memoryFrame: unknown) =>
      ctx.maybeUpdateSummary(allMessages, memoryFrame),
  }))

  if (result.content) {
    yield { type: 'text', data: { content: result.content } }
  }
  if (result.stopReason === 'complete') {
    const runId = options?.runId ?? ctx.config.toolExecution?.runId
    await ctx.maybeWriteBackMemory(result.content, runId)
  }
  yield {
    type: 'done',
    data: {
      content: result.content,
      stopReason: result.stopReason,
      ...(result.hitIterationLimit ? { hitIterationLimit: true } : {}),
    },
  }
}
