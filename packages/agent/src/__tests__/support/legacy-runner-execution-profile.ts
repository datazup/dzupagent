import { createHash } from 'node:crypto'

import type { AgentRunJsonObject, AgentRunJsonValue } from '@dzupagent/agent-types/run'

export const LEGACY_RUNNER_EXECUTION_PROFILE_SCHEMA =
  'dzupagent.legacyRunnerExecutionProfile/v1' as const
export const RUNNER_PROVIDER_FREE_PROFILE_ID = 'runner-provider-free/v1' as const

export type LegacyExecutionObligation =
  | 'ordered-items'
  | 'read-only-tools'
  | 'exact-usage-when-measured'
  | 'structured-output-when-requested'
  | 'safe-point-cancellation'
  | 'bounded-model-turns'
  | 'bounded-read-retry'
  | 'durable-session-commit'
  | 'memory-read'
  | 'memory-write-back'
  | 'summary-compression'
  | 'middleware'
  | 'model-hooks'
  | 'dynamic-instructions'
  | 'per-call-model-options'
  | 'prompt-input-scanning'
  | 'tool-result-policy-projection'
  | 'custom-guardrails'
  | 'rate-and-distributed-budget'
  | 'provider-failover'
  | 'output-filtering'
  | 'telemetry-reflection-learning'
  | 'legacy-result-projection'
  | 'legacy-stream-events'
  | 'legacy-run-handle-control'
  | 'agent-as-tool-recursion'
  | 'mailbox-tools'
  | 'mutating-tools'

export type LegacyExecutionDisposition = 'required' | 'supported' | 'disabled' | 'unsupported'
export type LegacyExecutionClaimOwner = 'runner' | 'adapter' | 'host'

export type LegacyExecutionEvidenceCode =
  | 'r5i-ordered-items'
  | 'r5i-read-tools'
  | 'r5i-measured-usage'
  | 'r5j-structured-output'
  | 'runner-safe-point-control'
  | 'runner-model-turn-limit'
  | 'runner-read-retry-limit'
  | 'runner-session-transaction'
  | 'host-explicit-disablement'
  | 'host-bounded-input'
  | 'r5m-no-tool-generate-result'
  | 'runner-direct-only'

export interface LegacyExecutionCapabilityClaim {
  readonly obligation: LegacyExecutionObligation
  readonly disposition: LegacyExecutionDisposition
  readonly owner: LegacyExecutionClaimOwner
  readonly evidence: readonly LegacyExecutionEvidenceCode[]
  readonly binding: AgentRunJsonObject
}

export interface LegacyRunnerExecutionProfile {
  readonly schema: typeof LEGACY_RUNNER_EXECUTION_PROFILE_SCHEMA
  readonly profileId: typeof RUNNER_PROVIDER_FREE_PROFILE_ID
  readonly behaviorDigest: string
  readonly claims: readonly LegacyExecutionCapabilityClaim[]
  readonly profileDigest: string
}

export interface RunnerProviderFreeProfileInput {
  readonly behaviorDigest: string
  readonly maxModelTurns: number
  readonly maxToolAttempts: number
  readonly observedMessageCount: number
  readonly observedMessageTokens: number
  readonly structuredOutputRequested: boolean
  readonly legacyResultProjection?: 'runner-direct-only' | 'no-tool-generate-result/v1'
}

export type LegacyExecutionIneligibilityCode =
  | 'profile-not-json-safe'
  | 'profile-forbidden-field'
  | 'profile-schema-mismatch'
  | 'profile-id-mismatch'
  | 'behavior-digest-mismatch'
  | 'profile-digest-mismatch'
  | 'claim-missing'
  | 'claim-duplicate'
  | 'claim-unknown'
  | 'claim-malformed'
  | 'claim-owner-mismatch'
  | 'claim-disposition-mismatch'
  | 'claim-evidence-mismatch'
  | 'claim-binding-mismatch'

export interface LegacyExecutionIneligibilityReason {
  readonly code: LegacyExecutionIneligibilityCode
  readonly obligation?: string
}

export type LegacyRunnerExecutionEligibility =
  | {
      readonly status: 'eligible'
      readonly profileId: typeof RUNNER_PROVIDER_FREE_PROFILE_ID
      readonly profileDigest: string
    }
  | {
      readonly status: 'ineligible'
      readonly reasons: readonly LegacyExecutionIneligibilityReason[]
    }

