import { createHash } from 'node:crypto'
import type {
  HardBudgetHostProfile,
  HardBudgetTokenizerProvenance,
  ProvenTokenMeasurementMethod,
} from '@dzupagent/agent/agent'
import type {
  TokenCounter,
  TokenMeasurementResult,
} from '@dzupagent/context'
import type { AdapterProviderId } from '../types.js'

export const ADAPTER_HARD_BUDGET_PROFILE_SCHEMA_VERSION = '1' as const

export interface AdapterHardBudgetRequest {
  provider: AdapterProviderId
  model: string
  messages: readonly {
    role: 'system' | 'user'
    content: string
  }[]
  tools?: readonly unknown[]
  toolChoice?: unknown
}

export interface AdapterHardBudgetCounterBinding {
  tokenizerId: string
  tokenizerRevision: string
  requestFormatId: string
  requestFormatRevision: string
  contentCounter: TokenCounter
  countRequest: (
    request: AdapterHardBudgetRequest,
  ) => TokenMeasurementResult
}

export interface AdapterHardBudgetModelSnapshot {
  id: string
  revision: string
  capturedAt: string
  expiresAt: string
}

export interface AdapterHardBudgetRequestProofContract {
  id: string
  revision: string
  maxAgeMs: number
}

export interface AdapterHardBudgetRequestProofResult
  extends TokenMeasurementResult {
  method: 'exact'
  model: string
  requestFingerprint: string
  requestFormatFingerprint: string
  measuredAt: string
}

export interface AdapterHardBudgetRequestProofBinding {
  id: string
  revision: string
  requestFormatId: string
  requestFormatRevision: string
  requestFormatFingerprint: string
  proveRequest: (
    request: AdapterHardBudgetRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<AdapterHardBudgetRequestProofResult>
}

export interface AdapterHardBudgetHostProfileDefinition {
  schemaVersion: typeof ADAPTER_HARD_BUDGET_PROFILE_SCHEMA_VERSION
  id: string
  revision: string
  provider: AdapterProviderId
  model: string
  contextWindowTokens: number
  reservedOutputTokens: number
  reservedSummaryTokens: number
  tokenizer: Omit<HardBudgetTokenizerProvenance, 'model'>
  requestFormat: {
    id: string
    revision: string
    fingerprint?: string
  }
  modelSnapshot?: AdapterHardBudgetModelSnapshot
  requestProof?: AdapterHardBudgetRequestProofContract
}

export type AdapterHardBudgetProfileErrorCode =
  | 'profile_not_found'
  | 'duplicate_profile'
  | 'invalid_profile'
  | 'tokenizer_binding_mismatch'
  | 'request_format_binding_mismatch'
  | 'request_format_fingerprint_mismatch'
  | 'request_proof_binding_mismatch'
  | 'request_proof_required'
  | 'request_proof_failed'
  | 'request_proof_stale'
  | 'model_snapshot_stale'
  | 'measurement_unproven'
  | 'measurement_mismatch'
  | 'reservation_non_monotonic'
  | 'transcript_unsafe'
  | 'request_over_budget'

export class AdapterHardBudgetProfileError extends Error {
  constructor(
    readonly code: AdapterHardBudgetProfileErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AdapterHardBudgetProfileError'
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new AdapterHardBudgetProfileError(
      'invalid_profile',
      `${name} must be a non-empty string`,
    )
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new AdapterHardBudgetProfileError(
      'invalid_profile',
      `${name} must be a non-negative integer`,
    )
  }
}

function parseTimestamp(name: string, value: string): number {
  assertNonEmpty(name, value)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new AdapterHardBudgetProfileError(
      'invalid_profile',
      `${name} must be an ISO-8601 timestamp`,
    )
  }
  return parsed
}

function profileKey(provider: AdapterProviderId, model: string): string {
  return `${provider}:${model.trim().toLowerCase()}`
}

function validateAllowedMethods(
  methods: readonly ProvenTokenMeasurementMethod[],
): void {
  if (methods.length === 0) {
    throw new AdapterHardBudgetProfileError(
      'invalid_profile',
      'tokenizer.allowedMethods must not be empty',
    )
  }
  if (methods.some((method) =>
    method !== 'exact' && method !== 'encoding-fallback')) {
    throw new AdapterHardBudgetProfileError(
      'invalid_profile',
      'tokenizer.allowedMethods contains an unsupported method',
    )
  }
}

