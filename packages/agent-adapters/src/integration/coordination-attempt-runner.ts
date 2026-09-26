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
 * - The provider's report is captured with the renderer profile's transport
 *   (MVP-04-CP05). It is a claim: it never changes `ok`, `code`, the
 *   correlation, usage or the plan, and a replaced provider's reply is not
 *   parsed.
 * - Every executed result carries a usage record bound to the attempt
 *   (MVP-04-CP07): unknown stays unknown, invalid values and cost
 *   disagreement are `uncertain`, and nothing is coerced.
 *
 * Admission: workspace-docs doc-coord-mvp04-admit-20260924-r1/MVP04-ADMISSION.md §4;
 * report capture: doc-coord-mvp04-cp05-admit-20260924-r1/ADMISSION.md §3.3;
 * usage record: doc-coord-mvp04-cp07-admit-20260924-r1/ADMISSION.md §3.2.
 */
import type {
  CoordinationAssignmentDiagnostic,
  CoordinationAttemptExecutionPlan,
  CoordinationExecutionBackend,
  CoordinationExecutionProviderId,
  CoordinationSha256Digest,
} from '@dzupagent/adapter-types'

import {
  COORDINATION_HOST_OBSERVED_BINDING_DIGEST_KEYS,
  renderCoordinationAgentExecutionRequest,
  type CoordinationAttemptExecutionAttestation,
} from './coordination-attempt-execution.js'
import {
  captureCoordinationAttemptReport,
  type CoordinationAttemptReportCapture,
} from './coordination-attempt-report.js'
import {
  recordCoordinationAttemptUsage,
  type CoordinationAttemptUsageRecord,
  type CoordinationUsagePricer,
} from './coordination-attempt-usage.js'
import {
  runAgentExecution,
  type AgentExecutionResult,
  type RunAgentExecutionOptions,
} from './run-agent-execution.js'

export const COORDINATION_ATTEMPT_CORRELATION_SCHEMA =
  'dzupagent.coordinationAttemptCorrelation/v2' as const

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
  /** The plan's agent host; `null` is the provider's own host. Never merged into `providerId`. */
  readonly agentHost: string | null
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
      /** The provider's report: a claim, never authority. */
      readonly report: CoordinationAttemptReportCapture
      /** Usage bound to this attempt; see {@link recordCoordinationAttemptUsage}. */
      readonly usageRecord: CoordinationAttemptUsageRecord
      readonly result: AgentExecutionResult
    }
  | {
      /** The provider ran; its outcome is not this attempt's success. */
      readonly ok: false
      readonly code: string
      readonly correlation: CoordinationAttemptCorrelation
      readonly attestation: CoordinationAttemptExecutionAttestation
      readonly usage: CoordinationAttemptUsage
      readonly report: CoordinationAttemptReportCapture
      /** Usage bound to this attempt; see {@link recordCoordinationAttemptUsage}. */
      readonly usageRecord: CoordinationAttemptUsageRecord
      readonly result: AgentExecutionResult
    }
  | {
      /** Refused before any adapter was materialized. */
      readonly ok: false
      readonly code: string
      readonly refusals: readonly CoordinationAssignmentDiagnostic[]
    }

/** The digests only the host can observe, re-read immediately before spawn. */
export interface CoordinationObservedBindingDigests {
  readonly binary: CoordinationSha256Digest
  readonly profile: CoordinationSha256Digest
  readonly tariff: CoordinationSha256Digest
}

export interface CoordinationAttemptRunOptions extends RunAgentExecutionOptions {
  /** Host pricing under the bound tariff. Never forwarded to the execution seam. */
  readonly priceUsage?: CoordinationUsagePricer | undefined
  /**
   * Required when the plan pins binding digests (a v3 binding). Any digest
   * that differs from the plan, or a throw, refuses the attempt before spawn.
   * Never forwarded to the execution seam.
   */
  readonly observeBindingDigests?:
    | (() => CoordinationObservedBindingDigests | Promise<CoordinationObservedBindingDigests>)
    | undefined
}

/**
 * Execute a composed coordination plan once, on exactly its bound provider,
 * backend, profile and model, at the host's working directory.
 */