interface ClaimExpectation {
  readonly owner: LegacyExecutionClaimOwner
  readonly disposition: Extract<LegacyExecutionDisposition, 'supported' | 'disabled'>
  readonly evidence: readonly LegacyExecutionEvidenceCode[]
  readonly binding: AgentRunJsonObject
}

const supported = (
  owner: LegacyExecutionClaimOwner,
  evidence: LegacyExecutionEvidenceCode,
  binding: AgentRunJsonObject,
): ClaimExpectation => ({ owner, disposition: 'supported', evidence: [evidence], binding })

const disabled = (binding: AgentRunJsonObject): ClaimExpectation => ({
  owner: 'host',
  disposition: 'disabled',
  evidence: ['host-explicit-disablement'],
  binding,
})

function expectations(input: RunnerProviderFreeProfileInput): Readonly<Record<LegacyExecutionObligation, ClaimExpectation>> {
  const off = { configured: false } as const
  return {
    'ordered-items': supported('runner', 'r5i-ordered-items', { ordered: true }),
    'read-only-tools': supported('runner', 'r5i-read-tools', { effectClass: 'read' }),
    'exact-usage-when-measured': supported('adapter', 'r5i-measured-usage', {
      missingMeasurement: 'unsupported',
    }),
    'structured-output-when-requested': supported('adapter', 'r5j-structured-output', {
      requested: input.structuredOutputRequested,
    }),
    'safe-point-cancellation': supported('runner', 'runner-safe-point-control', {
      providerAbortClaimed: false,
    }),
    'bounded-model-turns': supported('runner', 'runner-model-turn-limit', {
      maxModelTurns: input.maxModelTurns,
    }),
    'bounded-read-retry': supported('runner', 'runner-read-retry-limit', {
      maxToolAttempts: input.maxToolAttempts,
      retryableOutcome: 'failed-before-effect',
    }),
    'durable-session-commit': supported('runner', 'runner-session-transaction', {
      commit: 'once-before-success',
    }),
    'memory-read': disabled({ memory: false, memoryClient: false, arrowMemory: false }),
    'memory-write-back': disabled({ memoryWriteBack: false }),
    'summary-compression': {
      owner: 'host',
      disposition: 'disabled',
      evidence: ['host-bounded-input'],
      binding: {
        observedMessageCount: input.observedMessageCount,
        observedMessageTokens: input.observedMessageTokens,
        maxMessagesExclusive: 30,
        maxMessageTokensExclusive: 12_000,
      },
    },
    middleware: disabled({ middlewareCount: 0 }),
    'model-hooks': disabled(off),
    'dynamic-instructions': disabled({ instructionsMode: 'static' }),
    'per-call-model-options': disabled({ context: false, temperature: false, maxTokens: false, stop: false }),
    'prompt-input-scanning': disabled({ promptInjection: 'off' }),
    'tool-result-policy-projection': disabled({
      wrapToolResults: false,
      scanner: false,
      governance: false,
      permissionPolicy: false,
      argumentValidator: false,
    }),
    'custom-guardrails': disabled({
      blockedTools: false,
      outputFilter: false,
      stuckDetector: false,
      tokenOrCostLimit: false,
    }),
    'rate-and-distributed-budget': disabled({ rateLimiter: false, distributed: false }),
    'provider-failover': disabled({ enabled: false }),
    'output-filtering': disabled({ legacy: false, chainLength: 0 }),
    'telemetry-reflection-learning': disabled({
      eventBus: false,
      auditStore: false,
      callbacks: false,
      selfLearning: false,
      tokenLifecyclePlugin: false,
    }),
    'legacy-result-projection': input.legacyResultProjection === 'no-tool-generate-result/v1'
      ? supported('host', 'r5m-no-tool-generate-result', {
          entrypoint: 'not-delegated',
          projection: 'no-tool-generate-result/v1',
        })
      : {
          owner: 'host',
          disposition: 'disabled',
          evidence: ['runner-direct-only'],
          binding: { entrypoint: 'runner-direct-only' },
        },
    'legacy-stream-events': disabled(off),
    'legacy-run-handle-control': disabled(off),
    'agent-as-tool-recursion': disabled(off),
    'mailbox-tools': disabled(off),
    'mutating-tools': disabled({ allowedEffectClass: 'read' }),
  }
}

