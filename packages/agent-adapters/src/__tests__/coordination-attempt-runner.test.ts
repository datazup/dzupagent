/**
 * MVP-04-CP01 acceptance: a composer-issued coordination plan runs through the
 * shipped runAgentExecution seam on exactly its bound provider, at the host's
 * working directory, and comes back bound to its attempt.
 *
 * Admission: workspace-docs doc-coord-mvp04-admit-20260924-r1/MVP04-ADMISSION.md §6.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type {
  CoordinationAttemptExecutionPlan,
  DecodedCoordinationExecutionAssignment,
} from '@dzupagent/adapter-types'
import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_EFFECTS,
  type ProviderSessionAttemptBinding,
} from '@dzupagent/runtime-contracts/provider-session'
import { describe, expect, it, vi } from 'vitest'

import {
  COORDINATION_ATTEMPT_CORRELATION_SCHEMA,
  composeCoordinationAttemptExecution,
  coordinationCanonicalDigest,
  coordinationSelfDigest,
  decodeCoordinationExecutionAssignment,
  renderCoordinationAgentExecutionRequest,
  runCoordinationAttemptExecution,
  type CoordinationArtifactResolver,
  type CoordinationAttemptRunOptions,
} from '../integration/index.js'
import type { ProviderModelCatalog } from '../model-discovery-types.js'
import type {
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'

// ---------------------------------------------------------------------------
// Pinned producer bytes (DZO v2) and a plan composed from them
// ---------------------------------------------------------------------------

const FIXTURE_DIR = new URL('./fixtures/coordination-critical-path/v2/', import.meta.url)
const ASSIGNMENT_BYTES = readFileSync(new URL('execution-assignment.json', FIXTURE_DIR))

const NOW = '2026-08-30T10:30:00Z'
const SECRET = 'sk-ant-SECRET-VALUE-mvp04cp01-do-not-leak'
const TASK_CONTENT = '{"task":"task-scripts-adapter","goal":"implement the adapter"}'
const MODEL = 'model-sentinel-mvp04cp01'
const PROFILE_REF = 'profile-sentinel-mvp04cp01'
const AUTH_SOURCE_REF = 'auth-source-sentinel-mvp04cp01'
const TARIFF_REF = 'tariff-sentinel-mvp04cp01'
const SESSION_REF = 'session-ref-sentinel-mvp04cp01'
const BINDING_ID = 'execution-binding-mvp04cp01'
const PINNED_CHECKOUT = '/storage/worktrees/pinned-checkout-mvp04cp01'

type Json = Record<string, any>

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/** The fixture with a resolvable task digest, resealed with the producer rule. */
function resolvableAssignment(): Json {
  const assignment = JSON.parse(ASSIGNMENT_BYTES.toString('utf8')) as Json
  const item = assignment.contextPack.items[0]
  item.artifact.digest = sha256(TASK_CONTENT)
  item.contentDigest = sha256(TASK_CONTENT)
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

function decoded(): DecodedCoordinationExecutionAssignment {
  const assignment = resolvableAssignment()
  const result = decodeCoordinationExecutionAssignment(JSON.stringify(assignment), {
    expectedSeal: coordinationCanonicalDigest(assignment),
  })
  if (!result.ok) throw new Error(`fixture did not decode: ${JSON.stringify(result.diagnostics)}`)
  return result.value
}

function providerSession(): ProviderSessionAttemptBinding {
  return {
    schema: PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
    bindingId: 'provider-session-binding-1',
    executionAttemptId: 'attempt-scripts-critical',
    authSourceRef: AUTH_SOURCE_REF,
    descriptor: {
      schema: PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
      descriptorId: 'descriptor-sentinel-mvp04cp01',
      providerId: 'claude',
      backend: { id: 'claude-agent-sdk', kind: 'sdk' },
      capabilities: Object.fromEntries(
        PROVIDER_SESSION_CAPABILITIES.map((capability) => [capability, { status: 'native', emulation: 'forbidden' }]),
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

function catalog(): ProviderModelCatalog {
  return {
    schemaVersion: 'dzupagent/provider-model-catalog/v1',
    providerId: 'claude',
    source: 'anthropic-models-api',
    completeness: 'account-catalog',
    discoveredAt: '2026-08-30T09:00:00.000Z',
    authenticated: true,
    models: [{ providerId: 'claude', id: MODEL, displayName: 'Sentinel model', supportedReasoningEfforts: ['low', 'medium', 'high'] }],
    warnings: [],
    fingerprint: 'catalog-fingerprint-1',
    backendId: 'claude-agent-sdk',
  }
}

const resolveTask: CoordinationArtifactResolver = ({ digest }) =>
  digest === sha256(TASK_CONTENT) ? { content: TASK_CONTENT } : undefined

async function compose(): Promise<CoordinationAttemptExecutionPlan> {
  const result = await composeCoordinationAttemptExecution({
    decoded: decoded(),
    binding: {
      schema: 'dzupagent.coordinationExecutionBinding/v2',
      bindingId: BINDING_ID,
      providerId: 'claude',
      backend: 'sdk',
      agentHost: null,
      model: MODEL,
      profileRef: PROFILE_REF,
      auth: { mode: 'api_key', sourceRef: AUTH_SOURCE_REF },
      capabilitySet: { providerSession: providerSession(), requiredCapabilities: ['execute', 'stream'], effects: [] },
      tariffRef: TARIFF_REF,
      sessionRef: SESSION_REF,
      reasoning: 'high',
    },
    now: NOW,
    modelCatalog: catalog(),
    resolveArtifact: resolveTask,
  })
  if (!result.ok) throw new Error(`composition refused: ${JSON.stringify(result.refusals)}`)
  return result.plan
}

// ---------------------------------------------------------------------------
// A recording adapter behind the real runAgentExecution seam
// ---------------------------------------------------------------------------

const capabilities: AdapterCapabilityProfile = {
  supportsResume: true,
  supportsFork: false,
  supportsToolCalls: true,
  emitsToolCalls: true,
  executesToolLoop: true,
  supportsStreaming: true,
  supportsCostUsage: true,
}

type CompletedUsage = NonNullable<Extract<AgentEvent, { type: 'adapter:completed' }>['usage']>

interface Recording {
  inputs: AgentInput[]
  materializations: Array<Record<string, unknown>>
}

function recordingAdapter(
  providerId: AdapterProviderId,
  recording: Recording,
  behaviour: { usage?: CompletedUsage; reportAs?: AdapterProviderId } = {},
): AgentCLIAdapter {
  const reporter = behaviour.reportAs ?? providerId
  return {
    providerId,
    async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      recording.inputs.push(input)
      yield { type: 'adapter:started', providerId: reporter, sessionId: 'provider-native-session-1', timestamp: 100 }
      yield {
        type: 'adapter:completed',
        providerId: reporter,
        sessionId: 'provider-native-session-1',
        result: 'done',
        ...(behaviour.usage ? { usage: behaviour.usage } : {}),
        durationMs: 12,
        timestamp: 112,
      }
    },
    async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {
      throw new Error('resume is not part of this attempt')
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
    getCapabilities() {
      return capabilities
    },
  }
}

function hostOptions(
  recording: Recording,
  behaviour: { usage?: CompletedUsage; reportAs?: AdapterProviderId } = {},
): CoordinationAttemptRunOptions {
  return {
    materializeAdapter: (materialization) => {
      const { config: _config, ...facts } = materialization
      recording.materializations.push(facts)
      return recordingAdapter(materialization.providerId, recording, behaviour)
    },
    resolveApiKey: () => SECRET,
  }
}

function newRecording(): Recording {
  return { inputs: [], materializations: [] }
}

// ---------------------------------------------------------------------------
// A2. The shipped seam runs exactly the sealed binding
// ---------------------------------------------------------------------------

describe('A2. production seam reached', () => {
  it('materializes exactly the bound provider, backend, auth and profile and runs the rendered request', async () => {
    const plan = await compose()
    const rendered = renderCoordinationAgentExecutionRequest(plan)
    if (!rendered.ok) throw new Error('render refused')
    const recording = newRecording()

    const outcome = await runCoordinationAttemptExecution(plan, { workingDirectory: PINNED_CHECKOUT }, hostOptions(recording))

    expect(outcome.ok).toBe(true)
    expect(recording.materializations).toEqual([
      { providerId: 'claude', backend: 'sdk', authMode: 'api_key', profileRef: PROFILE_REF, secretRef: AUTH_SOURCE_REF },
    ])
    expect(recording.inputs).toHaveLength(1)
    const input = recording.inputs[0]!
    expect(input.prompt).toBe(rendered.request.prompt)
    expect(input.workingDirectory).toBe(PINNED_CHECKOUT)
    expect(input.correlationId).toBe(rendered.request.correlationId)
    if (!outcome.ok) return
    expect(outcome.result.attemptedProviders).toEqual(['claude'])
    expect(outcome.result.model).toBe(MODEL)
  })

  it('never lets the host reach a fallback provider', async () => {
    const recording = newRecording()
    await runCoordinationAttemptExecution(await compose(), { workingDirectory: PINNED_CHECKOUT }, hostOptions(recording))
    expect(recording.materializations.map(({ providerId }) => providerId)).toEqual(['claude'])
  })
})

// ---------------------------------------------------------------------------
// A3. Refusal is total and early
// ---------------------------------------------------------------------------

describe('A3. refusal before materialization', () => {
  it('refuses a look-alike plan the composer did not issue', async () => {
    const recording = newRecording()
    const lookAlike = Object.freeze(structuredClone(await compose()))
    const outcome = await runCoordinationAttemptExecution(lookAlike, { workingDirectory: PINNED_CHECKOUT }, hostOptions(recording))
    expect(outcome).toMatchObject({ ok: false, code: 'COORD_PLAN_NOT_COMPOSED' })
    expect(recording.materializations).toEqual([])
  })

  it('refuses a non-plan value', async () => {
    const recording = newRecording()
    const outcome = await runCoordinationAttemptExecution(null as never, { workingDirectory: PINNED_CHECKOUT }, hostOptions(recording))
    expect(outcome).toMatchObject({ ok: false, code: 'COORD_PLAN_INVALID' })
    expect(recording.materializations).toEqual([])
  })

  it.each([
    ['missing', {}],
    ['empty', { workingDirectory: '' }],
    ['non-string', { workingDirectory: 42 }],
  ])('refuses a %s working directory instead of using the process directory', async (_label, host) => {
    const recording = newRecording()
    const outcome = await runCoordinationAttemptExecution(await compose(), host as never, hostOptions(recording))
    expect(outcome).toMatchObject({ ok: false, code: 'COORD_ATTEMPT_WORKSPACE_REQUIRED' })
    expect(recording.materializations).toEqual([])
    expect(recording.inputs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A4. Correlation comes from the plan, not the provider
// ---------------------------------------------------------------------------

describe('A4. correlation', () => {
  it('binds the result to the plan, attestation, attempt, binding and session', async () => {
    const plan = await compose()
    const rendered = renderCoordinationAgentExecutionRequest(plan)
    if (!rendered.ok) throw new Error('render refused')

    const outcome = await runCoordinationAttemptExecution(plan, { workingDirectory: PINNED_CHECKOUT }, hostOptions(newRecording()))

    if (!outcome.ok) throw new Error(`run refused: ${outcome.code}`)
    expect(outcome.correlation).toEqual({
      schema: COORDINATION_ATTEMPT_CORRELATION_SCHEMA,
      planDigest: plan.planDigest,
      requestDigest: rendered.attestation.requestDigest,
      assignmentDigest: plan.assignment.assignmentDigest,
      canonicalSeal: plan.assignment.canonicalSeal,
      assignmentId: plan.assignment.assignmentId,
      attemptId: plan.assignment.attemptId,
      sessionId: plan.session.sessionId,
      bindingId: BINDING_ID,
      sessionRef: SESSION_REF,
      providerId: 'claude',
      backend: 'sdk',
      agentHost: null,
      tariffRef: TARIFF_REF,
    })
    expect(outcome.attestation).toEqual(rendered.attestation)
    expect(Object.isFrozen(outcome.correlation)).toBe(true)
  })

  it('does not take its identity from the provider-native session id', async () => {
    const outcome = await runCoordinationAttemptExecution(await compose(), { workingDirectory: PINNED_CHECKOUT }, hostOptions(newRecording()))
    if (!outcome.ok) throw new Error('run refused')
    expect(JSON.stringify(outcome.correlation)).not.toContain('provider-native-session-1')
  })

  it('keeps the secret out of the result', async () => {
    const outcome = await runCoordinationAttemptExecution(await compose(), { workingDirectory: PINNED_CHECKOUT }, hostOptions(newRecording()))
    expect(JSON.stringify(outcome)).not.toContain(SECRET)
  })
})

// ---------------------------------------------------------------------------
// A5. Provider replacement is refused
// ---------------------------------------------------------------------------

describe('A5. provider replacement', () => {
  it('refuses a run whose events come from another provider', async () => {
    const recording = newRecording()
    const outcome = await runCoordinationAttemptExecution(
      await compose(),
      { workingDirectory: PINNED_CHECKOUT },
      hostOptions(recording, { reportAs: 'codex' }),
    )
    expect(outcome).toMatchObject({ ok: false, code: 'COORD_ATTEMPT_PROVIDER_MISMATCH' })
    expect(outcome).toHaveProperty('correlation.providerId', 'claude')
  })

  it('surfaces the seam refusal when the host materializes another provider, and nothing runs', async () => {
    const recording = newRecording()
    const options = hostOptions(recording)
    const outcome = await runCoordinationAttemptExecution(await compose(), { workingDirectory: PINNED_CHECKOUT }, {
      ...options,
      materializeAdapter: (materialization) => {
        options.materializeAdapter!(materialization)
        return recordingAdapter('codex', recording)
      },
    })
    expect(outcome).toMatchObject({ ok: false, code: 'AGENT_EXECUTION_ADAPTER_PROVIDER_MISMATCH' })
    expect(outcome).toHaveProperty('correlation.providerId', 'claude')
    expect(recording.inputs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A6. Usage uncertainty is explicit
// ---------------------------------------------------------------------------

describe('A6. usage', () => {
  it('reports unknown usage as unknown, with no numeric field', async () => {
    const outcome = await runCoordinationAttemptExecution(await compose(), { workingDirectory: PINNED_CHECKOUT }, hostOptions(newRecording()))
    if (!('usage' in outcome)) throw new Error('run refused before execution')
    expect(outcome.usage).toEqual({ status: 'unknown' })
  })

  it('reports provider usage unchanged', async () => {
    const usage: CompletedUsage = { inputTokens: 11, outputTokens: 7 } as CompletedUsage
    const outcome = await runCoordinationAttemptExecution(
      await compose(),
      { workingDirectory: PINNED_CHECKOUT },
      hostOptions(newRecording(), { usage }),
    )
    if (!('usage' in outcome)) throw new Error('run refused before execution')
    expect(outcome.usage).toEqual({ status: 'reported', usage })
  })
})

describe('host plumbing', () => {
  it('forwards the host signal and timeout without touching binding facts', async () => {
    const recording = newRecording()
    const controller = new AbortController()
    const onEvent = vi.fn()
    await runCoordinationAttemptExecution(
      await compose(),
      { workingDirectory: PINNED_CHECKOUT, signal: controller.signal, timeoutMs: 5_000 },
      { ...hostOptions(recording), onEvent },
    )
    expect(onEvent).toHaveBeenCalled()
    expect(recording.materializations[0]).toMatchObject({ providerId: 'claude', backend: 'sdk', profileRef: PROFILE_REF })
  })
})
