/**
 * Shared types, constants, and helpers for the `/compile` route handlers.
 *
 * Extracted from `routes/compile.ts` (RF-23) so each per-mode handler
 * (`json-handler.ts`, `sse-handler.ts`, `stage-stream-handler.ts`) can import
 * exactly what it needs without depending on the others.
 */
import { createEventBus, type DzupEvent } from '@dzupagent/core/events'
import { secureLogger } from '@dzupagent/core/utils'
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
import { buildCompileResultEvent } from '../compile-result-event.js'

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
   * Optional {@link RunEventStore} instance. When provided, every successful
   * compile on every branch persists one artifact event (type `'output'`,
   * action `'created'`) — see {@link finalizeCompileSuccess} for the rule —
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

/**
 * DZUPAGENT-ERR-H-02: fixed client-facing message for compiler diagnostics
 * that describe an infrastructure failure (e.g. a configured tool resolver
 * that threw) rather than a problem with the authored flow.
 */
export const INTERNAL_COMPILE_DIAGNOSTIC_MESSAGE =
  'Compilation could not complete because of an internal error'

/** `true` for diagnostics that carry internal infrastructure detail. */
export function isInternalCompileDiagnostic(diagnostic: CompilationDiagnostic): boolean {
  // `code` is typed as required but compiler fakes and older producers omit it.
  return (
    diagnostic.category === 'internal' ||
    (typeof diagnostic.code === 'string' && diagnostic.code.endsWith('_INFRA_ERROR'))
  )
}

/**
 * Public projection of one diagnostic. Authored validation diagnostics pass
 * through unchanged; internal ones get the fixed message and lose the
 * suggestion and fixes derived from the original text.
 */
export function toPublicCompileDiagnostic(
  diagnostic: CompilationDiagnostic,
): CompilationDiagnostic {
  if (!isInternalCompileDiagnostic(diagnostic)) return diagnostic
  const { suggestion: _suggestion, fixes: _fixes, ...rest } = diagnostic
  return { ...rest, message: INTERNAL_COMPILE_DIAGNOSTIC_MESSAGE }
}

/**
 * Log the original text of internal diagnostics, correlated with the compile
 * run, through the redacting server logger. Returns whether any were found so
 * transports can classify the failure as a server error.
 */
export function logInternalCompileDiagnostics(
  diagnostics: readonly CompilationDiagnostic[],
  compileId: string | undefined,
): boolean {
  const internal = diagnostics.filter(isInternalCompileDiagnostic)
  if (internal.length === 0) return false
  secureLogger.error({
    level: 'error',
    operation: 'compile.diagnostics.internal',
    ...(compileId ? { compileId } : {}),
    diagnostics: internal.map(({ stage, code, nodePath, message }) => ({
      stage,
      code,
      nodePath,
      message,
    })),
  })
  return true
}

export function failureBody(
  diagnostics: CompilationDiagnostic[],
  compileId?: string,
): CompileFailureResponse {
  const stage = diagnostics[0]?.stage ?? 1
  const errors = diagnostics.map(toPublicCompileDiagnostic)
  return {
    ok: false,
    error: errors.map((diagnostic) => diagnostic.message).join('; '),
    stage,
    errors,
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

/**
 * Producer identity recorded on compile artifacts. A compile result is made by
 * the flow compiler, not by any adapter provider, and `AdapterProviderId` has
 * no compiler member, so the required field carries this neutral value.
 */
export const COMPILE_ARTIFACT_PROVIDER_ID =
  'flow-compiler' as Parameters<RunEventStore['appendArtifact']>[0]['providerId']

/** The fields of a compiler success every branch can supply. */
export interface CompileSuccessPayload {
  compileId: string
  target: CompilationTarget
  artifact: unknown
  warnings: readonly CompilationWarning[]
  reasons?: readonly CompilationTargetReason[]
  evidence?: FlowCompileEvidence
}

export interface FinalizeCompileOptions {
  requestedTarget: CompilationTarget | undefined
  /** Caller-supplied `?runId`, or `''` when absent. */
  runId: string
  config: Pick<CompileRouteConfig, 'eventGateway' | 'runEventStore'>
}

export type FinalizeCompileOutcome =
  | { ok: true }
  | { ok: false; failure: CompileFailureResponse }

/**
 * DZUPAGENT-CODE-M-17: the one post-compile step that every `/compile` branch
 * (JSON, in-process SSE, `?stream=true` and subprocess SSE) runs on a
 * compiler success, so the branches cannot diverge:
 *
 * 1. Target assertion — a requested target that differs from the routed one
 *    is a `TARGET_MISMATCH` failure; nothing is published or persisted.
 * 2. Publication of the terminal `flow:compile_result` event to the shared
 *    gateway (best-effort).
 * 3. Persistence — when a `runEventStore` is configured, every success is
 *    appended once (fire-and-forget) under the caller's `?runId`, or under the
 *    `compileId` when no runId was given, at path `compile:<compileId>`, with
 *    the neutral {@link COMPILE_ARTIFACT_PROVIDER_ID}. A client that
 *    disconnects from a streaming branch does not skip persistence.
 */
export function finalizeCompileSuccess(
  result: CompileSuccessPayload,
  options: FinalizeCompileOptions,
): FinalizeCompileOutcome {
  const { requestedTarget, runId, config } = options
  if (requestedTarget !== undefined && result.target !== requestedTarget) {
    const diagnostics = [
      makeRouteDiagnostic(
        4,
        'TARGET_MISMATCH',
        `Requested target "${requestedTarget}" does not match compiler-routed target "${result.target}"`,
      ),
    ]
    return { ok: false, failure: failureBody(diagnostics, result.compileId) }
  }

  publishToGateway(config, buildCompileResultEvent(result))

  if (config.runEventStore) {
    config.runEventStore.appendArtifact({
      runId: runId || result.compileId,
      providerId: COMPILE_ARTIFACT_PROVIDER_ID,
      timestamp: Date.now(),
      artifactType: 'output',
      path: `compile:${result.compileId}`,
      action: 'created',
      metadata: {
        type: 'compile:completed',
        target: result.target,
        artifact: result.artifact,
        evidence: result.evidence,
        warnings: result.warnings,
        reasons: result.reasons ?? [],
      },
    }).catch(() => {
      // Store errors are handled internally by RunEventStore (logged to stderr).
    })
  }

  return { ok: true }
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