function canonical(value: AgentRunJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}

function digestProfileBody(profile: Omit<LegacyRunnerExecutionProfile, 'profileDigest'>): string {
  return createHash('sha256').update(canonical(profile as unknown as AgentRunJsonValue)).digest('hex')
}

function isJsonSafe(value: unknown, seen = new Set<object>()): value is AgentRunJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
  const values = Array.isArray(value) ? value : Object.values(value)
  const safe = values.every((item) => isJsonSafe(item, seen))
  seen.delete(value)
  return safe
}

function hasForbiddenField(value: AgentRunJsonValue): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasForbiddenField)
  return Object.entries(value).some(([key, item]) =>
    /^(authorization|cookie|credential|password|providerClient|rawPayload|secret|hostPath|absolutePath|path)$/i.test(key)
    || hasForbiddenField(item),
  )
}

function isClaim(value: unknown): value is LegacyExecutionCapabilityClaim {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false
  const claim = value as Record<string, AgentRunJsonValue>
  return typeof claim.obligation === 'string'
    && typeof claim.disposition === 'string'
    && typeof claim.owner === 'string'
    && Array.isArray(claim.evidence)
    && claim.evidence.every((item) => typeof item === 'string')
    && claim.binding !== null
    && typeof claim.binding === 'object'
    && !Array.isArray(claim.binding)
}

function same(left: AgentRunJsonValue, right: AgentRunJsonValue): boolean {
  return canonical(left) === canonical(right)
}

function validInput(input: RunnerProviderFreeProfileInput): boolean {
  return input.behaviorDigest.length > 0
    && Number.isSafeInteger(input.maxModelTurns) && input.maxModelTurns > 0
    && Number.isSafeInteger(input.maxToolAttempts) && input.maxToolAttempts > 0
    && Number.isSafeInteger(input.observedMessageCount) && input.observedMessageCount >= 0
    && Number.isSafeInteger(input.observedMessageTokens) && input.observedMessageTokens >= 0
    && input.observedMessageCount < 30
    && input.observedMessageTokens < 12_000
    && (input.legacyResultProjection === undefined
      || input.legacyResultProjection === 'runner-direct-only'
      || input.legacyResultProjection === 'no-tool-generate-result/v1')
}

export function buildRunnerProviderFreeExecutionProfile(
  input: RunnerProviderFreeProfileInput,
): LegacyRunnerExecutionProfile {
  if (!validInput(input)) throw new TypeError('Runner provider-free profile input is invalid')
  const expected = expectations(input)
  const claims = Object.entries(expected).map(([obligation, claim]) => ({
    obligation: obligation as LegacyExecutionObligation,
    ...claim,
  }))
  const body = {
    schema: LEGACY_RUNNER_EXECUTION_PROFILE_SCHEMA,
    profileId: RUNNER_PROVIDER_FREE_PROFILE_ID,
    behaviorDigest: input.behaviorDigest,
    claims,
  } as const
  return { ...body, profileDigest: digestProfileBody(body) }
}

function add(
  reasons: LegacyExecutionIneligibilityReason[],
  code: LegacyExecutionIneligibilityCode,
  obligation?: string,
): void {
  reasons.push(obligation === undefined ? { code } : { code, obligation })
}

