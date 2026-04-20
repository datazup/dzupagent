/**
 * Flow compilation route.
 *
 * POST /compile — Compile a FlowNode (JSON/object) into a skill-chain,
 *                 workflow-builder, or pipeline artifact via the
 *                 four-stage pipeline in `@dzupagent/flow-compiler`.
 *
 * Content negotiation:
 *  - `Accept: application/json` (default) → single JSON response.
 *  - `Accept: text/event-stream`          → SSE stream of
 *    `flow:compile_*` lifecycle events ending with
 *    `flow:compile_completed` or `flow:compile_failed`.
 *
 * The request body is:
 * ```
 * {
 *   "flow":   <FlowNode JSON>,      // required
 *   "target": "skill-chain" | "workflow-builder" | "pipeline"   // optional
 * }
 * ```
 *
 * If `target` is provided and does not match the compiler's auto-routed
 * target, a 400 is returned (guard against silent target drift between
 * caller intent and lowerer choice). When `target` is omitted the compiler's
 * routing decision is authoritative.
 *
 * Domain tool/persona catalogs are injected via `toolResolver` /
 * `personaResolver`. When neither is supplied we fall back to a sync no-op
 * resolver so the route stays reachable for smoke tests — unresolved refs
 * will surface as stage-3 errors.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createFlowCompiler } from '@dzupagent/flow-compiler'
import type {
  CompilationTarget,
  CompilationError,
} from '@dzupagent/flow-compiler'
import type { ToolResolver, AsyncToolResolver } from '@dzupagent/flow-ast'
import type { PersonaResolver, AsyncPersonaResolver } from '@dzupagent/flow-compiler'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent } from '@dzupagent/core'
import { sanitizeError } from './route-error.js'

/** Allowed compilation targets — mirrors `CompilationTarget` in flow-compiler. */
const ALLOWED_TARGETS: readonly CompilationTarget[] = [
  'skill-chain',
  'workflow-builder',
  'pipeline',
] as const

function isAllowedTarget(v: unknown): v is CompilationTarget {
  return typeof v === 'string' && (ALLOWED_TARGETS as readonly string[]).includes(v)
}

/** Sync no-op resolver used when the host has not wired a domain catalog yet. */
const NOOP_TOOL_RESOLVER: ToolResolver = {
  resolve: () => null,
  listAvailable: () => [],
}

export interface CompileRouteConfig {
  /**
   * Optional tool resolver. Defaults to a no-op resolver that returns `null`
   * for every lookup — callers relying on tool refs will see stage-3 errors.
   */
  toolResolver?: ToolResolver | AsyncToolResolver
  /** Optional persona resolver. Omitted resolvers treat every persona as unresolved. */
  personaResolver?: PersonaResolver | AsyncPersonaResolver
}

/**
 * Narrowed request-body shape. `flow` is accepted as either a parsed object
 * or a JSON-encoded string — both are legal `ParseInput` values.
 */
interface CompileRequestBody {
  flow?: unknown
  target?: unknown
}

/** Lifecycle event variants emitted by `@dzupagent/flow-compiler`. */
type FlowCompileEvent = Extract<
  DzupEvent,
  {
    type:
      | 'flow:compile_started'
      | 'flow:compile_parsed'
      | 'flow:compile_shape_validated'
      | 'flow:compile_semantic_resolved'
      | 'flow:compile_lowered'
      | 'flow:compile_completed'
      | 'flow:compile_failed'
  }
>

const FLOW_COMPILE_EVENT_TYPES: ReadonlySet<FlowCompileEvent['type']> = new Set<
  FlowCompileEvent['type']
>([
  'flow:compile_started',
  'flow:compile_parsed',
  'flow:compile_shape_validated',
  'flow:compile_semantic_resolved',
  'flow:compile_lowered',
  'flow:compile_completed',
  'flow:compile_failed',
])