export function defineAdapterHardBudgetHostProfile(
  definition: AdapterHardBudgetHostProfileDefinition,
): Readonly<AdapterHardBudgetHostProfileDefinition> {
  if (definition.schemaVersion !== ADAPTER_HARD_BUDGET_PROFILE_SCHEMA_VERSION) {
    throw new AdapterHardBudgetProfileError(
      'invalid_profile',
      `unsupported adapter hard-budget profile schema ${definition.schemaVersion}`,
    )
  }
  assertNonEmpty('id', definition.id)
  assertNonEmpty('revision', definition.revision)
  assertNonEmpty('provider', definition.provider)
  assertNonEmpty('model', definition.model)
  assertNonEmpty('tokenizer.id', definition.tokenizer.id)
  assertNonEmpty('tokenizer.revision', definition.tokenizer.revision)
  assertNonEmpty('requestFormat.id', definition.requestFormat.id)
  assertNonEmpty('requestFormat.revision', definition.requestFormat.revision)
  if (definition.requestFormat.fingerprint !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(definition.requestFormat.fingerprint)) {
      throw new AdapterHardBudgetProfileError(
        'invalid_profile',
        'requestFormat.fingerprint must be a lowercase SHA-256 digest',
      )
    }
  }
  assertNonNegativeInteger(
    'contextWindowTokens',
    definition.contextWindowTokens,
  )
  assertNonNegativeInteger(
    'reservedOutputTokens',
    definition.reservedOutputTokens,
  )
  assertNonNegativeInteger(
    'reservedSummaryTokens',
    definition.reservedSummaryTokens,
  )
  if (definition.contextWindowTokens <= definition.reservedOutputTokens) {
    throw new AdapterHardBudgetProfileError(
      'invalid_profile',
      'contextWindowTokens must exceed reservedOutputTokens',
    )
  }
  validateAllowedMethods(definition.tokenizer.allowedMethods)
  if (definition.tokenizer.encoding !== undefined) {
    assertNonEmpty('tokenizer.encoding', definition.tokenizer.encoding)
  }
  if (definition.modelSnapshot !== undefined) {
    assertNonEmpty('modelSnapshot.id', definition.modelSnapshot.id)
    assertNonEmpty('modelSnapshot.revision', definition.modelSnapshot.revision)
    const capturedAt = parseTimestamp(
      'modelSnapshot.capturedAt',
      definition.modelSnapshot.capturedAt,
    )
    const expiresAt = parseTimestamp(
      'modelSnapshot.expiresAt',
      definition.modelSnapshot.expiresAt,
    )
    if (expiresAt <= capturedAt) {
      throw new AdapterHardBudgetProfileError(
        'invalid_profile',
        'modelSnapshot.expiresAt must be later than capturedAt',
      )
    }
  }
  if (definition.requestProof !== undefined) {
    assertNonEmpty('requestProof.id', definition.requestProof.id)
    assertNonEmpty('requestProof.revision', definition.requestProof.revision)
    if (
      !Number.isInteger(definition.requestProof.maxAgeMs)
      || definition.requestProof.maxAgeMs <= 0
    ) {
      throw new AdapterHardBudgetProfileError(
        'invalid_profile',
        'requestProof.maxAgeMs must be a positive integer',
      )
    }
    if (!definition.modelSnapshot || !definition.requestFormat.fingerprint) {
      throw new AdapterHardBudgetProfileError(
        'invalid_profile',
        'requestProof requires modelSnapshot and requestFormat.fingerprint',
      )
    }
  }
  return Object.freeze({
    ...definition,
    tokenizer: Object.freeze({
      ...definition.tokenizer,
      allowedMethods: Object.freeze([...definition.tokenizer.allowedMethods]),
    }),
    requestFormat: Object.freeze({ ...definition.requestFormat }),
    ...(definition.modelSnapshot
      ? { modelSnapshot: Object.freeze({ ...definition.modelSnapshot }) }
      : {}),
    ...(definition.requestProof
      ? { requestProof: Object.freeze({ ...definition.requestProof }) }
      : {}),
  })
}

