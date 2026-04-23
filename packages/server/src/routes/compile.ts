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
 *    `flow:compile_*` lifecycle events plus a terminal
 *    `flow:compile_result` success payload or `flow:compile_failed`.
 *
 * The request body is one of:
 * ```
 * {
 *   "flow":   <FlowNode JSON>,      // required
 *   "target": "skill-chain" | "workflow-builder" | "pipeline"   // optional
 * }
 * {
 *   "document": <FlowDocumentV1 JSON>,
 *   "target": "skill-chain" | "workflow-builder" | "pipeline"   // optional
 * }
 * {
 *   "dsl": "dzupflow/v1 ...",
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
  CompilationDiagnostic,
  CompilationStage,
  CompilationTarget,
  CompilationTargetReason,
  CompilationWarning,
  CompileFailure,
  CompileSuccess,
} from '@dzupagent/flow-compiler'
import type { ToolResolver, AsyncToolResolver } from '@dzupagent/flow-ast'
import type { PersonaResolver, AsyncPersonaResolver } from '@dzupagent/flow-compiler'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent } from '@dzupagent/core'
import { sanitizeError } from './route-error.js'
import { buildCompileResultEvent } from './compile-result-event.js'
import { handleSubprocessCompile } from './spawn-compiler-bridge.js'
import { createBuiltinToolRegistryFromIndex } from '@dzupagent/app-tools'
import type { RunEventStore } from '@dzupagent/agent-adapters'
import type { EventGateway } from '../events/event-gateway.js'
import type { PersonaStore } from '../personas/persona-store.js'
import { createPersonaStoreResolver } from '../personas/persona-resolver.js'
import { normalizeCompileInput } from './compile-input.js'

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
  /**
   * Optional persona store. When `personaResolver` is omitted, the route
   * derives a resolver from this store so compile requests can validate
   * persona refs against the same catalog served by `/api/personas`.
   */
  personaStore?: PersonaStore
  /**
   * Optional path to a knowledge-index JSON file produced by the review
   * knowledge indexer. When provided AND no explicit `toolResolver` is set,
   * the server lazily calls {@link createBuiltinToolRegistryFromIndex} and
   * wires its `toToolResolver()` into the compile pipeline on the first
   * request. Ignored when `toolResolver` is supplied explicitly.
   */
  knowledgeIndexPath?: string
  /**
   * Optional {@link RunEventStore} instance. When provided, a successful
   * compile persists an artifact event (type `'other'`, action `'created'`)
   * so that `/runs/:id/artifacts` can serve the compile result without
   * requiring a backfill pass. Errors from the store are silently suppressed
   * (the store already logs to stderr internally).
   */
  runEventStore?: RunEventStore
  /**
   * Optional shared event gateway. When provided, the route republishes
   * compiler lifecycle events and the server-owned terminal result event so
   * WS/SSE subscribers can observe the same compile stream.
   */
  eventGateway?: EventGateway
}

/**
 * Narrowed request-body shape. `flow` is accepted as either a parsed object
 * or a JSON-encoded string — both are legal `ParseInput` values.
 */
interface CompileRequestBody {
  flow?: unknown
  document?: unknown
  dsl?: unknown
  target?: unknown
}

interface CompileSuccessResponse {
  ok: true
  artifact: unknown
  warnings: CompilationWarning[]
  reasons: CompilationTargetReason[]
  target: CompilationTarget
  compileId: string
}

interface CompileFailureResponse {
  ok: false
  error: string
  stage: CompilationStage
  errors: CompilationDiagnostic[]
  compileId?: string
}

type StreamCompileResult = CompileSuccess | CompileFailure | { readonly __streamError: string }

/** Lifecycle events forwarded from `@dzupagent/flow-compiler` over the local bus. */
type ForwardedFlowCompileEvent = Extract<
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

const FORWARDED_FLOW_COMPILE_EVENT_TYPES: ReadonlySet<ForwardedFlowCompileEvent['type']> = new Set<
  ForwardedFlowCompileEvent['type']
>([
  'flow:compile_started',
  'flow:compile_parsed',
  'flow:compile_shape_validated',
  'flow:compile_semantic_resolved',
  'flow:compile_lowered',
  'flow:compile_completed',
  'flow:compile_failed',
])

function makeRouteDiagnostic(
  stage: CompilationStage,
  code: string,
  message: string,
): CompilationDiagnostic {
  return { stage, code, message, nodePath: 'root' }
}

function failureBody(
  diagnostics: CompilationDiagnostic[],
  compileId?: string,
): CompileFailureResponse {
  const stage = diagnostics[0]?.stage ?? 1
  return {
    ok: false,
    error: diagnostics.map((diagnostic) => diagnostic.message).join('; '),
    stage,
    errors: diagnostics,
    ...(compileId ? { compileId } : {}),
  }
}

function isStreamErrorResult(value: StreamCompileResult): value is { readonly __streamError: string } {
  return '__streamError' in value
}

function isCompileSuccessResult(value: StreamCompileResult): value is CompileSuccess {
  return !isStreamErrorResult(value) && !('errors' in value)
}

function publishToGateway(config: CompileRouteConfig, event: DzupEvent): void {
  try {
    config.eventGateway?.publish(event)
  } catch {
    // Shared publication is best-effort; compile route behavior must not fail.
  }
}

function makeCompileBus(
  config: CompileRouteConfig,
): ReturnType<typeof createEventBus> | undefined {
  if (!config.eventGateway) return undefined
  const bus = createEventBus()
  bus.onAny((event) => {
    if (!FORWARDED_FLOW_COMPILE_EVENT_TYPES.has(event.type as ForwardedFlowCompileEvent['type'])) {
      return
    }
    publishToGateway(config, event)
  })
  return bus
}

export function createCompileRoutes(config: CompileRouteConfig = {}): Hono {
  const app = new Hono()
  const effectivePersonaResolver =
    config.personaResolver
    ?? (config.personaStore ? createPersonaStoreResolver(config.personaStore) : undefined)

  // Lazy tool resolver: when `knowledgeIndexPath` is configured and no
  // explicit `toolResolver` is provided, the first compile request triggers
  // a one-time load of the knowledge index and memoises the resulting
  // resolver for subsequent requests. Explicit `toolResolver` always wins.
  let knowledgeResolverPromise: Promise<ToolResolver | AsyncToolResolver> | null = null
  function resolveToolResolver(): Promise<ToolResolver | AsyncToolResolver> {
    if (config.toolResolver) {
      return Promise.resolve(config.toolResolver)
    }
    if (!config.knowledgeIndexPath) {
      return Promise.resolve(NOOP_TOOL_RESOLVER)
    }
    if (!knowledgeResolverPromise) {
      knowledgeResolverPromise = createBuiltinToolRegistryFromIndex({
        knowledgeIndexPath: config.knowledgeIndexPath,
      }).then((bundle) => bundle.toToolResolver() as ToolResolver)
    }
    return knowledgeResolverPromise
  }

  app.post('/compile', async (c) => {
    // --- Parse body ---
    let body: CompileRequestBody
    try {
      body = await c.req.json<CompileRequestBody>()
    } catch {
      return c.json(
        failureBody([makeRouteDiagnostic(1, 'INVALID_REQUEST', 'Invalid JSON body')]),
        400,
      )
    }

    const normalizedInput = normalizeCompileInput(body)
    if (!normalizedInput.ok) {
      return c.json(
        failureBody(normalizedInput.diagnostics),
        400,
      )
    }
    const { flowInput } = normalizedInput.value

    // Validate optional target
    let requestedTarget: CompilationTarget | undefined
    if (body.target !== undefined) {
      if (!isAllowedTarget(body.target)) {
        return c.json(
          failureBody([
            makeRouteDiagnostic(1, 'INVALID_ENUM_VALUE', `target must be one of ${ALLOWED_TARGETS.join(', ')}`),
          ]),
          400,
        )
      }
      requestedTarget = body.target
    }

    // --- Content negotiation ---
    const acceptHeader = c.req.header('accept') ?? ''
    const wantsSse = acceptHeader.includes('text/event-stream')

    // --- Subprocess SSE branch (?subprocess=true) ---
    // Routes through SpawnCompilerBridge: spawns dzupagent-compile as a child
    // process, pipes NDJSON stdout → SSE events. Provides true process isolation
    // at the cost of spawn overhead. Only honoured when the client also requests
    // SSE (text/event-stream); falls through to the JSON branch otherwise.
    if (wantsSse && c.req.query('subprocess') === 'true') {
      return handleSubprocessCompile(c, flowInput, { eventGateway: config.eventGateway })
    }

    // --- SSE streaming branch (in-process) ---
    if (wantsSse) {
      // Optional runId query param: when provided, the compile artifact is
      // persisted under this run rather than under the compileId. When absent
      // and a runEventStore is configured we emit a warning and skip
      // persistence so appendArtifact is never called with an undefined runId.
      const runId = c.req.query('runId') ?? ''
      if (!runId && config.runEventStore) {
        console.warn('SSE compile: runId missing, skipping persistence')
      }

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
          if (!closed && isStreamErrorResult(result)) {
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ error: result.__streamError }),
            })
          } else if (!closed && isCompileSuccessResult(result)) {
            publishToGateway(config, buildCompileResultEvent(result))
            await stream.writeSSE({
              event: 'flow:compile_result',
              data: JSON.stringify(buildCompileResultEvent(result)),
            })
          }

          if (
            runId &&
            config.runEventStore &&
            isCompileSuccessResult(result)
          ) {
            // Persist the SSE compile result (fire-and-forget).
            const r = result
            config.runEventStore.appendArtifact({
              runId,
              providerId: 'claude',
              timestamp: Date.now(),
              artifactType: 'output',
              path: `compile:${r.compileId}`,
              action: 'created',
              metadata: {
                type: 'compile:completed',
                target: r.target,
                artifact: r.artifact,
                warnings: r.warnings,
                reasons: r.reasons,
              },
            }).catch(() => {
              // Store errors are handled internally by RunEventStore (logged to stderr).
            })
          }
        } finally {
          unsubscribe()
        }
      })
    }

    // --- Default JSON branch ---
    const toolResolver = await resolveToolResolver()
    const eventBus = makeCompileBus(config)
    const compiler = createFlowCompiler({
      toolResolver,
      ...(effectivePersonaResolver ? { personaResolver: effectivePersonaResolver } : {}),
      ...(eventBus ? { eventBus, forwardInnerEvents: true } : {}),
    })

    try {
      const result = await compiler.compile(flowInput)

      if ('errors' in result) {
        // Failure — report the first error's stage (stages are monotonic; the
        // pipeline short-circuits at the first failing stage) along with the
        // aggregated message list.
        return c.json(failureBody(result.errors, result.compileId), 400)
      }

      // Success path — optional target assertion.
      if (requestedTarget !== undefined && result.target !== requestedTarget) {
        const diagnostics = [
          makeRouteDiagnostic(
            4,
            'TARGET_MISMATCH',
            `Requested target "${requestedTarget}" does not match compiler-routed target "${result.target}"`,
          ),
        ]
        return c.json(
          failureBody(diagnostics, result.compileId),
          400,
        )
      }

      publishToGateway(config, buildCompileResultEvent(result))

      // Persist compile artifact to the run event store (fire-and-forget).
      // Honour an optional caller-supplied runId (same pattern as the SSE branch).
      const runId = c.req.query('runId') ?? ''
      if (config.runEventStore) {
        config.runEventStore.appendArtifact({
          runId: runId || result.compileId,
          providerId: 'claude',
          timestamp: Date.now(),
          artifactType: 'output',
          path: `compile:${result.compileId}`,
          action: 'created',
          metadata: {
            type: 'compile:completed',
            target: result.target,
            artifact: result.artifact,
            warnings: result.warnings,
            reasons: result.reasons,
          },
        }).catch(() => {
          // Store errors are handled internally by RunEventStore (logged to stderr).
        })
      }

      const response: CompileSuccessResponse = {
        ok: true,
        artifact: result.artifact,
        warnings: result.warnings,
        reasons: result.reasons,
        target: result.target,
        compileId: result.compileId,
      }
      return c.json(response)
    } catch (err) {
      const { safe, internal } = sanitizeError(err)
       
      console.error(`[compile] ${internal}`)
      return c.json(
        failureBody([makeRouteDiagnostic(1, 'INTERNAL_ERROR', safe)]),
        500,
      )
    }
  })

  return app
}