export function createCompileRoutes(config: CompileRouteConfig = {}): Hono {
  const app = new Hono()

  app.post('/compile', async (c) => {
    // --- Parse body ---
    let body: CompileRequestBody
    try {
      body = await c.req.json<CompileRequestBody>()
    } catch {
      return c.json(
        { error: 'Invalid JSON body', stage: 1 },
        400,
      )
    }

    if (body.flow === undefined || body.flow === null) {
      return c.json(
        { error: 'flow is required', stage: 1 },
        400,
      )
    }

    // `ParseInput = string | object`. Reject other primitives eagerly so the
    // compiler sees a well-typed input.
    const flowInput: string | object =
      typeof body.flow === 'string'
        ? body.flow
        : typeof body.flow === 'object'
          ? (body.flow as object)
          : (null as unknown as string)

    if (flowInput === null) {
      return c.json(
        { error: 'flow must be a JSON string or object', stage: 1 },
        400,
      )
    }

    // Validate optional target
    let requestedTarget: CompilationTarget | undefined
    if (body.target !== undefined) {
      if (!isAllowedTarget(body.target)) {
        return c.json(
          {
            error: `target must be one of ${ALLOWED_TARGETS.join(', ')}`,
            stage: 1,
          },
          400,
        )
      }
      requestedTarget = body.target
    }

    // --- Content negotiation ---
    const acceptHeader = c.req.header('accept') ?? ''
    const wantsSse = acceptHeader.includes('text/event-stream')

    // --- SSE streaming branch ---
    if (wantsSse) {
      // Per-request event bus isolates this compile's events from any shared
      // bus. The compiler emits into this bus; we forward every event to
      // the SSE stream and complete when the terminal event fires.
      const bus = createEventBus()
      const compiler = createFlowCompiler({
        toolResolver: config.toolResolver ?? NOOP_TOOL_RESOLVER,
        ...(config.personaResolver ? { personaResolver: config.personaResolver } : {}),
        eventBus: bus,
        forwardInnerEvents: true,
      })

      return streamSSE(c, async (stream) => {
        let closed = false
        stream.onAbort(() => {
          closed = true
        })

        // Queue + signal: buffer events until the writer loop consumes them.
        const queue: FlowCompileEvent[] = []
        let wake: (() => void) | null = null
        let terminal = false

        const unsubscribe = bus.onAny((event) => {
          if (!FLOW_COMPILE_EVENT_TYPES.has(event.type as FlowCompileEvent['type'])) {
            return
          }
          queue.push(event as FlowCompileEvent)
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
        const compilePromise = compiler
          .compile(flowInput)
          .catch((err: unknown) => {
            const { safe } = sanitizeError(err)
            return { __streamError: safe } as const
          })

        try {
          // Drain loop: write queued events, await next emission, repeat
          // until terminal event observed AND compile promise settles.
          while (!closed) {
            while (queue.length > 0 && !closed) {
              const event = queue.shift() as FlowCompileEvent
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
          if (
            !closed &&
            typeof result === 'object' &&
            result !== null &&
            '__streamError' in result
          ) {
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ error: result.__streamError }),
            })
          }
        } finally {
          unsubscribe()
        }
      })
    }

    // --- Default JSON branch ---
    const compiler = createFlowCompiler({
      toolResolver: config.toolResolver ?? NOOP_TOOL_RESOLVER,
      ...(config.personaResolver ? { personaResolver: config.personaResolver } : {}),
    })

    try {
      const result = await compiler.compile(flowInput)

      if ('errors' in result) {
        // Failure — report the first error's stage (stages are monotonic; the
        // pipeline short-circuits at the first failing stage) along with the
        // aggregated message list.
        const firstStage: CompilationError['stage'] = result.errors[0]?.stage ?? 1
        return c.json(
          {
            error: result.errors.map((e) => e.message).join('; '),
            stage: firstStage,
            errors: result.errors,
            compileId: result.compileId,
          },
          400,
        )
      }

      // Success path — optional target assertion.
      if (requestedTarget !== undefined && result.target !== requestedTarget) {
        return c.json(
          {
            error: `Requested target "${requestedTarget}" does not match compiler-routed target "${result.target}"`,
            stage: 4,
            compileId: result.compileId,
          },
          400,
        )
      }

      return c.json({
        artifact: result.artifact,
        warnings: result.warnings,
        target: result.target,
        compileId: result.compileId,
      })
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
      // eslint-disable-next-line no-console
      console.error(`[compile] ${internal}`)
      return c.json(
        { error: safe, stage: 1 },
        500,
      )
    }
  })

  return app
}
