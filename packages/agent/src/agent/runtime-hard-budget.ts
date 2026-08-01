import { SystemMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { DzupEventBus } from '@dzupagent/core/events'
import {
  compressToHardBudget,
  fitTextToHardBudget,
  measureTokenText,
  type CompressionDegradation,
  type HardBudgetCompliance,
  type TokenMeasurementResult,
} from '@dzupagent/context'
import {
  hardBudgetHostProfileProof,
  hardBudgetMeasurementFailure,
  validateHardBudgetReservation,
  type AgentHardBudgetConfig,
  type HardBudgetHostProfileProof,
  type HardBudgetReservationConfig,
} from './hard-budget-host-profile.js'
import {
  fitProtectedTranscript,
  type ProtectedTranscriptEvidence,
} from './hard-budget-protection.js'
import { emitAgentHardBudgetTelemetry } from './runtime-hard-budget-telemetry.js'

export {
  HARD_BUDGET_HOST_PROFILE_SCHEMA_VERSION,
  defineHardBudgetHostProfile,
  validateHardBudgetReservation,
} from './hard-budget-host-profile.js'
export { PROTECTED_TRANSCRIPT_MARKER } from './hard-budget-protection.js'
export type {
  AgentHardBudgetConfig,
  HardBudgetHostProfile,
  HardBudgetHostProfileIdentity,
  HardBudgetHostProfileProof,
  HardBudgetReservationConfig,
  HardBudgetTokenizerProvenance,
  ProvenTokenMeasurementMethod,
} from './hard-budget-host-profile.js'
export type {
  ProtectedTranscriptEvidence,
  ProtectedTranscriptPolicy,
} from './hard-budget-protection.js'
export { emitAgentHardBudgetTelemetry } from './runtime-hard-budget-telemetry.js'

const SUMMARY_PREFIX = '## Prior Conversation Context\n\n'
const SUMMARY_MARKER = '\n\n...[summary truncated to fit reserved budget]...'
export const RUNTIME_HARD_BUDGET_MARKER =
  '\n\n...[truncated to fit runtime context budget]...'

export interface HardBudgetReservation {
  contextWindowTokens: number
  inputTokenLimit: number
  contentTokenLimit: number
  transcriptTokenLimit: number
  outputTokens: number
  summaryTokens: number
  toolTokens: number
  envelopeTokens: number
  totalReservedTokens: number
}

export interface RuntimeHardBudgetResult {
  /** Original transcript on unsafe results; fitted transcript otherwise. */
  messages: BaseMessage[]
  summary: string | null
  tokenMeasurement: TokenMeasurementResult
  hardBudget: HardBudgetCompliance
  reservation: HardBudgetReservation
  profile?: HardBudgetHostProfileProof
  protection?: ProtectedTranscriptEvidence
  degradations?: CompressionDegradation[]
}

export interface RuntimeHardBudgetTextResult {
  /** Null means the caller must keep its original text and abort the handoff. */
  text: string | null
  tokenMeasurement: TokenMeasurementResult
  hardBudget: HardBudgetCompliance
  reservation: HardBudgetReservation
  profile?: HardBudgetHostProfileProof
  degradation?: CompressionDegradation
}

/** Fail-closed error raised before a provider or participant receives input. */
export class RuntimeHardBudgetAdoptionError extends Error {
  readonly phase: 'tool-loop' | 'stream' | 'team-runtime'
  readonly hardBudget: HardBudgetCompliance
  readonly reservation: HardBudgetReservation

  constructor(
    phase: RuntimeHardBudgetAdoptionError['phase'],
    result: Pick<RuntimeHardBudgetResult, 'hardBudget' | 'reservation'>,
  ) {
    super(`Runtime hard-budget result was unsafe to adopt during ${phase}`)
    this.name = 'RuntimeHardBudgetAdoptionError'
    this.phase = phase
    this.hardBudget = result.hardBudget
    this.reservation = result.reservation
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

export function resolveHardBudgetReservation(
  config: HardBudgetReservationConfig,
  messageCount: number,
): HardBudgetReservation {
  validateHardBudgetReservation(config)
  assertNonNegativeInteger('messageCount', messageCount)

  // One extra slot covers a generated summary. It is conservative when no
  // summary is produced and also covers marker insertion after hard trimming.
  const envelopeTokens = config.fixedEnvelopeTokens
    + config.perMessageEnvelopeTokens * (messageCount + 1)
  const inputTokenLimit = Math.max(
    0,
    config.contextWindowTokens
      - config.reservedOutputTokens
      - (config.reservedToolTokens ?? 0),
  )
  const contentTokenLimit = Math.max(0, inputTokenLimit - envelopeTokens)
  const transcriptTokenLimit = Math.max(
    0,
    contentTokenLimit - config.reservedSummaryTokens,
  )
  return {
    contextWindowTokens: config.contextWindowTokens,
    inputTokenLimit,
    contentTokenLimit,
    transcriptTokenLimit,
    outputTokens: config.reservedOutputTokens,
    summaryTokens: config.reservedSummaryTokens,
    toolTokens: config.reservedToolTokens ?? 0,
    envelopeTokens,
    totalReservedTokens:
      config.reservedOutputTokens
      + config.reservedSummaryTokens
      + (config.reservedToolTokens ?? 0)
      + envelopeTokens,
  }
}

function messageContent(message: BaseMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content)
}

function measureMessages(
  messages: BaseMessage[],
  config: HardBudgetReservationConfig,
): TokenMeasurementResult {
  if (messages.length === 0) {
    return {
      tokens: 0,
      method: 'exact',
      ...(config.model ? { model: config.model } : {}),
    }
  }
  return measureTokenText(
    messages.map(messageContent).join(''),
    config.tokenCounter,
    config.model,
  )
}

function unsafeResult(
  messages: BaseMessage[],
  reservation: HardBudgetReservation,
  measurement: TokenMeasurementResult,
  degradations: CompressionDegradation[],
  config: HardBudgetReservationConfig,
  protection?: ProtectedTranscriptEvidence,
): RuntimeHardBudgetResult {
  const profile = hardBudgetHostProfileProof(config)
  return {
    messages: [...messages],
    summary: null,
    tokenMeasurement: measurement,
    hardBudget: {
      limit: reservation.contentTokenLimit,
      satisfied: false,
      adoptionSafe: false,
      truncated: false,
      markerIncluded: false,
    },
    reservation,
    ...(profile ? { profile } : {}),
    ...(protection ? { protection } : {}),
    degradations,
  }
}

/**
 * Fit a complete agent transcript under its context-window content share.
 * The input array is never mutated. Generated summaries must independently fit
 * their explicit reservation before they can be inserted.
 */
export async function applyRuntimeHardBudget(args: {
  messages: BaseMessage[]
  model: BaseChatModel
  config: AgentHardBudgetConfig
}): Promise<RuntimeHardBudgetResult> {
  const { messages, model, config } = args
  const reservation = resolveHardBudgetReservation(config, messages.length)
  const profile = hardBudgetHostProfileProof(config)
  if (config.protectedTranscript) {
    const fitted = fitProtectedTranscript({
      messages,
      tokenBudget: reservation.transcriptTokenLimit,
      policy: config.protectedTranscript,
      measure: (candidate) => measureMessages(candidate, config),
    })
    const provenanceFailure = hardBudgetMeasurementFailure(
      config,
      fitted.tokenMeasurement,
    )
    if (!fitted.adoptionSafe || provenanceFailure) {
      const reason = provenanceFailure
        ?? fitted.reason
        ?? 'protected transcript is unsafe to adopt'
      return unsafeResult(
        messages,
        reservation,
        fitted.tokenMeasurement,
        [{
          stage: provenanceFailure
            ? 'token-measurement'
            : 'hard-budget-marker',
          reason,
          adoptionSafe: false,
        }],
        config,
        fitted.evidence,
      )
    }
    return {
      messages: fitted.messages,
      summary: null,
      tokenMeasurement: fitted.tokenMeasurement,
      hardBudget: {
        limit: reservation.contentTokenLimit,
        satisfied: true,
        adoptionSafe: true,
        truncated: fitted.truncated,
        markerIncluded: fitted.markerIncluded,
      },
      reservation,
      ...(profile ? { profile } : {}),
      protection: fitted.evidence,
    }
  }
  const compressed = await compressToHardBudget(
    messages,
    reservation.transcriptTokenLimit,
    null,
    model,
    {
      ...config.compression,
      tokenCounter: config.tokenCounter,
      // A summarizer call made from inside this gate would itself bypass the
      // gate, audit wrapper, and model hooks. Deterministic levels remain safe.
      allowModelSummarization: false,
      ...(config.model ? { model: config.model } : {}),
    },
  )
  if (!compressed.hardBudget.adoptionSafe) {
    return unsafeResult(
      messages,
      reservation,
      compressed.tokenMeasurement,
      compressed.degradations ?? [],
      config,
    )
  }

  let fittedMessages = [...compressed.messages]
  let summaryTruncated = false
  let summaryMarkerIncluded = false
  const degradations = [...(compressed.degradations ?? [])]
  if (compressed.summary?.trim()) {
    const summaryText = SUMMARY_PREFIX + compressed.summary
    const reservedSummary = fitTextToHardBudget({
      text: summaryText,
      tokenBudget: reservation.summaryTokens,
      marker: SUMMARY_MARKER,
      requiredPrefix: SUMMARY_PREFIX,
      measure: (text) => measureTokenText(
        text,
        config.tokenCounter,
        config.model,
      ),
      operation: 'runtime summary reservation',
    })
    if (!reservedSummary.hardBudget.adoptionSafe || reservedSummary.text === null) {
      return unsafeResult(
        messages,
        reservation,
        reservedSummary.tokenMeasurement,
        [
          ...degradations,
          ...(reservedSummary.degradation ? [reservedSummary.degradation] : []),
        ],
        config,
      )
    }

    // Token encodings are not additive across message boundaries. Measure the
    // complete candidate while fitting the already-reserved summary again.
    const combined = fitTextToHardBudget({
      text: reservedSummary.text,
      tokenBudget: reservation.contentTokenLimit,
      marker: SUMMARY_MARKER,
      requiredPrefix: SUMMARY_PREFIX,
      measure: (text) => measureMessages(
        [new SystemMessage(text), ...compressed.messages],
        config,
      ),
      operation: 'runtime combined content budget',
    })
    if (!combined.hardBudget.adoptionSafe || combined.text === null) {
      return unsafeResult(
        messages,
        reservation,
        combined.tokenMeasurement,
        [
          ...degradations,
          ...(combined.degradation ? [combined.degradation] : []),
        ],
        config,
      )
    }
    fittedMessages = [new SystemMessage(combined.text), ...compressed.messages]
    summaryTruncated = reservedSummary.hardBudget.truncated
      || combined.hardBudget.truncated
    summaryMarkerIncluded =
      (!reservedSummary.hardBudget.truncated
        || reservedSummary.hardBudget.markerIncluded)
      && (!combined.hardBudget.truncated || combined.hardBudget.markerIncluded)
  }

  const finalMeasurement = measureMessages(fittedMessages, config)
  const provenanceFailure = hardBudgetMeasurementFailure(
    config,
    finalMeasurement,
  )
  if (
    provenanceFailure
    || finalMeasurement.tokens > reservation.contentTokenLimit
  ) {
    const reason = provenanceFailure
      ?? 'final runtime content exceeds its reserved input share'
    return unsafeResult(
      messages,
      reservation,
      finalMeasurement,
      [
        ...degradations,
        { stage: 'token-measurement', reason, adoptionSafe: false },
      ],
      config,
    )
  }

  const truncated = compressed.hardBudget.truncated || summaryTruncated
  return {
    messages: fittedMessages,
    summary: compressed.summary,
    tokenMeasurement: finalMeasurement,
    hardBudget: {
      limit: reservation.contentTokenLimit,
      satisfied: true,
      adoptionSafe: true,
      truncated,
      markerIncluded: truncated
        ? compressed.hardBudget.markerIncluded || summaryMarkerIncluded
        : false,
    },
    reservation,
    ...(profile ? { profile } : {}),
    ...(degradations.length > 0 ? { degradations } : {}),
  }
}

/** Fit one runtime-owned handoff string using the same reservations. */
export function applyRuntimeTextHardBudget(args: {
  text: string
  config: HardBudgetReservationConfig
  requiredPrefix?: string
}): RuntimeHardBudgetTextResult {
  const reservation = resolveHardBudgetReservation(args.config, 1)
  const fitted = fitTextToHardBudget({
    text: args.text,
    tokenBudget: reservation.transcriptTokenLimit,
    marker: RUNTIME_HARD_BUDGET_MARKER,
    ...(args.requiredPrefix ? { requiredPrefix: args.requiredPrefix } : {}),
    measure: (text) => measureTokenText(
      text,
      args.config.tokenCounter,
      args.config.model,
    ),
    operation: 'runtime text handoff',
  })
  const profile = hardBudgetHostProfileProof(args.config)
  const provenanceFailure = hardBudgetMeasurementFailure(
    args.config,
    fitted.tokenMeasurement,
  )
  if (provenanceFailure) {
    return {
      text: null,
      tokenMeasurement: fitted.tokenMeasurement,
      hardBudget: {
        limit: reservation.transcriptTokenLimit,
        satisfied: false,
        adoptionSafe: false,
        truncated: false,
        markerIncluded: false,
      },
      reservation,
      ...(profile ? { profile } : {}),
      degradation: {
        stage: 'token-measurement',
        reason: provenanceFailure,
        adoptionSafe: false,
      },
    }
  }
  return {
    text: fitted.text,
    tokenMeasurement: fitted.tokenMeasurement,
    hardBudget: fitted.hardBudget,
    reservation,
    ...(profile ? { profile } : {}),
    ...(fitted.degradation ? { degradation: fitted.degradation } : {}),
  }
}

/** Adopt only proven output; unsafe output leaves `messages` intact. */
export async function enforceAgentHardBudget(args: {
  messages: BaseMessage[]
  model: BaseChatModel
  config: AgentHardBudgetConfig
  eventBus?: DzupEventBus | undefined
  agentId: string
  phase: 'tool-loop' | 'stream'
}): Promise<RuntimeHardBudgetResult> {
  const result = await applyRuntimeHardBudget(args)
  emitAgentHardBudgetTelemetry({
    eventBus: args.eventBus,
    agentId: args.agentId,
    phase: args.phase,
    result,
  })
  if (!result.hardBudget.adoptionSafe) {
    throw new RuntimeHardBudgetAdoptionError(args.phase, result)
  }
  args.messages.splice(0, args.messages.length, ...result.messages)
  return result
}