export function evaluateRunnerProviderFreeExecutionProfile(
  candidate: unknown,
  expectedBehaviorDigest: string,
): LegacyRunnerExecutionEligibility {
  const reasons: LegacyExecutionIneligibilityReason[] = []
  if (!isJsonSafe(candidate)) return { status: 'ineligible', reasons: [{ code: 'profile-not-json-safe' }] }
  if (hasForbiddenField(candidate)) {
    return { status: 'ineligible', reasons: [{ code: 'profile-forbidden-field' }] }
  }
  const profile = candidate as unknown as LegacyRunnerExecutionProfile
  if (profile.schema !== LEGACY_RUNNER_EXECUTION_PROFILE_SCHEMA) add(reasons, 'profile-schema-mismatch')
  if (profile.profileId !== RUNNER_PROVIDER_FREE_PROFILE_ID) add(reasons, 'profile-id-mismatch')
  if (profile.behaviorDigest !== expectedBehaviorDigest) add(reasons, 'behavior-digest-mismatch')
  if (!Array.isArray(profile.claims) || typeof profile.profileDigest !== 'string') {
    return { status: 'ineligible', reasons: [...reasons, { code: 'profile-digest-mismatch' }] }
  }
  const { profileDigest: _profileDigest, ...body } = profile
  if (profile.profileDigest !== digestProfileBody(body)) add(reasons, 'profile-digest-mismatch')

  const claims = profile.claims.filter(isClaim)
  for (const claim of profile.claims) {
    if (!isClaim(claim)) add(reasons, 'claim-malformed')
  }

  const summary = claims.find((claim) => claim.obligation === 'summary-compression')
  const summaryBinding = summary?.binding as Record<string, AgentRunJsonValue> | undefined
  const resultProjection = claims.find(
    (claim) => claim.obligation === 'legacy-result-projection',
  )?.binding as Record<string, AgentRunJsonValue> | undefined
  const legacyResultProjection = resultProjection?.projection === 'no-tool-generate-result/v1'
    ? 'no-tool-generate-result/v1'
    : resultProjection?.entrypoint === 'runner-direct-only'
      ? 'runner-direct-only'
      : undefined
  const input: RunnerProviderFreeProfileInput = {
    behaviorDigest: profile.behaviorDigest,
    maxModelTurns: Number((claims.find((claim) => claim.obligation === 'bounded-model-turns')?.binding as Record<string, unknown> | undefined)?.maxModelTurns),
    maxToolAttempts: Number((claims.find((claim) => claim.obligation === 'bounded-read-retry')?.binding as Record<string, unknown> | undefined)?.maxToolAttempts),
    observedMessageCount: Number(summaryBinding?.observedMessageCount),
    observedMessageTokens: Number(summaryBinding?.observedMessageTokens),
    structuredOutputRequested: Boolean((claims.find((claim) => claim.obligation === 'structured-output-when-requested')?.binding as Record<string, unknown> | undefined)?.requested),
    ...(legacyResultProjection === undefined ? {} : { legacyResultProjection }),
  }
  const expected = validInput(input) ? expectations(input) : undefined
  const byObligation = new Map<string, LegacyExecutionCapabilityClaim[]>()
  for (const claim of claims) {
    const claims = byObligation.get(claim.obligation) ?? []
    claims.push(claim)
    byObligation.set(claim.obligation, claims)
  }
  for (const [obligation, claims] of byObligation) {
    if (!(obligation in (expected ?? expectations({
      behaviorDigest: 'invalid', maxModelTurns: 1, maxToolAttempts: 1,
      observedMessageCount: 0, observedMessageTokens: 0, structuredOutputRequested: false,
    })))) add(reasons, 'claim-unknown', obligation)
    if (claims.length > 1) add(reasons, 'claim-duplicate', obligation)
  }
  const expectedClaims = expected ?? expectations({
    behaviorDigest: 'invalid', maxModelTurns: 1, maxToolAttempts: 1,
    observedMessageCount: 0, observedMessageTokens: 0, structuredOutputRequested: false,
  })
  for (const [obligation, wanted] of Object.entries(expectedClaims)) {
    const actual = byObligation.get(obligation)?.[0]
    if (actual === undefined) {
      add(reasons, 'claim-missing', obligation)
      continue
    }
    if (actual.owner !== wanted.owner) add(reasons, 'claim-owner-mismatch', obligation)
    if (actual.disposition !== wanted.disposition) add(reasons, 'claim-disposition-mismatch', obligation)
    if (!same(actual.evidence, wanted.evidence)) add(reasons, 'claim-evidence-mismatch', obligation)
    if (!same(actual.binding, wanted.binding)) add(reasons, 'claim-binding-mismatch', obligation)
  }
  return reasons.length === 0
    ? { status: 'eligible', profileId: RUNNER_PROVIDER_FREE_PROFILE_ID, profileDigest: profile.profileDigest }
    : { status: 'ineligible', reasons }
}
