import type {
  ProgressiveCompressConfig,
  TokenCounter,
  TokenMeasurementMethod,
  TokenMeasurementResult,
} from '@dzupagent/context'
import {
  validateProtectedTranscriptPolicy,
  type ProtectedTranscriptPolicy,
} from './hard-budget-protection.js'

export const HARD_BUDGET_HOST_PROFILE_SCHEMA_VERSION = '1' as const

export type ProvenTokenMeasurementMethod = Exclude<
  TokenMeasurementMethod,
  'heuristic'
>

/** Stable identity for a versioned provider-host budgeting contract. */
export interface HardBudgetHostProfileIdentity {
  schemaVersion: typeof HARD_BUDGET_HOST_PROFILE_SCHEMA_VERSION
  id: string
  revision: string
  provider: string
}

/** Tokenizer identity and measurement modes admitted by the host profile. */
export interface HardBudgetTokenizerProvenance {
  id: string
  revision: string
  model: string
  allowedMethods: readonly ProvenTokenMeasurementMethod[]
  /** When set, every non-empty measurement must report this encoding. */
  encoding?: string
}

/** Explicit model-input reservations used by agent and team handoff gates. */
export interface HardBudgetReservationConfig {
  /** Full model context window, including input and reserved output. */
  contextWindowTokens: number
  /** Tokens unavailable to input because they are reserved for model output. */
  reservedOutputTokens: number
  /** Content tokens reserved for a rolling summary produced by compression. */
  reservedSummaryTokens: number
  /** Tokens reserved for provider tool definitions, schemas, and call framing. */
  reservedToolTokens?: number
  /** Fixed provider/chat serialization overhead. */
  fixedEnvelopeTokens: number
  /** Per-message provider/chat serialization overhead. */
  perMessageEnvelopeTokens: number
  /** Provenance-aware counter. Count-only and heuristic counters fail closed. */
  tokenCounter: TokenCounter
  /** Optional model identifier forwarded to the counter. */
  model?: string
  /** Present on versioned host profiles and emitted as bounded telemetry. */
  hostProfile?: HardBudgetHostProfileIdentity
  /** Required with hostProfile; binds measurements to tokenizer identity. */
  tokenizerProvenance?: HardBudgetTokenizerProvenance
  /** Optional stronger semantics for role- and tool-aware transcripts. */
  protectedTranscript?: ProtectedTranscriptPolicy
}

/** Agent-specific hard-budget policy, including compression knobs. */
export interface AgentHardBudgetConfig extends HardBudgetReservationConfig {
  compression?: Omit<
    ProgressiveCompressConfig,
    'tokenCounter' | 'model' | 'allowModelSummarization'
  >
}

/** A complete, authoritative host policy accepted by defineHostProfile(). */
export interface HardBudgetHostProfile extends AgentHardBudgetConfig {
  model: string
  reservedToolTokens: number
  hostProfile: HardBudgetHostProfileIdentity
  tokenizerProvenance: HardBudgetTokenizerProvenance
  protectedTranscript: ProtectedTranscriptPolicy
}

/** Sanitized profile identity copied into results and lifecycle telemetry. */
export interface HardBudgetHostProfileProof {
  schemaVersion: typeof HARD_BUDGET_HOST_PROFILE_SCHEMA_VERSION
  id: string
  revision: string
  provider: string
  model: string
  tokenizerId: string
  tokenizerRevision: string
  tokenizerEncoding?: string
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
}

