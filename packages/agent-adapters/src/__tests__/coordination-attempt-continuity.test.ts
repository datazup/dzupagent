/**
 * MVP-04-CP06 acceptance: runtime alignment through a native channel or a
 * restart, proved delivery, and continuation of a fenced attempt from its
 * checkpoint as a new attempt and binding.
 *
 * Admission: workspace-docs doc-coord-mvp04-cp06-admit-20260924-r1/ADMISSION.md §5.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { CoordinationAttemptExecutionPlan } from '@dzupagent/adapter-types'
import type { ProviderSessionAdapter } from '@dzupagent/adapter-types/provider-session'
import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_EFFECTS,
  PROVIDER_SESSION_OPERATION_SCHEMA,
  PROVIDER_SESSION_REFERENCE_SCHEMA,
  type ProviderSessionAttemptBinding,
  type ProviderSessionCapability,
  type ProviderSessionRef,
  type ProviderSessionSteerRequest,
} from '@dzupagent/runtime-contracts/provider-session'
import { describe, expect, it, vi } from 'vitest'

import {
  COORDINATION_ALIGNMENT_UPDATE_SCHEMA,
  COORDINATION_ATTEMPT_CORRELATION_SCHEMA,
  composeCoordinationAttemptExecution,
  coordinationCanonicalDigest,
  coordinationSelfDigest,
  decideCoordinationAlignment,
  decodeCoordinationExecutionAssignment,
  deliverCoordinationAlignment,
  renderCoordinationAgentExecutionRequest,
  verifyCoordinationContinuation,
  type CoordinationAlignmentDecision,
  type CoordinationAlignmentTarget,
  type CoordinationAlignmentUpdate,
  type CoordinationArtifactResolver,
  type CoordinationAttemptCorrelation,
} from '../integration/index.js'
import type { ProviderModelCatalog } from '../model-discovery-types.js'

// ---------------------------------------------------------------------------
// Fixture: the pinned v2 assignment, re-sealed in memory per case
// ---------------------------------------------------------------------------

const ASSIGNMENT_BYTES = readFileSync(
  new URL('./fixtures/coordination-critical-path/v2/execution-assignment.json', import.meta.url),
)

const NOW = '2026-08-30T10:30:00Z'
const TASK_CONTENT = '{"task":"task-scripts-adapter","goal":"implement the adapter"}'
const TRANSCRIPT_CONTENT = 'provider transcript: earlier turns of the fenced session'
const MODEL = 'model-sentinel-cp06'
const PROFILE_REF = 'profile-sentinel-cp06'
const AUTH_SOURCE_REF = 'auth-source-sentinel-cp06'
const TARIFF_REF = 'tariff-sentinel-cp06'
const INSTRUCTION = 'A sibling landed the shared helper; reuse it instead of adding one.'

const PREDECESSOR_ATTEMPT = 'attempt-scripts-critical'
const CONTINUATION_ATTEMPT = 'attempt-scripts-critical-2'

type Json = Record<string, any>
type Provider = 'claude' | 'codex'

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function reseal(assignment: Json): Json {
  assignment.contextPack.profile.profileRef = coordinationSelfDigest(assignment.contextPack.profile, 'profileRef')
  assignment.source.bindingDigest = coordinationSelfDigest(assignment.source, 'bindingDigest')
  assignment.workspace.source.bindingDigest = coordinationSelfDigest(assignment.workspace.source, 'bindingDigest')
  assignment.workspace.workspaceDigest = coordinationSelfDigest(assignment.workspace, 'workspaceDigest')
  assignment.authorityBundle.bundleDigest = coordinationSelfDigest(assignment.authorityBundle, 'bundleDigest')
  assignment.contextPack.manifestDigest = coordinationSelfDigest(assignment.contextPack, 'manifestDigest')
  const session = assignment.sessionEnrollment
  session.workIntentDigest = coordinationCanonicalDigest(assignment.workIntent)
  session.contextPackDigest = assignment.contextPack.manifestDigest
  session.enrollmentDigest = coordinationSelfDigest(session, 'enrollmentDigest')
  assignment.assignmentDigest = coordinationSelfDigest(assignment, 'assignmentDigest')
  return assignment
}

/** Replace a producer omission of `role` with a delivered item of `content`. */
function deliver(assignment: Json, role: string, content: string): void {
  assignment.contextPack.items.push({
    role,
    required: false,
    artifact: {
      schema: 'datazup.orchestration.artifact-reference/v1',
      artifactId: `artifact-${role}`,
      digest: sha256(content),
      mediaType: 'application/json',
      sensitivity: 'internal',
      retained: true,
    },
    contentDigest: sha256(content),
    sourceBindingDigest: assignment.source.bindingDigest,
    freshness: 'current',
    privacyLabel: 'internal',
  })
  assignment.contextPack.omissions = assignment.contextPack.omissions.filter(
    (omission: Json) => omission.role !== role,
  )
}

