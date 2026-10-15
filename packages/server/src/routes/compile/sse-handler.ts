/**
 * In-process SSE branch of `POST /compile` (Accept: text/event-stream).
 *
 * Streams `flow:compile_*` lifecycle events as they fire and emits a terminal
 * `flow:compile_result` event on success or `error` on failure (including a
 * `TARGET_MISMATCH` against the requested target). Post-compile handling runs
 * through `finalizeCompileSuccess`, the same step as every other branch.
 *
 * Extracted from `routes/compile.ts` (RF-23).
 */
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createEventBus } from '@dzupagent/core/events'
import { createFlowCompiler } from '@dzupagent/flow-compiler'
import type {
  AsyncPersonaResolver,
  CompilationTarget,
  CompileInvocationOptions,
  PersonaResolver,
} from '@dzupagent/flow-compiler'
import type { AsyncToolResolver, ToolResolver } from '@dzupagent/flow-ast'

import { compileNormalizedInput } from '../compile-input.js'
import { sanitizeError } from '../route-error.js'
import { buildCompileResultEvent } from '../compile-result-event.js'
import {
  FORWARDED_FLOW_COMPILE_EVENT_TYPES,
  type CompileRouteConfig,
  finalizeCompileSuccess,
  type ForwardedFlowCompileEvent,
  isCompileSuccessResult,
  isStreamErrorResult,
  publishToGateway,
} from './shared.js'

export interface SseCompileArgs {
  c: Context
  flowInput: string | object
  invocationOptions: CompileInvocationOptions
  requestedTarget: CompilationTarget | undefined
  runId: string
  config: CompileRouteConfig
  effectivePersonaResolver: PersonaResolver | AsyncPersonaResolver | undefined
  resolveToolResolver: () => Promise<ToolResolver | AsyncToolResolver>
}

export async function handleSseCompile(args: SseCompileArgs): Promise<Response> {
  const {
    c,
    flowInput,
    invocationOptions,
    requestedTarget,
    runId,
    config,
    effectivePersonaResolver,
    resolveToolResolver,
  } = args

  // Expose the run correlation id as a response header for client traceability.
  if (runId) {
    c.header('X-Run-Id', runId)
  }

  // Per-request event bus isolates this compile's events from any shared
  // bus. The compiler emits into this bus; we forward every event to
  // the SSE stream and complete when the terminal event fires.
  const bus = createEventBus()
  bus.onAny((event) => {
    if (!FORWARDED_FLOW_COMPILE_EVENT_TYPES.has(event.type as ForwardedFlowCompileEvent['type'])) {
      return
    }
    publishToGateway(config, event)
  })
  const toolResolver = await resolveToolResolver()
  const compiler = createFlowCompiler({
    toolResolver,
    ...(effectivePersonaResolver ? { personaResolver: effectivePersonaResolver } : {}),
    eventBus: bus,
    forwardInnerEvents: true,
  })

  return streamSSE(c, async (stream) => {
    let closed = false
    stream.onAbort(() => {
      closed = true
    })

    // Queue + signal: buffer events until the writer loop consumes them.
    const queue: ForwardedFlowCompileEvent[] = []
    let wake: (() => void) | null = null
    let terminal = false

    const unsubscribe = bus.onAny((event) => {
      if (!FORWARDED_FLOW_COMPILE_EVENT_TYPES.has(event.type as ForwardedFlowCompileEvent['type'])) {
        return
      }
      queue.push(event as ForwardedFlowCompileEvent)
      if (
        event.type === 'flow:compile_completed' ||
        event.type === 'flow:compile_failed'
      ) {
        terminal = true
      }
      const w = wake
      wake = null
      if (w) w()
    })

    // Kick off the compile — do NOT await here; stream events as they
    // arrive. Any thrown error is captured and surfaced as an SSE error.
    const compilePromise = compileNormalizedInput(compiler, flowInput, invocationOptions)
      .catch((err: unknown) => {
        const { safe } = sanitizeError(err)
        return { __streamError: safe } as const
      })

    try {
      // Drain loop: write queued events, await next emission, repeat
      // until terminal event observed AND compile promise settles.
      while (!closed) {
        while (queue.length > 0 && !closed) {
          const event = queue.shift() as ForwardedFlowCompileEvent
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
        if (terminal) break
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }

      const result = await compilePromise
      if (isStreamErrorResult(result)) {
        if (!closed) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: result.__streamError }),
          })
        }
      } else if (isCompileSuccessResult(result)) {
        // Target assertion, gateway publish and persistence (keyed on the
        // optional runId, else the compileId) — DZUPAGENT-CODE-M-17.
        const finalized = finalizeCompileSuccess(result, { requestedTarget, runId, config })
        if (!closed && !finalized.ok) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify(finalized.failure),
          })
        } else if (!closed) {
          await stream.writeSSE({
            event: 'flow:compile_result',
            data: JSON.stringify(buildCompileResultEvent(result)),
          })
        }
      }
    } finally {
      unsubscribe()
    }
  })
}
