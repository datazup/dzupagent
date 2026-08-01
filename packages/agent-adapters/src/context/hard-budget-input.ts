import { createHash } from 'node:crypto'
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import {
  defineHardBudgetHostProfile,
  fitProtectedTranscript,
  hardBudgetMeasurementFailure,
  resolveHardBudgetReservation,
  type HardBudgetHostProfile,
  type HardBudgetReservation,
} from '@dzupagent/agent/agent'
import {
  measureTokenText,
  type HardBudgetCompliance,
  type TokenMeasurementResult,
} from '@dzupagent/context'
import type { AgentInput, AdapterProviderId } from '../types.js'
import {
  AdapterHardBudgetProfileError,
  assertAdapterHardBudgetBinding,
  type AdapterHardBudgetCounterBinding,
  type AdapterHardBudgetHostProfileDefinition,
  type AdapterHardBudgetHostProfileRegistry,
  type AdapterHardBudgetRequest,
  type AdapterHardBudgetProfileErrorCode,
} from './hard-budget-profile-registry.js'

export interface AdapterHardBudgetEvaluation {
  type: 'adapter:hard_budget_evaluated'
  provider: AdapterProviderId
  model: string
  accepted: boolean
  code?: AdapterHardBudgetProfileErrorCode
  registryFingerprint: string
  profileId?: string
  profileRevision?: string
  tokenizerId?: string
  tokenizerRevision?: string
  requestFormatId?: string
  requestFormatRevision?: string
  toolSchemaFingerprint?: string
  contextWindowTokens?: number
  providerInputLimit?: number
  contentTokenLimit?: number
  outputReservedTokens?: number
  summaryReservedTokens?: number
  toolReservedTokens?: number
  envelopeTokens?: number
  measuredRequestTokens?: number
  measurementMethod?: TokenMeasurementResult['method']
  adoptionSafe: boolean
  satisfied: boolean
}

export interface AdapterHardBudgetPolicy {
  registry: AdapterHardBudgetHostProfileRegistry
  binding: AdapterHardBudgetCounterBinding
  onEvaluation?: (evaluation: AdapterHardBudgetEvaluation) => void
}

export interface PreparedAdapterHardBudgetInput {
  input: AgentInput
  profile: Readonly<HardBudgetHostProfile>
  reservation: HardBudgetReservation
  hardBudget: HardBudgetCompliance
  requestMeasurement: TokenMeasurementResult
  evaluation: AdapterHardBudgetEvaluation
}

function emitEvaluation(
  policy: AdapterHardBudgetPolicy,
  evaluation: AdapterHardBudgetEvaluation,
): void {
  try {
    policy.onEvaluation?.(evaluation)
  } catch {
    // Telemetry must not weaken or replace the provider-boundary decision.
  }
}

function fail(
  policy: AdapterHardBudgetPolicy,
  evaluation: AdapterHardBudgetEvaluation,
  code: AdapterHardBudgetProfileErrorCode,
  message: string,
): never {
  const rejected = { ...evaluation, accepted: false, code }
  emitEvaluation(policy, rejected)
  throw new AdapterHardBudgetProfileError(code, message)
}

function messagesFromInput(input: AgentInput): BaseMessage[] {
  return [
    ...(input.systemPrompt ? [new SystemMessage(input.systemPrompt)] : []),
    new HumanMessage(input.prompt),
  ]
}

function wireMessages(messages: readonly BaseMessage[]): AdapterHardBudgetRequest['messages'] {
  return messages.map((message) => ({
    role: message._getType() === 'system' ? 'system' : 'user',
    content: typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content),
  }))
}

function blankMessages(
  messages: AdapterHardBudgetRequest['messages'],
): AdapterHardBudgetRequest['messages'] {
  return messages.map((message) => ({ ...message, content: '' }))
}

function toolSchemaFingerprint(tools?: readonly unknown[]): string | undefined {
  if (!tools || tools.length === 0) return undefined
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex')
}