interface AssignmentOptions {
  readonly attemptId?: string
  readonly checkpoint?: string
  readonly transcript?: boolean
}

function assignment(options: AssignmentOptions = {}): Json {
  const value = JSON.parse(ASSIGNMENT_BYTES.toString('utf8')) as Json
  const task = value.contextPack.items[0]
  task.artifact.digest = sha256(TASK_CONTENT)
  task.contentDigest = sha256(TASK_CONTENT)
  if (options.attemptId !== undefined) {
    value.attemptId = options.attemptId
    value.sessionEnrollment.attemptId = options.attemptId
    value.contextPack.attemptId = options.attemptId
  }
  if (options.checkpoint !== undefined) deliver(value, 'predecessor_checkpoint', options.checkpoint)
  if (options.transcript) deliver(value, 'provider_transcript', TRANSCRIPT_CONTENT)
  return reseal(value)
}

function resolver(...contents: string[]): CoordinationArtifactResolver {
  const byDigest = new Map([TASK_CONTENT, ...contents].map((content) => [sha256(content), content]))
  return ({ digest }) => {
    const content = byDigest.get(digest)
    return content === undefined ? undefined : { content }
  }
}

interface BindingOptions {
  readonly provider?: Provider
  readonly attemptId?: string
  readonly bindingId?: string
  readonly providerSessionBindingId?: string
  readonly sessionRef?: string
  readonly unsupported?: readonly ProviderSessionCapability[]
}

function providerSession(options: BindingOptions): ProviderSessionAttemptBinding {
  const provider = options.provider ?? 'claude'
  const unsupported = new Set(options.unsupported ?? [])
  return {
    schema: PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
    bindingId: options.providerSessionBindingId ?? 'provider-session-binding-1',
    executionAttemptId: options.attemptId ?? PREDECESSOR_ATTEMPT,
    authSourceRef: AUTH_SOURCE_REF,
    descriptor: {
      schema: PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
      descriptorId: 'descriptor-sentinel-cp06',
      providerId: provider,
      backend: provider === 'claude' ? { id: 'claude-agent-sdk', kind: 'sdk' } : { id: 'codex-cli', kind: 'cli' },
      capabilities: Object.fromEntries(
        PROVIDER_SESSION_CAPABILITIES.map((capability) => [
          capability,
          unsupported.has(capability)
            ? { status: 'unsupported', emulation: 'forbidden', reason: 'not offered by this backend' }
            : { status: 'native', emulation: 'forbidden' },
        ]),
      ) as ProviderSessionAttemptBinding['descriptor']['capabilities'],
      observedAt: '2026-08-30T09:59:00.000Z',
    },
    effectAuthorities: Object.fromEntries(
      PROVIDER_SESSION_EFFECTS.map((effect) => [
        effect,
        { effect, retryAuthorityId: 'retry-authority', fallbackAuthorityId: 'fallback-authority', maxRetries: 0, fallback: 'none' },
      ]),
    ) as ProviderSessionAttemptBinding['effectAuthorities'],
    boundAt: '2026-08-30T10:00:00.000Z',
  }
}

