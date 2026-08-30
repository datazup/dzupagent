/**
 * Model-lifecycle hook dispatch and compression adoption for the streaming
 * run loop (MC-026b-1).
 *
 * Extracted from `streaming-run-iteration.ts`, which keeps the per-iteration
 * stream mechanics (open, consume, usage, budget). Everything here is about
 * the transcript crossing a model boundary: firing `beforeModelCall` /
 * `afterModelCall` / `onModelError`, and adopting a compressed history when
 * the token-lifecycle plugin asks for one.
 *
 * @module agent/streaming-run-model-hooks
 */

import type { BaseMessage } from '@langchain/core/messages'
import { injectPromptCacheMarkersForModel } from '@dzupagent/context'
import {
  runBeforeModelCall,
  runAfterModelCall,
  runOnModelError,
} from '@dzupagent/core/orchestration'
import type { GenerateOptions } from './agent-types.js'
import type { PreparedRunState } from './run-engine.js'
import {
  buildModelHookContext,
  resolveModelIdForHooks,
} from './model-hooks.js'
import type { StreamRunContext } from './streaming-run-types.js'
import { appendGenerateContext } from './run-engine/generate-context.js'

/**
 * Adopt a compressed message history when the token-lifecycle plugin
 * decides compression is required. Best-effort: errors are swallowed
 * so an active stream is never aborted by a compression failure.
 */
export async function maybeAdoptCompression(
  ctx: StreamRunContext,
  allMessages: BaseMessage[],
  runState: PreparedRunState,
  context?: string,
): Promise<void> {
  const tokenPlugin = ctx.config.tokenLifecyclePlugin
  if (!tokenPlugin) return
  try {
    const compressResult = await tokenPlugin.maybeCompress(
      allMessages,
      runState.model,
      null,
    )
    for (const degradation of compressResult.degradations ?? []) {
      ctx.config.eventBus?.emit({
        type: 'context:compress_failed',
        error: degradation.reason,
        phase: `stream:${degradation.stage}`,
      })
    }
    if (compressResult.compressed) {
      const contextMessages = appendGenerateContext(
        compressResult.messages,
        context,
      )
      // WS3 Task 3.2 — model-lifecycle hooks run BEFORE prompt-cache
      // re-injection on the compressed transcript. ORDERING IS LOAD-BEARING:
      // `beforeModelCall` may rewrite the array, and cache breakpoints must be
      // computed on the final array (a hook edit after injection would
      // silently invalidate breakpoint placement). The hooked transcript is
      // adopted for the next stream iteration.
      const hookedMessages = await runBeforeModelCall(
        ctx.config.hooks?.beforeModelCall
          ? [ctx.config.hooks.beforeModelCall]
          : undefined,
        ctx.config.eventBus,
        contextMessages,
        resolveModelIdForHooks(ctx.config.model, runState.model),
        buildModelHookContext(
          ctx.config,
          ctx.agentId,
          ctx.config.toolExecution?.runId,
        ),
      )
      const finalMessages = appendGenerateContext(hookedMessages, context)
      // REC-H-10 — re-apply Anthropic prompt-cache markers after the
      // transcript has been replaced; otherwise subsequent stream iterations
      // miss the cache and pay full input price for every turn. Injector is
      // a no-op for non-Claude models and short transcripts.
      const recached = injectPromptCacheMarkersForModel(
        finalMessages,
        runState.model,
      )
      allMessages.length = 0
      allMessages.push(...recached)
    }
  } catch (error) {
    // Compression is best-effort and must not abort an active stream.
    ctx.config.eventBus?.emit({
      type: 'context:compress_failed',
      error: error instanceof Error ? error.message : String(error),
      phase: 'stream',
    })
  }
}

/**
 * WS3 Task 3.2 — fire `afterModelCall` once per completed stream iteration
 * with the fully-accumulated final message (NOT per-chunk), matching how the
 * streaming path already post-processes an assembled response. Error-isolated
 * in the core dispatcher.
 */
export async function dispatchStreamAfterModelCall(
  ctx: StreamRunContext,
  runState: PreparedRunState,
  requestMessages: BaseMessage[],
  finalMessage: BaseMessage,
  options: GenerateOptions | undefined,
): Promise<void> {
  await runAfterModelCall(
    ctx.config.hooks?.afterModelCall
      ? [ctx.config.hooks.afterModelCall]
      : undefined,
    ctx.config.eventBus,
    requestMessages,
    finalMessage,
    resolveModelIdForHooks(ctx.config.model, runState.model),
    buildModelHookContext(
      ctx.config,
      ctx.agentId,
      options?.runId ?? ctx.config.toolExecution?.runId,
    ),
  )
}

/**
 * WS3 Task 3.2 — fire `onModelError` when a streaming model invocation throws
 * (stream open or consumption failure). Error-isolated in the core dispatcher.
 */
export async function dispatchStreamOnModelError(
  ctx: StreamRunContext,
  runState: PreparedRunState,
  error: unknown,
  options: GenerateOptions | undefined,
): Promise<void> {
  await runOnModelError(
    ctx.config.hooks?.onModelError
      ? [ctx.config.hooks.onModelError]
      : undefined,
    ctx.config.eventBus,
    error instanceof Error ? error : new Error(String(error)),
    resolveModelIdForHooks(ctx.config.model, runState.model),
    buildModelHookContext(
      ctx.config,
      ctx.agentId,
      options?.runId ?? ctx.config.toolExecution?.runId,
    ),
  )
}