function validateMeasurement(
  definition: Readonly<AdapterHardBudgetHostProfileDefinition>,
  measurement: TokenMeasurementResult,
): AdapterHardBudgetProfileErrorCode | undefined {
  if (
    measurement.method !== 'exact'
    && measurement.method !== 'encoding-fallback'
  ) {
    return 'measurement_unproven'
  }
  if (!definition.tokenizer.allowedMethods.includes(measurement.method)) {
    return 'measurement_mismatch'
  }
  if (measurement.model !== definition.model) {
    return 'measurement_mismatch'
  }
  if (
    definition.tokenizer.encoding
    && measurement.tokens > 0
    && measurement.encoding !== definition.tokenizer.encoding
  ) {
    return 'measurement_mismatch'
  }
  return undefined
}

function measureRequest(
  definition: Readonly<AdapterHardBudgetHostProfileDefinition>,
  binding: AdapterHardBudgetCounterBinding,
  request: AdapterHardBudgetRequest,
): TokenMeasurementResult {
  const measurement = binding.countRequest(request)
  const failure = validateMeasurement(definition, measurement)
  if (failure) {
    throw new AdapterHardBudgetProfileError(
      failure,
      'adapter request measurement does not satisfy profile provenance',
    )
  }
  return measurement
}

function baseEvaluation(args: {
  provider: AdapterProviderId
  model: string
  policy: AdapterHardBudgetPolicy
  definition?: Readonly<AdapterHardBudgetHostProfileDefinition>
  tools?: readonly unknown[]
}): AdapterHardBudgetEvaluation {
  return {
    type: 'adapter:hard_budget_evaluated',
    provider: args.provider,
    model: args.model,
    accepted: false,
    registryFingerprint: args.policy.registry.fingerprint,
    ...(args.definition
      ? {
          profileId: args.definition.id,
          profileRevision: args.definition.revision,
          tokenizerId: args.definition.tokenizer.id,
          tokenizerRevision: args.definition.tokenizer.revision,
          requestFormatId: args.definition.requestFormat.id,
          requestFormatRevision: args.definition.requestFormat.revision,
          contextWindowTokens: args.definition.contextWindowTokens,
          outputReservedTokens: args.definition.reservedOutputTokens,
          summaryReservedTokens: args.definition.reservedSummaryTokens,
        }
      : {}),
    ...(toolSchemaFingerprint(args.tools)
      ? { toolSchemaFingerprint: toolSchemaFingerprint(args.tools) }
      : {}),
    adoptionSafe: false,
    satisfied: false,
  }
}

/**
 * Bind and enforce a provider request before the adapter can open transport.
 * The returned input is a copy; failures never expose or mutate prompt text.
 */