function binding(options: BindingOptions): Json {
  const provider = options.provider ?? 'claude'
  return {
    schema: 'dzupagent.coordinationExecutionBinding/v2',
    bindingId: options.bindingId ?? 'execution-binding-1',
    providerId: provider,
    backend: provider === 'claude' ? 'sdk' : 'cli',
    agentHost: null,
    model: MODEL,
    profileRef: PROFILE_REF,
    auth: { mode: 'api_key', sourceRef: AUTH_SOURCE_REF },
    capabilitySet: {
      providerSession: providerSession(options),
      requiredCapabilities: ['execute', 'stream'],
      effects: [],
    },
    tariffRef: TARIFF_REF,
    sessionRef: options.sessionRef ?? 'session-ref-1',
    reasoning: 'high',
  }
}

function catalog(provider: Provider): ProviderModelCatalog {
  return {
    schemaVersion: 'dzupagent/provider-model-catalog/v1',
    providerId: provider,
    source: provider === 'claude' ? 'anthropic-models-api' : 'codex-cli',
    completeness: 'account-catalog',
    discoveredAt: '2026-08-30T09:00:00.000Z',
    authenticated: true,
    models: [{ providerId: provider, id: MODEL, displayName: 'Sentinel model', supportedReasoningEfforts: ['high'] }],
    warnings: [],
    fingerprint: 'catalog-fingerprint-1',
    backendId: provider === 'claude' ? 'claude-agent-sdk' : 'codex-cli',
  } as ProviderModelCatalog
}

async function plan(
  assignmentOptions: AssignmentOptions = {},
  bindingOptions: BindingOptions = {},
  contents: string[] = [],
): Promise<CoordinationAttemptExecutionPlan> {
  const value = assignment(assignmentOptions)
  const decoded = decodeCoordinationExecutionAssignment(JSON.stringify(value), {
    expectedSeal: coordinationCanonicalDigest(value),
  })
  if (!decoded.ok) throw new Error(`fixture did not decode: ${JSON.stringify(decoded.diagnostics)}`)
  const result = await composeCoordinationAttemptExecution({
    decoded: decoded.value,
    binding: binding({ attemptId: assignmentOptions.attemptId, ...bindingOptions }),
    now: NOW,
    modelCatalog: catalog(bindingOptions.provider ?? 'claude'),
    resolveArtifact: resolver(...contents),
  })
  if (!result.ok) throw new Error(`composition refused: ${JSON.stringify(result.refusals)}`)
  return result.plan
}

/** The correlation the runner returns for a plan, as a host retains it. */
function correlation(of: CoordinationAttemptExecutionPlan): CoordinationAttemptCorrelation {
  const rendered = renderCoordinationAgentExecutionRequest(of)
  if (!rendered.ok) throw new Error('plan did not render')
  return {
    schema: COORDINATION_ATTEMPT_CORRELATION_SCHEMA,
    planDigest: rendered.attestation.planDigest,
    requestDigest: rendered.attestation.requestDigest,
    assignmentDigest: rendered.attestation.assignmentDigest,
    canonicalSeal: rendered.attestation.canonicalSeal,
    assignmentId: of.assignment.assignmentId,
    attemptId: of.assignment.attemptId,
    sessionId: of.session.sessionId,
    bindingId: of.execution.provenance.issuerRef,
    sessionRef: of.execution.sessionRef,
    providerId: of.execution.providerId,
    backend: of.execution.backend,
    agentHost: of.execution.agentHost,
    tariffRef: rendered.attestation.tariffRef,
  }
}