function fingerprintDefinitions(
  definitions: readonly Readonly<AdapterHardBudgetHostProfileDefinition>[],
): string {
  const serializable = definitions
    .map((definition) => ({
      ...definition,
      tokenizer: {
        ...definition.tokenizer,
        allowedMethods: [...definition.tokenizer.allowedMethods].sort(),
      },
    }))
    .sort((left, right) => profileKey(left.provider, left.model)
      .localeCompare(profileKey(right.provider, right.model)))
  return createHash('sha256')
    .update(JSON.stringify(serializable))
    .digest('hex')
}

export class AdapterHardBudgetHostProfileRegistry {
  readonly fingerprint: string
  private readonly profiles = new Map<
    string,
    Readonly<AdapterHardBudgetHostProfileDefinition>
  >()

  constructor(definitions: readonly AdapterHardBudgetHostProfileDefinition[]) {
    const defined = definitions.map(defineAdapterHardBudgetHostProfile)
    for (const definition of defined) {
      const key = profileKey(definition.provider, definition.model)
      if (this.profiles.has(key)) {
        throw new AdapterHardBudgetProfileError(
          'duplicate_profile',
          `duplicate hard-budget profile for ${key}`,
        )
      }
      this.profiles.set(key, definition)
    }
    this.fingerprint = fingerprintDefinitions(defined)
  }

  resolve(
    provider: AdapterProviderId,
    model: string,
  ): Readonly<AdapterHardBudgetHostProfileDefinition> | undefined {
    return this.profiles.get(profileKey(provider, model))
  }

  resolveRequired(
    provider: AdapterProviderId,
    model: string,
  ): Readonly<AdapterHardBudgetHostProfileDefinition> {
    const definition = this.resolve(provider, model)
    if (!definition) {
      throw new AdapterHardBudgetProfileError(
        'profile_not_found',
        `no hard-budget profile is registered for ${profileKey(provider, model)}`,
      )
    }
    return definition
  }
}

export interface BoundAdapterHardBudgetProfile {
  profile: Readonly<HardBudgetHostProfile>
  definition: Readonly<AdapterHardBudgetHostProfileDefinition>
  binding: AdapterHardBudgetCounterBinding
}

export function assertAdapterHardBudgetBinding(
  definition: Readonly<AdapterHardBudgetHostProfileDefinition>,
  binding: AdapterHardBudgetCounterBinding,
): void {
  if (
    binding.tokenizerId !== definition.tokenizer.id
    || binding.tokenizerRevision !== definition.tokenizer.revision
  ) {
    throw new AdapterHardBudgetProfileError(
      'tokenizer_binding_mismatch',
      'hard-budget tokenizer binding does not match the profile',
    )
  }
  if (
    binding.requestFormatId !== definition.requestFormat.id
    || binding.requestFormatRevision !== definition.requestFormat.revision
  ) {
    throw new AdapterHardBudgetProfileError(
      'request_format_binding_mismatch',
      'hard-budget request-format binding does not match the profile',
    )
  }
}

export function assertAdapterHardBudgetRequestProofBinding(
  definition: Readonly<AdapterHardBudgetHostProfileDefinition>,
  binding: AdapterHardBudgetRequestProofBinding,
): void {
  const contract = definition.requestProof
  if (
    !contract
    || binding.id !== contract.id
    || binding.revision !== contract.revision
  ) {
    throw new AdapterHardBudgetProfileError(
      'request_proof_binding_mismatch',
      'hard-budget request proof binding does not match the profile',
    )
  }
  if (
    binding.requestFormatId !== definition.requestFormat.id
    || binding.requestFormatRevision !== definition.requestFormat.revision
  ) {
    throw new AdapterHardBudgetProfileError(
      'request_format_binding_mismatch',
      'hard-budget request proof format does not match the profile',
    )
  }
  if (
    binding.requestFormatFingerprint !== definition.requestFormat.fingerprint
  ) {
    throw new AdapterHardBudgetProfileError(
      'request_format_fingerprint_mismatch',
      'hard-budget request proof fingerprint does not match the profile',
    )
  }
}
