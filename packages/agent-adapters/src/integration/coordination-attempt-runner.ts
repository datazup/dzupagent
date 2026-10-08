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
import { isDeepStrictEqual } from 'node:util'

import type {
  CoordinationAssignmentDiagnostic,
  CoordinationAttemptExecutionPlan,
  CoordinationSha256Digest,
} from '@dzupagent/adapter-types'

import {
  compareCoordinationTimestamps,
  isCoordinationTimestamp,
} from './coordination-assignment-decoder.js'
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
  AgentExecutionConfigurationError,
  runAgentExecution,
  type AgentExecutionResult,
  type RunAgentExecutionOptions,
} from './run-agent-execution.js'

import { COORDINATION_ATTEMPT_CORRELATION_SCHEMA, type CoordinationAttemptCorrelation } from './coordination-attempt-correlation.js'
export { COORDINATION_ATTEMPT_CORRELATION_SCHEMA, type CoordinationAttemptCorrelation } from './coordination-attempt-correlation.js'

/** What the host may supply: where to run and how to stop. Never a binding fact. */
export interface CoordinationAttemptHost {
  /** The pinned checkout the host's source custody resolved. Required. */
  readonly workingDirectory: string
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

/** Attempt identity computed from the plan and its render attestation. */

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
      /** Refused before execution; final-start refusal may follow preparation. */
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
  /**
   * DZA-GAPADM-01-20261002-R1: re-read the host's authoritative grants/fences
   * for this exact plan immediately before spawn. Only literal true admits.
   * Required for every coordination attempt; composition is historical evidence.
   * Never forwarded to the execution seam. The host must also abort its signal
   * when authority is lost during execution; this predicate is not a lease store.
   */
  readonly observeAuthority?:
    | ((plan: CoordinationAttemptExecutionPlan) => boolean | Promise<boolean>)
    | undefined
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
  const { priceUsage, observeBindingDigests, observeAuthority, ...executionOptions } = options
  const rendered = renderCoordinationAgentExecutionRequest(plan)
  if (!rendered.ok) {
    return { ok: false, code: rendered.refusals[0]?.code ?? 'COORD_PLAN_INVALID', refusals: rendered.refusals }
  }
  const workingDirectory = isRecord(host) ? host.workingDirectory : undefined
  if (typeof workingDirectory !== 'string' || workingDirectory.length === 0) {
    return refusal('COORD_ATTEMPT_WORKSPACE_REQUIRED', '$host.workingDirectory', 'A coordination attempt runs only at the host-resolved checkout.')
  }

  const bound = plan.execution.bindingDigests
  if (bound === undefined) {
    return refusal(
      'COORD_BINDING_DIGESTS_REQUIRED',
      '$plan.execution.bindingDigests',
      'A coordination attempt runs only from a plan that pins the host-observable binding digests.',
    )
  }
  const drift = await checkObservedDigests(bound, observeBindingDigests)
  if (drift !== undefined) return drift

  async function observeCurrentAuthority(): Promise<CoordinationAttemptRunResult | undefined> {
    if (host.signal?.aborted) return cancelled()
    if (typeof observeAuthority !== 'function') {
      return refusal('COORD_ATTEMPT_AUTHORITY_OBSERVER_REQUIRED', '$options.observeAuthority', 'Current host authority must be observed before spawn.')
    }
    let current: unknown
    try {
      current = await observeAuthority(plan)
    } catch {
      return refusal('COORD_ATTEMPT_AUTHORITY_OBSERVATION_FAILED', '$authority', 'The host could not observe current authority.')
    }
    if (current !== true) {
      return refusal(current === false ? 'COORD_ATTEMPT_AUTHORITY_REVOKED' : 'COORD_ATTEMPT_AUTHORITY_OBSERVATION_FAILED', '$authority', 'The host did not affirm current authority for this plan.')
    }
    return undefined
  }
  const currentRefusal = await observeCurrentAuthority()
  if (currentRefusal !== undefined) return currentRefusal
  // Preparation also requires current admission, before credential resolution.
  if (host.signal?.aborted) return cancelled()
  const expired = checkSpawnTime(plan, options.now ?? Date.now)
  if (expired !== undefined) return expired