function checkpoint(predecessor: CoordinationAttemptCorrelation, overrides: Json = {}): Json {
  const body: Json = {
    schema: 'datazup.coordination.checkpoint-handoff/v1',
    checkpointId: 'checkpoint-scripts-critical-1',
    assignmentId: predecessor.assignmentId,
    assignmentDigest: predecessor.assignmentDigest,
    attemptId: predecessor.attemptId,
    generation: 7,
    sourceBindingDigest: `sha256:${'b'.repeat(64)}`,
    candidate: null,
    actualPathSetDigest: `sha256:${'c'.repeat(64)}`,
    actualPathSetArtifact: {
      schema: 'datazup.orchestration.artifact-reference/v1',
      artifactId: 'artifact-path-set',
      digest: `sha256:${'d'.repeat(64)}`,
      mediaType: 'application/json',
      sensitivity: 'internal',
      retained: true,
    },
    evidence: [],
    blockerRefs: [],
    remainingWorkRefs: ['work:finish-adapter'],
    nextAction: { kind: 'continue', requiredAuthorityRef: null, ownerRef: 'owner:controller' },
    observedStreamSequence: 12,
    nextStreamSequence: 13,
    progressState: 'progressing',
    safeToResume: true,
    createdAt: '2026-08-30T10:10:00Z',
    ...overrides,
  }
  delete body.handoffDigest
  body.handoffDigest = coordinationSelfDigest(body, 'handoffDigest')
  return body
}

function update(overrides: Partial<CoordinationAlignmentUpdate> = {}): CoordinationAlignmentUpdate {
  return {
    schema: COORDINATION_ALIGNMENT_UPDATE_SCHEMA,
    updateId: 'update-1',
    attemptId: PREDECESSOR_ATTEMPT,
    kind: 'steer',
    changes: [],
    instruction: INSTRUCTION,
    ...overrides,
  }
}

const SESSION_REF: ProviderSessionRef = {
  schema: PROVIDER_SESSION_REFERENCE_SCHEMA,
  kind: 'session',
  opaqueId: 'provider-session-opaque-1',
}

function steerTarget(
  steer: ProviderSessionAdapter['steer'],
  bindingOverrides: BindingOptions = {},
): { target: CoordinationAlignmentTarget; calls: ProviderSessionSteerRequest[] } {
  const calls: ProviderSessionSteerRequest[] = []
  const session: ProviderSessionAdapter = {
    attemptBinding: providerSession(bindingOverrides),
    ...(steer
      ? {
          steer: async (request) => {
            calls.push(request)
            return steer(request)
          },
        }
      : {}),
  }
  return { target: { session, providerSession: SESSION_REF }, calls }
}

function decided(result: ReturnType<typeof decideCoordinationAlignment>): CoordinationAlignmentDecision {
  if (!result.ok) throw new Error(`decision refused: ${JSON.stringify(result.refusals)}`)
  return result.decision
}

function codes(result: { ok: boolean; refusals?: readonly { code: string }[] }): string[] {
  expect(result.ok).toBe(false)
  return (result.refusals ?? []).map(({ code }) => code)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
}

// ---------------------------------------------------------------------------
// A2. Acknowledged realignment
// ---------------------------------------------------------------------------

describe('A2. acknowledged realignment', () => {
  it('steers the bound session natively once and records the acknowledgement', async () => {
    const running = await plan()
    const decision = decided(decideCoordinationAlignment(running, update()))
    expect(decision).toMatchObject({ channel: 'native-steer', reasonCode: null, attemptId: PREDECESSOR_ATTEMPT })

    const { target, calls } = steerTarget(async () => ({ kind: 'steer', accepted: true }))
    const result = await deliverCoordinationAlignment(decision, update(), target)

    expect(calls).toEqual([
      {
        schema: PROVIDER_SESSION_OPERATION_SCHEMA,
        operationId: 'update-1',
        attemptBindingId: 'provider-session-binding-1',
        kind: 'steer',
        session: SESSION_REF,
        instruction: INSTRUCTION,
      },
    ])
    expect(result.ok && result.delivery).toMatchObject({ status: 'acknowledged', reasonCode: null, channel: 'native-steer' })
    if (!result.ok) return
    expect(result.delivery.deliveryDigest).toBe(coordinationSelfDigest(result.delivery, 'deliveryDigest'))
    expect(result.delivery.decisionDigest).toBe(coordinationSelfDigest(decision, 'decisionDigest'))
  })
})

