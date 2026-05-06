/**
 * Stage-event SSE branch of `POST /compile?stream=true`.
 *
 * Emits a coarse-grained sequence of `stage` events with per-stage durations
 * followed by either a terminal `result` event (success) or an `error` event
 * (failure). Independent of Accept negotiation; intended for simple browser
 * EventSource consumers that only care about lifecycle progress.
 *
 * Stage durations are measured between successive lifecycle events (the
 * compiler does not expose per-stage timing on each event payload).
 *
 * Extracted from `routes/compile.ts` (RF-23).
 */
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createEventBus } from '@dzupagent/core'
import { createFlowCompiler } from '@dzupagent/flow-compiler'
import type {
  AsyncPersonaResolver,
  CompilationTarget,
  CompileFailure,
  CompileInvocationOptions,
  CompileSuccess,
  PersonaResolver,
} from '@dzupagent/flow-compiler'
import type { AsyncToolResolver, ToolResolver } from '@dzupagent/flow-ast'

import { sanitizeError } from '../route-error.js'
import { buildCompileResultEvent } from '../compile-result-event.js'
import {
  FORWARDED_FLOW_COMPILE_EVENT_TYPES,
  type CompileRouteConfig,
  type ForwardedFlowCompileEvent,
  publishToGateway,
} from './shared.js'

/**
 * Mapping from compiler lifecycle event types to public stage names. The
 * compiler emits four progress events between `flow:compile_started` and
 * `flow:compile_completed`. We surface each as a single `stage` SSE event
 * carrying the elapsed duration since the previous stage marker.
 */
const STAGE_NAME_BY_EVENT: Record<string, 'parse' | 'validate' | 'lower' | 'codegen'> = {
  'flow:compile_parsed': 'parse',
  'flow:compile_shape_validated': 'validate',
  'flow:compile_semantic_resolved': 'lower',
  'flow:compile_lowered': 'codegen',
}

export interface StreamStageCompileArgs {
  // Narrowed to the Hono `Context` surface — `streamSSE` / `c.json` are the
  // only members consumed below.
  c: Context
  flowInput: string | object
  invocationOptions: CompileInvocationOptions
  requestedTarget: CompilationTarget | undefined
  config: CompileRouteConfig
  effectivePersonaResolver: PersonaResolver | AsyncPersonaResolver | undefined
  resolveToolResolver: () => Promise<ToolResolver | AsyncToolResolver>
}

/**
 * Implements the `?stream=true` SSE variant. On success a single `result`
 * event is emitted with the full {@link CompileSuccess} body; on failure an
 * `error` event with `{ message, stage }` is sent and the stream closes.
 */
export async function handleStageStreamCompile(args: StreamStageCompileArgs): Promise<Response> {
  const {
    c,
    flowInput,
    invocationOptions,
    requestedTarget,
    config,
    effectivePersonaResolver,
    resolveToolResolver,
  } = args

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

  // Set SSE headers up-front so `c.body` consumers see them. streamSSE handles
  // Content-Type/Cache-Control/Connection internally, but we duplicate the
  // intent here for clarity.
  return streamSSE(c, async (stream) => {
    let closed = false
    stream.onAbort(() => {
      closed = true
    })

    let lastStageAt = Date.now()
    const stageQueue: Array<{ stage: string; durationMs: number }> = []
    let stageWake: (() => void) | null = null

    const unsubscribe = bus.onAny((event) => {
      const stageName = STAGE_NAME_BY_EVENT[event.type]
      if (!stageName) return
      const now = Date.now()
      stageQueue.push({ stage: stageName, durationMs: now - lastStageAt })
      lastStageAt = now
      const w = stageWake
      stageWake = null
      if (w) w()
    })

    // Drain helper: writes any queued stage events synchronously.
    async function drainStages(): Promise<void> {
      while (stageQueue.length > 0 && !closed) {
        const event = stageQueue.shift() as { stage: string; durationMs: number }
        await stream.writeSSE({
          event: 'stage',
          data: JSON.stringify(event),
        })
      }
    }

    // Run the compile WITHOUT awaiting first, so stages can stream as they fire.
    type CompileOutcome = CompileSuccess | CompileFailure | { readonly __streamError: string }
    const compilePromise: Promise<CompileOutcome> = compiler
      .compile(flowInput, invocationOptions)
      .catch((err: unknown): { readonly __streamError: string } => {
        const { safe } = sanitizeError(err)
        return { __streamError: safe } as const
      })

    let settled = false
    void compilePromise.then(() => {
      settled = true
      const w = stageWake
      stageWake = null
      if (w) w()
    })

    try {
      while (!closed && !settled) {
        await drainStages()
        if (settled) break
        await new Promise<void>((resolve) => {
          stageWake = resolve
        })
      }
      // Final drain — pick up any stage events emitted during the same tick as
      // the terminal compile resolution.
      await drainStages()

      const result = await compilePromise
      if (closed) return

      if ('__streamError' in result) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: result.__streamError, stage: 'codegen' }),
        })
        return
      }

      if ('errors' in result) {
        const stage = result.errors[0]?.stage
        const stageLabel =
          stage === 1 ? 'parse'
          : stage === 2 ? 'validate'
          : stage === 3 ? 'lower'
          : 'codegen'
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            message: result.errors.map((e) => e.message).join('; '),
            stage: stageLabel,
            compileId: result.compileId,
          }),
        })
        return
      }

      // Success path — optional target assertion mirrors the JSON branch.
      if (requestedTarget !== undefined && result.target !== requestedTarget) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            message: `Requested target "${requestedTarget}" does not match compiler-routed target "${result.target}"`,
            stage: 'codegen',
            compileId: result.compileId,
          }),
        })
        return
      }

      publishToGateway(config, buildCompileResultEvent(result))
      await stream.writeSSE({
        event: 'result',
        data: JSON.stringify({
          ok: true,
          artifact: result.artifact,
          warnings: result.warnings,
          reasons: result.reasons,
          target: result.target,
          compileId: result.compileId,
          evidence: result.evidence,
        }),
      })
    } finally {
      unsubscribe()
    }
  })
}