export async function runCoordinationAttemptExecution(
  plan: CoordinationAttemptExecutionPlan,
  host: CoordinationAttemptHost,
  options: CoordinationAttemptRunOptions = {},
): Promise<CoordinationAttemptRunResult> {
  const { priceUsage, observeBindingDigests, ...executionOptions } = options
  const rendered = renderCoordinationAgentExecutionRequest(plan)
  if (!rendered.ok) {
    return { ok: false, code: rendered.refusals[0]?.code ?? 'COORD_PLAN_INVALID', refusals: rendered.refusals }
  }
  const workingDirectory = isRecord(host) ? host.workingDirectory : undefined
  if (typeof workingDirectory !== 'string' || workingDirectory.length === 0) {
    return refusal('COORD_ATTEMPT_WORKSPACE_REQUIRED', '$host.workingDirectory', 'A coordination attempt runs only at the host-resolved checkout.')
  }

  const bound = plan.execution.bindingDigests
  if (bound !== undefined) {
    const drift = await checkObservedDigests(bound, observeBindingDigests)
    if (drift !== undefined) return drift
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
    executionOptions,
  )
  const usage: CoordinationAttemptUsage = result.usage
    ? Object.freeze({ status: 'reported', usage: result.usage })
    : Object.freeze({ status: 'unknown' })
  const transport = rendered.attestation.reportTransport
  const replaced = replacedProvider(result, correlation.providerId)
  const report: CoordinationAttemptReportCapture = replaced
    ? Object.freeze({ status: 'invalid', authority: 'claim', transport, code: 'COORD_REPORT_PROVIDER_MISMATCH' })
    : captureCoordinationAttemptReport(result.text, { transport, attemptId: correlation.attemptId })
  const usageRecord = recordCoordinationAttemptUsage(correlation, result.usage, {
    priceUsage,
    ...(bound !== undefined ? { tariffDigest: bound.tariff } : {}),
  })
  const base = { correlation, attestation: rendered.attestation, usage, report, usageRecord, result }

  if (replaced) {
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
    agentHost: plan.execution.agentHost,
    tariffRef: attestation.tariffRef,
  })
}

/** True when anything other than the bound provider attempted or reported. */
function replacedProvider(result: AgentExecutionResult, bound: string): boolean {
  if (result.attemptedProviders.some((providerId) => providerId !== bound)) return true
  if (result.providerId !== undefined && result.providerId !== bound) return true
  return result.events.some((event) => event.providerId !== bound)
}

/** Refuse before spawn unless every host-observed digest still equals the plan. */
async function checkObservedDigests(
  bound: CoordinationObservedBindingDigests,
  observe: CoordinationAttemptRunOptions['observeBindingDigests'],
): Promise<CoordinationAttemptRunResult | undefined> {
  if (typeof observe !== 'function') {
    return refusal('COORD_BINDING_DIGEST_OBSERVER_REQUIRED', '$options.observeBindingDigests', 'A plan that pins binding digests runs only with a host digest observer.')
  }
  let observed: unknown
  try {
    observed = await observe()
  } catch {
    // The observer's error text is host detail; only the fact of failure is kept.
    return refusal('COORD_BINDING_DIGEST_DRIFT', '$binding.digests', 'The host could not re-observe the bound digests.')
  }
  const drifted = COORDINATION_HOST_OBSERVED_BINDING_DIGEST_KEYS.filter(
    (key) => !isRecord(observed) || observed[key] !== bound[key],
  )
  if (drifted.length === 0) return undefined
  return {
    ok: false,
    code: 'COORD_BINDING_DIGEST_DRIFT',
    refusals: Object.freeze(drifted.map((key) => Object.freeze({
      code: 'COORD_BINDING_DIGEST_DRIFT',
      path: `$binding.digests.${key}`,
      message: 'The host-observed digest differs from the one the plan pins.',
    }))),
  }
}

function refusal(code: string, path: string, message: string): CoordinationAttemptRunResult {
  return { ok: false, code, refusals: Object.freeze([Object.freeze({ code, path, message })]) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