export function prepareAdapterHardBudgetInput(args: {
  input: AgentInput
  provider: AdapterProviderId
  model: string
  tools?: readonly unknown[]
  toolChoice?: unknown
  policy: AdapterHardBudgetPolicy
}): PreparedAdapterHardBudgetInput {
  const { input, provider, model, tools, toolChoice, policy } = args
  const unresolved = baseEvaluation({ provider, model, policy, tools })
  const definition = policy.registry.resolve(provider, model)
  if (!definition) {
    return fail(
      policy,
      unresolved,
      'profile_not_found',
      'adapter hard-budget profile is missing',
    )
  }
  const evaluation = baseEvaluation({
    provider,
    model,
    policy,
    definition,
    tools,
  })
  try {
    assertAdapterHardBudgetBinding(definition, policy.binding)
  } catch (error) {
    const code = error instanceof AdapterHardBudgetProfileError
      ? error.code
      : 'invalid_profile'
    return fail(policy, evaluation, code, 'adapter hard-budget binding failed')
  }

  const messages = messagesFromInput(input)
  const wire = wireMessages(messages)
  const requestBase = { provider, model, messages: blankMessages(wire) }
  let envelopeMeasurement: TokenMeasurementResult
  let toolMeasurement: TokenMeasurementResult
  try {
    envelopeMeasurement = measureRequest(definition, policy.binding, requestBase)
    toolMeasurement = measureRequest(definition, policy.binding, {
      ...requestBase,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
    })
  } catch (error) {
    const code = error instanceof AdapterHardBudgetProfileError
      ? error.code
      : 'measurement_unproven'
    return fail(policy, evaluation, code, 'adapter reservation measurement failed')
  }
  if (toolMeasurement.tokens < envelopeMeasurement.tokens) {
    return fail(
      policy,
      evaluation,
      'reservation_non_monotonic',
      'adapter tool reservation measurement was non-monotonic',
    )
  }
  const toolTokens = toolMeasurement.tokens - envelopeMeasurement.tokens
  const profile = defineHardBudgetHostProfile({
    contextWindowTokens: definition.contextWindowTokens,
    reservedOutputTokens: definition.reservedOutputTokens,
    reservedSummaryTokens: definition.reservedSummaryTokens,
    reservedToolTokens: toolTokens,
    fixedEnvelopeTokens: envelopeMeasurement.tokens,
    perMessageEnvelopeTokens: 0,
    tokenCounter: policy.binding.contentCounter,
    model,
    hostProfile: {
      schemaVersion: '1',
      id: definition.id,
      revision: definition.revision,
      provider,
    },
    tokenizerProvenance: {
      ...definition.tokenizer,
      model,
    },
    protectedTranscript: {
      preserveSystemMessages: true,
      preserveLatestUserMessages: 1,
      preserveRecentToolCallGroups: 1,
    },
  })
  const reservation = resolveHardBudgetReservation(profile, messages.length)
  const fitted = fitProtectedTranscript({
    messages,
    tokenBudget: reservation.transcriptTokenLimit,
    policy: profile.protectedTranscript,
    measure: (candidate) => measureTokenText(
      candidate.map((message) => typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content)).join(''),
      profile.tokenCounter,
      model,
    ),
  })
  const fitFailure = hardBudgetMeasurementFailure(
    profile,
    fitted.tokenMeasurement,
  )
  const reservationEvidence = {
    providerInputLimit:
      definition.contextWindowTokens - definition.reservedOutputTokens,
    contentTokenLimit: reservation.contentTokenLimit,
    toolReservedTokens: reservation.toolTokens,
    envelopeTokens: reservation.envelopeTokens,
  }
  if (!fitted.adoptionSafe || fitFailure) {
    return fail(
      policy,
      { ...evaluation, ...reservationEvidence },
      fitFailure ? 'measurement_mismatch' : 'transcript_unsafe',
      'adapter transcript is unsafe to adopt',
    )
  }

  const preparedWire = wireMessages(fitted.messages)
  let requestMeasurement: TokenMeasurementResult
  try {
    requestMeasurement = measureRequest(definition, policy.binding, {
      provider,
      model,
      messages: preparedWire,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
    })
  } catch (error) {
    const code = error instanceof AdapterHardBudgetProfileError
      ? error.code
      : 'measurement_unproven'
    return fail(policy, { ...evaluation, ...reservationEvidence }, code,
      'adapter request measurement failed')
  }
  if (requestMeasurement.tokens > reservationEvidence.providerInputLimit) {
    return fail(
      policy,
      {
        ...evaluation,
        ...reservationEvidence,
        measuredRequestTokens: requestMeasurement.tokens,
        measurementMethod: requestMeasurement.method,
      },
      'request_over_budget',
      'adapter request exceeds the provider input budget',
    )
  }

  const preparedInput: AgentInput = {
    ...input,
    prompt: preparedWire.find((message) => message.role === 'user')!.content,
    ...(input.systemPrompt !== undefined
      ? {
          systemPrompt: input.systemPrompt.length === 0
            ? input.systemPrompt
            : preparedWire.find(
              (message) => message.role === 'system',
            )!.content,
        }
      : {}),
  }
  const hardBudget: HardBudgetCompliance = {
    limit: reservationEvidence.providerInputLimit,
    satisfied: true,
    adoptionSafe: true,
    truncated: fitted.truncated,
    markerIncluded: fitted.markerIncluded,
  }
  const accepted: AdapterHardBudgetEvaluation = {
    ...evaluation,
    ...reservationEvidence,
    accepted: true,
    measuredRequestTokens: requestMeasurement.tokens,
    measurementMethod: requestMeasurement.method,
    adoptionSafe: true,
    satisfied: true,
  }
  emitEvaluation(policy, accepted)
  return {
    input: preparedInput,
    profile,
    reservation,
    hardBudget,
    requestMeasurement,
    evaluation: accepted,
  }
}
