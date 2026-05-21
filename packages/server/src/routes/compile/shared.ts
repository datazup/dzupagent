/**
 * Shared types, constants, and helpers for the `/compile` route handlers.
 *
 * Extracted from `routes/compile.ts` (RF-23) so each per-mode handler
 * (`json-handler.ts`, `sse-handler.ts`, `stage-stream-handler.ts`) can import
 * exactly what it needs without depending on the others.
 */
import { createEventBus, type DzupEvent } from '@dzupagent/core/events'
import type {
  CompilationDiagnostic,
  CompilationStage,
  CompilationTarget,
  CompilationTargetReason,
  CompilationWarning,
  CompileFailure,
  CompileInvocationOptions,
  CompileSuccess,
  FlowCompileEvidence,
  PersonaResolver,
  AsyncPersonaResolver,
} from '@dzupagent/flow-compiler'
import type { ToolResolver, AsyncToolResolver } from '@dzupagent/flow-ast'
import type { RunEventStore } from '@dzupagent/agent-adapters/runs'

import type { EventGateway } from '../../events/event-gateway.js'
import type { PersonaStore } from '../../personas/persona-store.js'
import { getSerializedJsonSizeBytes } from '../../validation/route-validator.js'
import type { NormalizedCompileInput } from '../compile-input.js'

/** Allowed compilation targets — mirrors `CompilationTarget` in flow-compiler. */
export const ALLOWED_TARGETS: readonly CompilationTarget[] = [
  'skill-chain',
  'workflow-builder',
  'pipeline',
] as const

/** Maximum serialized size of any single compile request field (`flow`/`document`/`dsl`). */
export const COMPILE_PAYLOAD_FIELD_MAX_BYTES = 1_048_576

export function isAllowedTarget(v: unknown): v is CompilationTarget {
  return typeof v === 'string' && (ALLOWED_TARGETS as readonly string[]).includes(v)
}

/** Sync no-op resolver used when the host has not wired a domain catalog yet. */
export const NOOP_TOOL_RESOLVER: ToolResolver = {
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
export interface CompileRequestBody {
  flow?: unknown
  document?: unknown
  dsl?: unknown
  target?: unknown
}

export interface CompileSuccessResponse {
  ok: true
  artifact: unknown
  warnings: CompilationWarning[]
  reasons: CompilationTargetReason[]
  target: CompilationTarget
  compileId: string
  evidence: FlowCompileEvidence
}

export interface CompileFailureResponse {
  ok: false
  error: string
  stage: CompilationStage
  errors: CompilationDiagnostic[]
  compileId?: string
}

export type StreamCompileResult =
  | CompileSuccess
  | CompileFailure
  | { readonly __streamError: string }

/** Lifecycle events forwarded from `@dzupagent/flow-compiler` over the local bus. */
export type ForwardedFlowCompileEvent = Extract<
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

export const FORWARDED_FLOW_COMPILE_EVENT_TYPES: ReadonlySet<
  ForwardedFlowCompileEvent['type']
> = new Set<ForwardedFlowCompileEvent['type']>([
  'flow:compile_started',
  'flow:compile_parsed',
  'flow:compile_shape_validated',
  'flow:compile_semantic_resolved',
  'flow:compile_lowered',
  'flow:compile_completed',
  'flow:compile_failed',
])

export function makeRouteDiagnostic(
  stage: CompilationStage,
  code: string,
  message: string,
): CompilationDiagnostic {
  return { stage, code, message, nodePath: 'root' }
}

export function failureBody(
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

export function isStreamErrorResult(
  value: StreamCompileResult,
): value is { readonly __streamError: string } {
  return '__streamError' in value
}

export function isCompileSuccessResult(value: StreamCompileResult): value is CompileSuccess {
  return !isStreamErrorResult(value) && !('errors' in value)
}

export function makeCompileInvocationOptions(
  body: CompileRequestBody,
  input: NormalizedCompileInput,
  runId: string,
): CompileInvocationOptions {
  const source =
    input.kind === 'dsl' ? body.dsl
      : input.kind === 'document' ? body.document
      : body.flow
  const correlation = runId ? { eventCorrelationId: runId, runId } : undefined

  return {
    sourceKind:
      input.kind === 'dsl' ? 'dzupflow-dsl'
        : input.kind === 'document' ? 'flow-document'
        : typeof input.flowInput === 'string' ? 'flow-json-string'
          : 'flow-object',
    source,
    ...(correlation ? { correlation } : {}),
  }
}

export function publishToGateway(config: CompileRouteConfig, event: DzupEvent): void {
  try {
    config.eventGateway?.publish(event)
  } catch {
    // Shared publication is best-effort; compile route behavior must not fail.
  }
}

export function makeCompileBus(
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

export function getOversizedCompilePayloadField(
  body: CompileRequestBody,
): 'flow' | 'document' | 'dsl' | undefined {
  for (const field of ['flow', 'document', 'dsl'] as const) {
    if (
      body[field] !== undefined &&
      getSerializedJsonSizeBytes(body[field]) > COMPILE_PAYLOAD_FIELD_MAX_BYTES
    ) {
      return field
    }
  }
  return undefined
}
