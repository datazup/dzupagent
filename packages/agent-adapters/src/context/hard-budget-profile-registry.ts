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

/** Host-owned counters bound to explicit tokenizer and request-format revisions. */
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

/** Serializable provider/model contract. Runtime counters are bound separately. */
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
  }
}

export type AdapterHardBudgetProfileErrorCode =
  | 'profile_not_found'
  | 'duplicate_profile'
  | 'invalid_profile'
  | 'tokenizer_binding_mismatch'
  | 'request_format_binding_mismatch'
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
  return Object.freeze({
    ...definition,
    tokenizer: Object.freeze({
      ...definition.tokenizer,
      allowedMethods: Object.freeze([...definition.tokenizer.allowedMethods]),
    }),
    requestFormat: Object.freeze({ ...definition.requestFormat }),
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

/** Immutable exact-match registry; unknown provider/model pairs fail closed. */
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