// ---------------------------------------------------------------------------
// A3. Unacknowledged-update restart
// ---------------------------------------------------------------------------

describe('A3. unacknowledged-update restart', () => {
  it('requires a restart when steer throws, and keeps the thrown message out', async () => {
    const decision = decided(decideCoordinationAlignment(await plan(), update()))
    const { target, calls } = steerTarget(async () => {
      throw new Error('upstream said: secret-token-cp06')
    })
    const result = await deliverCoordinationAlignment(decision, update(), target)
    expect(calls).toHaveLength(1)
    expect(result.ok && result.delivery).toMatchObject({ status: 'restart-required', reasonCode: 'ALIGNMENT_UNACKNOWLEDGED' })
    expect(JSON.stringify(result)).not.toContain('secret-token-cp06')
  })

  it('requires a restart when steer resolves without accepted: true', async () => {
    const decision = decided(decideCoordinationAlignment(await plan(), update()))
    for (const reply of [{ kind: 'steer' }, { kind: 'steer', accepted: false }, { kind: 'interrupt-turn', accepted: true }, undefined]) {
      const { target, calls } = steerTarget(async () => reply as never)
      const result = await deliverCoordinationAlignment(decision, update(), target)
      expect(calls).toHaveLength(1)
      expect(result.ok && result.delivery.status).toBe('restart-required')
    }
  })

  it('requires a restart when the bound session has no steer method', async () => {
    const decision = decided(decideCoordinationAlignment(await plan(), update()))
    const { target } = steerTarget(undefined)
    const result = await deliverCoordinationAlignment(decision, update(), target)
    expect(result.ok && result.delivery).toMatchObject({ status: 'restart-required', reasonCode: 'ALIGNMENT_UNACKNOWLEDGED' })
  })

  it('restarts without calling the provider when steer is not native', async () => {
    const running = await plan({}, { unsupported: ['steer'] })
    const decision = decided(decideCoordinationAlignment(running, update()))
    expect(decision).toMatchObject({ channel: 'restart', reasonCode: 'NATIVE_STEER_UNSUPPORTED' })
    const steer = vi.fn(async () => ({ kind: 'steer' as const, accepted: true as const }))
    const result = await deliverCoordinationAlignment(decision, update(), steerTarget(steer).target)
    expect(steer).not.toHaveBeenCalled()
    expect(result.ok && result.delivery).toMatchObject({ status: 'restart-required', reasonCode: 'NATIVE_STEER_UNSUPPORTED' })
  })

  it('restarts an update that changes the source even when steer is native', async () => {
    const changed = update({ changes: ['source'] })
    const decision = decided(decideCoordinationAlignment(await plan(), changed))
    expect(decision).toMatchObject({ channel: 'restart', reasonCode: 'ALIGNMENT_CHANGES_BINDING_FACTS' })
    const steer = vi.fn(async () => ({ kind: 'steer' as const, accepted: true as const }))
    const result = await deliverCoordinationAlignment(decision, changed, steerTarget(steer).target)
    expect(steer).not.toHaveBeenCalled()
    expect(result.ok && result.delivery.status).toBe('restart-required')
  })
})

// ---------------------------------------------------------------------------
// A4. Interaction resume
// ---------------------------------------------------------------------------

