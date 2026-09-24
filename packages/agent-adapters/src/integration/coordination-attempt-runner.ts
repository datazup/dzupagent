/**
 * Coordination attempt runner (MVP-04-CP01).
 *
 * Runs a composer-issued coordination plan through the shipped
 * {@link runAgentExecution} seam and returns an attempt-bound result: the
 * render attestation, the execution result, and a correlation record built
 * from the plan rather than from anything the provider reports.
 *
 * Rules:
 * - Only plans the composer issued run; every render refusal is returned
 *   before an adapter is materialized.
 * - The host supplies the working directory and plumbing only. Provider,
 *   backend, auth, profile, model, reasoning, prompt, ids and fallback come
 *   from the rendered request; no parameter can restate them.
 * - No working directory, no run: the process directory is never used.
 * - A result or event from any provider other than the bound one is refused
 *   as a replacement. A replacement is a new binding and attempt.
 * - Absent usage is reported as `unknown`, never as zero.
 *
 * Admission: workspace-docs doc-coord-mvp04-admit-20260924-r1/MVP04-ADMISSION.md §4.
 */
import type {
  CoordinationAssignmentDiagnostic,
  CoordinationAttemptExecutionPlan,
  CoordinationExecutionBackend,
  CoordinationExecutionProviderId,
  CoordinationSha256Digest,
} from '@dzupagent/adapter-types'

import {
  renderCoordinationAgentExecutionRequest,
  type CoordinationAttemptExecutionAttestation,
} from './coordination-attempt-execution.js'
import {
  runAgentExecution,
  type AgentExecutionResult,
  type RunAgentExecutionOptions,
} from './run-agent-execution.js'

export const COORDINATION_ATTEMPT_CORRELATION_SCHEMA =
  'dzupagent.coordinationAttemptCorrelation/v1' as const

/** What the host may supply: where to run and how to stop. Never a binding fact. */
export interface CoordinationAttemptHost {
  /** The pinned checkout the host's source custody resolved. Required. */
  readonly workingDirectory: string
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

/** Attempt identity computed from the plan and its render attestation. */
export interface CoordinationAttemptCorrelation {
  readonly schema: typeof COORDINATION_ATTEMPT_CORRELATION_SCHEMA
  readonly planDigest: CoordinationSha256Digest
  readonly requestDigest: CoordinationSha256Digest
  readonly assignmentDigest: CoordinationSha256Digest
  readonly canonicalSeal: CoordinationSha256Digest
  readonly assignmentId: string
  readonly attemptId: string
  /** The coordination session the assignment enrolled. */
  readonly sessionId: string
  /** The execution binding that issued the plan's execution fact. */
  readonly bindingId: string
  /** Opaque provider-session reference the attempt opens. */
  readonly sessionRef: string
  readonly providerId: CoordinationExecutionProviderId
  readonly backend: CoordinationExecutionBackend
  readonly tariffRef: string
}

export type CoordinationAttemptUsage =
  | { readonly status: 'reported'; readonly usage: NonNullable<AgentExecutionResult['usage']> }
  | { readonly status: 'unknown' }

export type CoordinationAttemptRunResult =
  | {
      readonly ok: true
      readonly correlation: CoordinationAttemptCorrelation
      readonly attestation: CoordinationAttemptExecutionAttestation
      readonly usage: CoordinationAttemptUsage
      readonly result: AgentExecutionResult
    }
  | {
      /** The provider ran; its outcome is not this attempt's success. */
      readonly ok: false
      readonly code: string
      readonly correlation: CoordinationAttemptCorrelation
      readonly attestation: CoordinationAttemptExecutionAttestation
      readonly usage: CoordinationAttemptUsage
      readonly result: AgentExecutionResult
    }
  | {
      /** Refused before any adapter was materialized. */
      readonly ok: false
      readonly code: string
      readonly refusals: readonly CoordinationAssignmentDiagnostic[]
    }

export type CoordinationAttemptRunOptions = RunAgentExecutionOptions

/**
 * Execute a composed coordination plan once, on exactly its bound provider,
 * backend, profile and model, at the host's working directory.
 */
export async function runCoordinationAttemptExecution(
  plan: CoordinationAttemptExecutionPlan,
  host: CoordinationAttemptHost,
  options: CoordinationAttemptRunOptions = {},
): Promise<CoordinationAttemptRunResult> {
  const rendered = renderCoordinationAgentExecutionRequest(plan)
  if (!rendered.ok) {
    return { ok: false, code: rendered.refusals[0]?.code ?? 'COORD_PLAN_INVALID', refusals: rendered.refusals }
  }
  const workingDirectory = isRecord(host) ? host.workingDirectory : undefined
  if (typeof workingDirectory !== 'string' || workingDirectory.length === 0) {
    return refusal('COORD_ATTEMPT_WORKSPACE_REQUIRED', '$host.workingDirectory', 'A coordination attempt runs only at the host-resolved checkout.')
  }

  const correlation = correlate(plan, rendered.attestation)
  const result = await runAgentExecution(
    {
      ...rendered.request,
      approvedFallbackProviders: [],
      workingDirectory,
      ...(host.signal ? { signal: host.signal } : {}),
      ...(host.timeoutMs !== undefined ? { timeoutMs: host.timeoutMs } : {}),
    },
    options,
  )
  const usage: CoordinationAttemptUsage = result.usage
    ? Object.freeze({ status: 'reported', usage: result.usage })
    : Object.freeze({ status: 'unknown' })
  const base = { correlation, attestation: rendered.attestation, usage, result }

  if (replacedProvider(result, correlation.providerId)) {
    return { ok: false, code: 'COORD_ATTEMPT_PROVIDER_MISMATCH', ...base }
  }
  if (!result.ok) {
    return { ok: false, code: result.code ?? 'COORD_ATTEMPT_EXECUTION_FAILED', ...base }
  }
  return { ok: true, ...base }
}

function correlate(
  plan: CoordinationAttemptExecutionPlan,
  attestation: CoordinationAttemptExecutionAttestation,
): CoordinationAttemptCorrelation {
  return Object.freeze({
    schema: COORDINATION_ATTEMPT_CORRELATION_SCHEMA,
    planDigest: attestation.planDigest,
    requestDigest: attestation.requestDigest,
    assignmentDigest: attestation.assignmentDigest,
    canonicalSeal: attestation.canonicalSeal,
    assignmentId: plan.assignment.assignmentId,
    attemptId: plan.assignment.attemptId,
    sessionId: plan.session.sessionId,
    bindingId: plan.execution.provenance.issuerRef,
    sessionRef: plan.execution.sessionRef,
    providerId: plan.execution.providerId,
    backend: plan.execution.backend,
    tariffRef: attestation.tariffRef,
  })
}

/** True when anything other than the bound provider attempted or reported. */
function replacedProvider(result: AgentExecutionResult, bound: string): boolean {
  if (result.attemptedProviders.some((providerId) => providerId !== bound)) return true
  if (result.providerId !== undefined && result.providerId !== bound) return true
  return result.events.some((event) => event.providerId !== bound)
}

function refusal(code: string, path: string, message: string): CoordinationAttemptRunResult {
  return { ok: false, code, refusals: Object.freeze([Object.freeze({ code, path, message })]) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