/** Validate reservations and any stronger host-profile contract. */
export function validateHardBudgetReservation(
  config: HardBudgetReservationConfig,
): void {
  assertNonNegativeInteger('contextWindowTokens', config.contextWindowTokens)
  assertNonNegativeInteger('reservedOutputTokens', config.reservedOutputTokens)
  assertNonNegativeInteger('reservedSummaryTokens', config.reservedSummaryTokens)
  assertNonNegativeInteger(
    'reservedToolTokens',
    config.reservedToolTokens ?? 0,
  )
  assertNonNegativeInteger('fixedEnvelopeTokens', config.fixedEnvelopeTokens)
  assertNonNegativeInteger(
    'perMessageEnvelopeTokens',
    config.perMessageEnvelopeTokens,
  )
  if (config.protectedTranscript) {
    validateProtectedTranscriptPolicy(config.protectedTranscript)
  }

  const hasProfileFields = Boolean(
    config.hostProfile || config.tokenizerProvenance,
  )
  if (!hasProfileFields) return
  if (!config.hostProfile || !config.tokenizerProvenance) {
    throw new TypeError(
      'hostProfile and tokenizerProvenance must be configured together',
    )
  }
  if (!config.protectedTranscript) {
    throw new TypeError('versioned host profiles require protectedTranscript')
  }
  if (!config.model) {
    throw new TypeError('versioned host profiles require an explicit model')
  }
  if (config.reservedToolTokens === undefined) {
    throw new TypeError(
      'versioned host profiles require an explicit reservedToolTokens value',
    )
  }

  const { hostProfile, tokenizerProvenance } = config
  if (
    hostProfile.schemaVersion !== HARD_BUDGET_HOST_PROFILE_SCHEMA_VERSION
  ) {
    throw new TypeError(
      `unsupported hard-budget host profile schema ${hostProfile.schemaVersion}`,
    )
  }
  assertNonEmpty('hostProfile.id', hostProfile.id)
  assertNonEmpty('hostProfile.revision', hostProfile.revision)
  assertNonEmpty('hostProfile.provider', hostProfile.provider)
  assertNonEmpty('tokenizerProvenance.id', tokenizerProvenance.id)
  assertNonEmpty('tokenizerProvenance.revision', tokenizerProvenance.revision)
  assertNonEmpty('tokenizerProvenance.model', tokenizerProvenance.model)
  if (tokenizerProvenance.model !== config.model) {
    throw new TypeError(
      'tokenizerProvenance.model must equal the host profile model',
    )
  }
  if (tokenizerProvenance.allowedMethods.length === 0) {
    throw new TypeError('tokenizerProvenance.allowedMethods must not be empty')
  }
  for (const method of tokenizerProvenance.allowedMethods) {
    if (method !== 'exact' && method !== 'encoding-fallback') {
      throw new TypeError(`unsupported host-profile measurement method ${method}`)
    }
  }
  if (tokenizerProvenance.encoding !== undefined) {
    assertNonEmpty('tokenizerProvenance.encoding', tokenizerProvenance.encoding)
  }
  if (!config.protectedTranscript.preserveSystemMessages) {
    throw new TypeError('versioned host profiles must preserve system messages')
  }
  if (config.protectedTranscript.preserveLatestUserMessages < 1) {
    throw new TypeError(
      'versioned host profiles must preserve the latest user message',
    )
  }
  if (config.protectedTranscript.preserveRecentToolCallGroups < 1) {
    throw new TypeError(
      'versioned host profiles must preserve a recent tool-call group',
    )
  }
}

/** Validate, copy, and freeze a reusable versioned host profile. */
export function defineHardBudgetHostProfile(
  profile: HardBudgetHostProfile,
): Readonly<HardBudgetHostProfile> {
  validateHardBudgetReservation(profile)
  return Object.freeze({
    ...profile,
    ...(profile.compression
      ? { compression: Object.freeze({ ...profile.compression }) }
      : {}),
    hostProfile: Object.freeze({ ...profile.hostProfile }),
    tokenizerProvenance: Object.freeze({
      ...profile.tokenizerProvenance,
      allowedMethods: Object.freeze([
        ...profile.tokenizerProvenance.allowedMethods,
      ]),
    }),
    protectedTranscript: Object.freeze({ ...profile.protectedTranscript }),
  })
}

/** Explain why a measurement does not satisfy the configured provenance. */
export function hardBudgetMeasurementFailure(
  config: HardBudgetReservationConfig,
  measurement: TokenMeasurementResult,
): string | undefined {
  if (
    measurement.method !== 'exact'
    && measurement.method !== 'encoding-fallback'
  ) {
    return measurement.reason ?? 'token measurement is heuristic'
  }
  if (!config.hostProfile) return undefined
  const provenance = config.tokenizerProvenance
  if (!provenance) return 'host profile tokenizer provenance is missing'
  if (!provenance.allowedMethods.includes(measurement.method)) {
    return `measurement method ${measurement.method} is not admitted by host profile`
  }
  if (measurement.model !== provenance.model) {
    return 'measurement model does not match host profile tokenizer provenance'
  }
  if (
    provenance.encoding
    && measurement.tokens > 0
    && measurement.encoding !== provenance.encoding
  ) {
    return 'measurement encoding does not match host profile tokenizer provenance'
  }
  return undefined
}

export function hardBudgetHostProfileProof(
  config: HardBudgetReservationConfig,
): HardBudgetHostProfileProof | undefined {
  if (!config.hostProfile || !config.tokenizerProvenance || !config.model) {
    return undefined
  }
  return {
    schemaVersion: config.hostProfile.schemaVersion,
    id: config.hostProfile.id,
    revision: config.hostProfile.revision,
    provider: config.hostProfile.provider,
    model: config.model,
    tokenizerId: config.tokenizerProvenance.id,
    tokenizerRevision: config.tokenizerProvenance.revision,
    ...(config.tokenizerProvenance.encoding
      ? { tokenizerEncoding: config.tokenizerProvenance.encoding }
      : {}),
  }
}