describe('A4. interaction resume', () => {
  const answer = update({ kind: 'interaction-response', interactionId: 'interaction-7' })

  it('answers the pending interaction natively and resumes on true', async () => {
    const decision = decided(decideCoordinationAlignment(await plan(), answer))
    expect(decision).toMatchObject({ channel: 'native-interaction', interactionId: 'interaction-7' })
    const respondInteraction = vi.fn(() => true)
    const result = await deliverCoordinationAlignment(decision, answer, { interactions: { respondInteraction } })
    expect(respondInteraction).toHaveBeenCalledExactlyOnceWith('interaction-7', INSTRUCTION)
    expect(result.ok && result.delivery.status).toBe('acknowledged')
  })

  it('requires a restart when the interaction is not taken', async () => {
    const decision = decided(decideCoordinationAlignment(await plan(), answer))
    const result = await deliverCoordinationAlignment(decision, answer, { interactions: { respondInteraction: () => false } })
    expect(result.ok && result.delivery).toMatchObject({ status: 'restart-required', reasonCode: 'ALIGNMENT_UNACKNOWLEDGED' })
    const missing = await deliverCoordinationAlignment(decision, answer, {})
    expect(missing.ok && missing.delivery.status).toBe('restart-required')
  })

  it('restarts when interaction is not native', async () => {
    const decision = decided(decideCoordinationAlignment(await plan({}, { unsupported: ['interaction'] }), answer))
    expect(decision).toMatchObject({ channel: 'restart', reasonCode: 'NATIVE_INTERACTION_UNSUPPORTED' })
  })
})

// ---------------------------------------------------------------------------
// A5. Provider replacement and A6. fresh continuation
// ---------------------------------------------------------------------------

async function fenced(): Promise<{ predecessor: CoordinationAttemptCorrelation; handoff: string }> {
  const predecessor = correlation(await plan())
  return { predecessor, handoff: JSON.stringify(checkpoint(predecessor)) }
}

const NEW_BINDING: BindingOptions = {
  bindingId: 'execution-binding-2',
  providerSessionBindingId: 'provider-session-binding-2',
  sessionRef: 'session-ref-2',
}

describe('A5. provider replacement', () => {
  it('verifies a codex continuation of a claude attempt as a provider replacement', async () => {
    const { predecessor, handoff } = await fenced()
    const continuation = await plan(
      { attemptId: CONTINUATION_ATTEMPT, checkpoint: handoff },
      { ...NEW_BINDING, provider: 'codex' },
      [handoff],
    )
    const result = verifyCoordinationContinuation({ predecessor, continuation })
    expect(result.ok && result.continuation).toMatchObject({
      kind: 'provider-replacement',
      predecessorProviderId: 'claude',
      providerId: 'codex',
      predecessorAttemptId: PREDECESSOR_ATTEMPT,
      attemptId: CONTINUATION_ATTEMPT,
      bindingId: 'execution-binding-2',
    })
  })

  it('refuses a continuation under the fenced attempt', async () => {
    const { predecessor, handoff } = await fenced()
    const continuation = await plan({ checkpoint: handoff }, { ...NEW_BINDING, provider: 'codex' }, [handoff])
    expect(codes(verifyCoordinationContinuation({ predecessor, continuation }))).toEqual(['COORD_CONTINUATION_REUSES_ATTEMPT'])
  })

  it('refuses a continuation on the fenced binding or session', async () => {
    const { predecessor, handoff } = await fenced()
    for (const reuse of [{ bindingId: 'execution-binding-1' }, { sessionRef: 'session-ref-1' }]) {
      const continuation = await plan(
        { attemptId: CONTINUATION_ATTEMPT, checkpoint: handoff },
        { ...NEW_BINDING, ...reuse, provider: 'codex' },
        [handoff],
      )
      expect(codes(verifyCoordinationContinuation({ predecessor, continuation }))).toEqual(['COORD_CONTINUATION_REUSES_BINDING'])
    }
  })
})