  let startRefusal: CoordinationAttemptRunResult | undefined
  const correlation = correlate(plan, rendered.attestation)
  const result = await runAgentExecution(
    {
      ...rendered.request,
      approvedFallbackProviders: [],
      workingDirectory,
      ...(host.signal ? { signal: host.signal } : {}),
      ...(host.timeoutMs !== undefined ? { timeoutMs: host.timeoutMs } : {}),
    },
    {
      ...executionOptions,
      ...(executionOptions.projectInput ? { projectInput: guardInputProjection(executionOptions.projectInput) } : {}),
      // DZUPAGENT-GAP4-01-20261003-R1: host projections and event listeners
      // can await arbitrarily. Re-observe at invocation, after those waits.
      async *guardAdapterStart(invoke) {
        startRefusal = await checkObservedDigests(bound, observeBindingDigests)
        if (startRefusal === undefined) startRefusal = await observeCurrentAuthority()
        if (startRefusal === undefined && host.signal?.aborted) startRefusal = cancelled()
        if (startRefusal === undefined) startRefusal = checkSpawnTime(plan, options.now ?? Date.now)
        if (startRefusal !== undefined) {
          throw new AgentExecutionConfigurationError(
            startRefusal.ok ? 'COORD_PLAN_INVALID' : startRefusal.code,
            'Coordination admission was refused at adapter start.',
          )
        }
        // No await between the final clock/cancellation checks and invocation.
        yield* invoke()
      },
    },
  )
  if (startRefusal !== undefined) return startRefusal
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
    tariffDigest: bound.tariff,
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

/**
 * DZA-GAP2-02-20261003-R1: projection is a host policy seam, not a second
 * request renderer. Give the callback detached values so in-place edits cannot
 * change the baseline or the routing task. Reconstruct the admitted input from
 * that baseline so later callback-owned mutations cannot change bound values.
 */
function guardInputProjection(
  project: NonNullable<RunAgentExecutionOptions['projectInput']>,
): NonNullable<RunAgentExecutionOptions['projectInput']> {
  return (input, task) => {
    const drift = () => new AgentExecutionConfigurationError(
      'COORD_ATTEMPT_INPUT_PROJECTION_DRIFT',
      'Coordinated input projection may augment host policy only.',
    )
    const { signal, ...values } = input
    const projectedTask = structuredClone(task)
    const projected = project({ ...structuredClone(values), ...(signal ? { signal } : {}) }, projectedTask)
    if (!isRecord(projected)) throw drift()
    // Read callback-owned properties once, before checking or forwarding them.
    const snapshot = { ...projected }
    if (snapshot.signal !== signal || !isDeepStrictEqual(projectedTask, task)) throw drift()
    for (const key of new Set([...Object.keys(values), ...Object.keys(snapshot)])) {
      if (key === 'policyContext' || key === 'options' || key === 'signal') continue
      if (!isDeepStrictEqual(snapshot[key], (values as Record<string, unknown>)[key])) throw drift()
    }
    if (snapshot.options !== undefined && !isRecord(snapshot.options)) throw drift()
    const options = { ...snapshot.options }
    for (const key of new Set([...Object.keys(input.options ?? {}), ...Object.keys(options)])) {
      // Worker supplies these policy controls alongside its typed policyContext.
      if (key === 'approvalPolicy' || key === 'interactionPolicy') continue
      if (!isDeepStrictEqual(options[key], input.options?.[key])) throw drift()
    }
    return {
      ...input,
      ...(snapshot.policyContext !== undefined ? { policyContext: structuredClone(snapshot.policyContext) } : {}),
      options: structuredClone(options),
    }
  }
}

function cancelled(): CoordinationAttemptRunResult {
  return refusal('COORD_ATTEMPT_CANCELLED', '$host.signal', 'The host cancelled the attempt before spawn.')
}

function checkSpawnTime(
  plan: CoordinationAttemptExecutionPlan,
  clock: () => number,
): CoordinationAttemptRunResult | undefined {
  let now: string
  try {
    const milliseconds = clock()
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) throw new Error('Invalid clock')
    now = new Date(milliseconds).toISOString()
    if (!isCoordinationTimestamp(now) || compareCoordinationTimestamps(now, plan.composedAt) < 0) throw new Error('Invalid clock')
  } catch {
    return refusal('COORD_NOW_INVALID', '$options.now', 'The spawn clock must be valid and no earlier than composition.')
  }
  const facts = [
    { code: 'COORD_ASSIGNMENT_EXPIRED', path: '$assignment.provenance.notAfter', deadline: plan.assignment.provenance.notAfter },
    { code: 'COORD_SESSION_EXPIRED', path: '$session.provenance.notAfter', deadline: plan.session.provenance.notAfter },
    ...plan.authority.grants.map((grant, index) => ({
      code: 'COORD_AUTHORITY_GRANT_EXPIRED', path: `$authority.grants.${index}.provenance.notAfter`, deadline: grant.provenance.notAfter,
    })),
  ]
  const refusals = facts
    .filter(({ deadline }) => deadline !== null && compareCoordinationTimestamps(now, deadline) >= 0)
    .map(({ code, path }) => Object.freeze({ code, path, message: 'The composed authority fact has expired before spawn.' }))
  if (refusals.length === 0) return undefined
  return { ok: false, code: refusals[0]!.code, refusals: Object.freeze(refusals) }
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
