import { SystemMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { DzupEventBus } from '@dzupagent/core/events'
import {
  compressToHardBudget,
  fitTextToHardBudget,
  measureTokenText,
  type CompressionDegradation,
  type HardBudgetCompliance,
  type ProgressiveCompressConfig,
  type TokenCounter,
  type TokenMeasurementResult,
} from '@dzupagent/context'

const SUMMARY_PREFIX = '## Prior Conversation Context\n\n'
const SUMMARY_MARKER = '\n\n...[summary truncated to fit reserved budget]...'
export const RUNTIME_HARD_BUDGET_MARKER =
  '\n\n...[truncated to fit runtime context budget]...'

/** Explicit model-input reservations used by agent and team handoff gates. */
export interface HardBudgetReservationConfig {
  /** Full model context window, including input and reserved output. */
  contextWindowTokens: number
  /** Tokens unavailable to input because they are reserved for model output. */
  reservedOutputTokens: number
  /** Content tokens reserved for a rolling summary produced by compression. */
  reservedSummaryTokens: number
  /** Fixed provider/chat serialization overhead. */
  fixedEnvelopeTokens: number
  /** Per-message provider/chat serialization overhead. */
  perMessageEnvelopeTokens: number
  /** Provenance-aware counter. Count-only and heuristic counters fail closed. */
  tokenCounter: TokenCounter
  /** Optional model identifier forwarded to the counter. */
  model?: string
}

/** Agent-specific hard-budget policy, including compression knobs. */
export interface AgentHardBudgetConfig extends HardBudgetReservationConfig {
  compression?: Omit<
    ProgressiveCompressConfig,
    'tokenCounter' | 'model' | 'allowModelSummarization'
  >
}

export interface HardBudgetReservation {
  contextWindowTokens: number
  inputTokenLimit: number
  contentTokenLimit: number
  transcriptTokenLimit: number
  outputTokens: number
  summaryTokens: number
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
  degradations?: CompressionDegradation[]
}

export interface RuntimeHardBudgetTextResult {
  /** Null means the caller must keep its original text and abort the handoff. */
  text: string | null
  tokenMeasurement: TokenMeasurementResult
  hardBudget: HardBudgetCompliance
  reservation: HardBudgetReservation
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

/** Validate a reservation contract without invoking a model or counter. */
export function validateHardBudgetReservation(
  config: HardBudgetReservationConfig,
): void {
  assertNonNegativeInteger('contextWindowTokens', config.contextWindowTokens)
  assertNonNegativeInteger('reservedOutputTokens', config.reservedOutputTokens)
  assertNonNegativeInteger('reservedSummaryTokens', config.reservedSummaryTokens)
  assertNonNegativeInteger('fixedEnvelopeTokens', config.fixedEnvelopeTokens)
  assertNonNegativeInteger(
    'perMessageEnvelopeTokens',
    config.perMessageEnvelopeTokens,
  )
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
    config.contextWindowTokens - config.reservedOutputTokens,
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
    envelopeTokens,
    totalReservedTokens:
      config.reservedOutputTokens
      + config.reservedSummaryTokens
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
): RuntimeHardBudgetResult {
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
    degradations,
  }
}

function isProven(measurement: TokenMeasurementResult): boolean {
  return measurement.method === 'exact'
    || measurement.method === 'encoding-fallback'
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
  if (
    !isProven(finalMeasurement)
    || finalMeasurement.tokens > reservation.contentTokenLimit
  ) {
    const reason = !isProven(finalMeasurement)
      ? finalMeasurement.reason ?? 'final runtime measurement is heuristic'
      : 'final runtime content exceeds its reserved input share'
    return unsafeResult(messages, reservation, finalMeasurement, [
      ...degradations,
      { stage: 'token-measurement', reason, adoptionSafe: false },
    ])
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
  return {
    text: fitted.text,
    tokenMeasurement: fitted.tokenMeasurement,
    hardBudget: fitted.hardBudget,
    reservation,
    ...(fitted.degradation ? { degradation: fitted.degradation } : {}),
  }
}

/** Emit an agent hard-budget proof without prompt or degradation text. */
export function emitAgentHardBudgetTelemetry(args: {
  eventBus?: DzupEventBus | undefined
  agentId: string
  phase: 'tool-loop' | 'stream'
  result: RuntimeHardBudgetResult
}): void {
  const { result } = args
  args.eventBus?.emit({
    type: 'context:hard_budget_evaluated',
    agentId: args.agentId,
    phase: args.phase,
    contextWindowTokens: result.reservation.contextWindowTokens,
    contentTokenLimit: result.reservation.contentTokenLimit,
    reservedTokens: result.reservation.totalReservedTokens,
    measuredTokens: result.tokenMeasurement.tokens,
    measurementMethod: result.tokenMeasurement.method,
    satisfied: result.hardBudget.satisfied,
    adoptionSafe: result.hardBudget.adoptionSafe,
    truncated: result.hardBudget.truncated,
    markerIncluded: result.hardBudget.markerIncluded,
  })
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