describe('A6. fresh continuation', () => {
  it('verifies a same-provider restart from the checkpoint in the pack', async () => {
    const { predecessor, handoff } = await fenced()
    const continuation = await plan({ attemptId: CONTINUATION_ATTEMPT, checkpoint: handoff }, NEW_BINDING, [handoff])
    const result = verifyCoordinationContinuation({ predecessor, continuation })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const parsed = JSON.parse(handoff) as Json
    expect(result.continuation).toMatchObject({
      kind: 'restart',
      checkpointId: 'checkpoint-scripts-critical-1',
      handoffDigest: parsed.handoffDigest,
      checkpointSourceBindingDigest: parsed.sourceBindingDigest,
      planDigest: continuation.planDigest,
    })
    expect(result.continuation.continuationDigest).toBe(coordinationSelfDigest(result.continuation, 'continuationDigest'))
    expect(isDeepFrozen(result)).toBe(true)
  })

  it('refuses a continuation without a checkpoint', async () => {
    const { predecessor } = await fenced()
    const continuation = await plan({ attemptId: CONTINUATION_ATTEMPT }, NEW_BINDING)
    expect(codes(verifyCoordinationContinuation({ predecessor, continuation }))).toEqual(['COORD_CONTINUATION_CHECKPOINT_MISSING'])
  })

  it('refuses a checkpoint whose handoff digest does not hold', async () => {
    const { predecessor } = await fenced()
    const tampered = JSON.stringify({ ...checkpoint(predecessor), remainingWorkRefs: ['work:something-else'] })
    const continuation = await plan({ attemptId: CONTINUATION_ATTEMPT, checkpoint: tampered }, NEW_BINDING, [tampered])
    expect(codes(verifyCoordinationContinuation({ predecessor, continuation }))).toEqual(['COORD_CONTINUATION_CHECKPOINT_INVALID'])
  })

  it('refuses a checkpoint with an unknown key or that is not JSON', async () => {
    const { predecessor } = await fenced()
    for (const bad of [JSON.stringify(checkpoint(predecessor, { transcript: 'x' })), 'not json']) {
      const continuation = await plan({ attemptId: CONTINUATION_ATTEMPT, checkpoint: bad }, NEW_BINDING, [bad])
      expect(codes(verifyCoordinationContinuation({ predecessor, continuation }))).toEqual(['COORD_CONTINUATION_CHECKPOINT_INVALID'])
    }
  })

  it('refuses a checkpoint for another attempt', async () => {
    const { predecessor } = await fenced()
    const other = JSON.stringify(checkpoint(predecessor, { attemptId: 'attempt-someone-else' }))
    const continuation = await plan({ attemptId: CONTINUATION_ATTEMPT, checkpoint: other }, NEW_BINDING, [other])
    expect(codes(verifyCoordinationContinuation({ predecessor, continuation }))).toEqual(['COORD_CONTINUATION_CHECKPOINT_MISMATCH'])
  })

  it('refuses a blocked checkpoint that is not safe to resume', async () => {
    const { predecessor } = await fenced()
    const blocked = JSON.stringify(
      checkpoint(predecessor, {
        progressState: 'blocked',
        blockerRefs: ['blocker:owner'],
        nextAction: { kind: 'owner_decision', requiredAuthorityRef: null, ownerRef: 'owner:controller' },
        safeToResume: false,
      }),
    )
    const continuation = await plan({ attemptId: CONTINUATION_ATTEMPT, checkpoint: blocked }, NEW_BINDING, [blocked])
    expect(codes(verifyCoordinationContinuation({ predecessor, continuation }))).toEqual(['COORD_CONTINUATION_NOT_SAFE'])
  })

  it('refuses a checkpoint newer than the continuation plan', async () => {
    const { predecessor } = await fenced()
    const future = JSON.stringify(checkpoint(predecessor, { createdAt: '2026-08-30T11:00:00Z' }))
    const continuation = await plan({ attemptId: CONTINUATION_ATTEMPT, checkpoint: future }, NEW_BINDING, [future])
    expect(codes(verifyCoordinationContinuation({ predecessor, continuation }))).toEqual(['COORD_CONTINUATION_CHECKPOINT_FUTURE'])
  })

  it('refuses a continuation that carries a provider transcript', async () => {
    const { predecessor, handoff } = await fenced()
    const continuation = await plan(
      { attemptId: CONTINUATION_ATTEMPT, checkpoint: handoff, transcript: true },
      NEW_BINDING,
      [handoff, TRANSCRIPT_CONTENT],
    )
    expect(continuation.context.items.map(({ role }) => role)).toContain('provider_transcript')
    expect(codes(verifyCoordinationContinuation({ predecessor, continuation }))).toEqual(['COORD_CONTINUATION_TRANSCRIPT_CARRIED'])
  })
})

// ---------------------------------------------------------------------------
// A7. Binding and shape
// ---------------------------------------------------------------------------

describe('A7. binding and shape', () => {
  it('refuses a plan the composer did not issue', async () => {
    // A frozen copy with a valid digest, so only issuance tells it apart.
    const copy = deepFreeze(structuredClone(await plan())) as CoordinationAttemptExecutionPlan
    expect(codes(decideCoordinationAlignment(copy, update()))).toEqual(['COORD_PLAN_NOT_COMPOSED'])
    const { predecessor } = await fenced()
    expect(codes(verifyCoordinationContinuation({ predecessor, continuation: copy }))).toEqual(['COORD_PLAN_NOT_COMPOSED'])
  })

  it('refuses an update for another attempt or with an unknown or missing field', async () => {
    const running = await plan()
    expect(codes(decideCoordinationAlignment(running, update({ attemptId: 'attempt-other' })))).toEqual(['COORD_ALIGNMENT_ATTEMPT_MISMATCH'])
    for (const bad of [
      { ...update(), allowedEffects: ['push'] },
      update({ changes: ['everything' as never] }),
      update({ changes: ['source', 'source'] }),
      update({ instruction: '' }),
      update({ instruction: 'x'.repeat(4097) }),
      update({ kind: 'interaction-response' }),
      update({ interactionId: 'interaction-7' }),
    ]) {
      expect(codes(decideCoordinationAlignment(running, bad as CoordinationAlignmentUpdate))).toEqual(['COORD_ALIGNMENT_UPDATE_INVALID'])
    }
  })

  it('refuses a steer target bound to another binding, attempt or provider, and calls nothing', async () => {
    const decision = decided(decideCoordinationAlignment(await plan(), update()))
    for (const wrong of [
      { providerSessionBindingId: 'provider-session-binding-9' },
      { attemptId: 'attempt-other' },
      { provider: 'codex' as const },
    ]) {
      const steer = vi.fn(async () => ({ kind: 'steer' as const, accepted: true as const }))
      const result = await deliverCoordinationAlignment(decision, update(), steerTarget(steer, wrong).target)
      expect(codes(result)).toEqual(['COORD_ALIGNMENT_TARGET_MISMATCH'])
      expect(steer).not.toHaveBeenCalled()
    }
  })

  it('refuses a forged decision and a substituted update', async () => {
    const decision = decided(decideCoordinationAlignment(await plan(), update()))
    const steer = vi.fn(async () => ({ kind: 'steer' as const, accepted: true as const }))
    const { target } = steerTarget(steer)
    const forged = { ...decision } as CoordinationAlignmentDecision
    expect(codes(await deliverCoordinationAlignment(forged, update(), target))).toEqual(['COORD_ALIGNMENT_DECISION_NOT_ISSUED'])
    expect(codes(await deliverCoordinationAlignment(decision, update({ instruction: 'widen scope' }), target))).toEqual(['COORD_ALIGNMENT_UPDATE_MISMATCH'])
    expect(steer).not.toHaveBeenCalled()
  })

  it('returns deep-frozen results that never carry the instruction', async () => {
    const running = await plan()
    const decisionResult = decideCoordinationAlignment(running, update())
    const decision = decided(decisionResult)
    const delivery = await deliverCoordinationAlignment(decision, update(), steerTarget(async () => ({ kind: 'steer', accepted: true })).target)
    for (const value of [decisionResult, delivery]) {
      expect(isDeepFrozen(value)).toBe(true)
      expect(JSON.stringify(value)).not.toContain(INSTRUCTION)
    }
  })
})
