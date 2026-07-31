import { SystemMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  repairOrphanedToolPairs,
  type CompressionDegradation,
} from './message-manager.js'
import {
  compressToLevel,
  selectCompressionLevel,
  type CompressionLevel,
  type ProgressiveCompressConfig,
  type ProgressiveCompressResult,
} from './progressive-compress.js'
import {
  measureTokenText,
  type HardBudgetCompliance,
  type TokenCounter,
  type TokenMeasurementResult,
} from './token-lifecycle.js'

const DEFAULT_CHARS_PER_TOKEN = 4
const HARD_TRUNCATION_MARKER = '\n\n...[truncated to fit context budget]...'

/** Result from the provenance-enforced hard-budget compression API. */
export interface HardBudgetCompressionResult extends ProgressiveCompressResult {
  /** Proof boundary for adopting the returned messages. */
  hardBudget: HardBudgetCompliance
}

type HardBudgetTrimResult =
  | {
      ok: true
      messages: BaseMessage[]
      measurement: TokenMeasurementResult
    }
  | {
      ok: false
      stage: 'token-measurement' | 'hard-budget-marker'
      reason: string
    }

function getContent(message: BaseMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content)
}

function measureMessages(
  messages: BaseMessage[],
  charsPerToken: number,
  tokenCounter?: TokenCounter,
  model?: string,
): TokenMeasurementResult {
  if (messages.length === 0) {
    return {
      tokens: 0,
      method: 'exact',
      ...(model ? { model } : {}),
    }
  }
  return measureTokenText(
    messages.map(getContent).join(''),
    tokenCounter,
    model,
    charsPerToken,
  )
}

function isHardBudgetMeasurement(
  measurement: TokenMeasurementResult,
): boolean {
  return measurement.method === 'exact' || measurement.method === 'encoding-fallback'
}

/** Drop oldest messages while reserving a complete truncation marker. */
function hardTrimToBudgetWithMarker(
  messages: BaseMessage[],
  tokenBudget: number,
  charsPerToken: number,
  tokenCounter?: TokenCounter,
  model?: string,
): HardBudgetTrimResult {
  const markerMessage = new SystemMessage(HARD_TRUNCATION_MARKER)
  const markerMeasurement = measureMessages(
    [markerMessage],
    charsPerToken,
    tokenCounter,
    model,
  )
  if (!isHardBudgetMeasurement(markerMeasurement)) {
    return {
      ok: false,
      stage: 'token-measurement',
      reason: markerMeasurement.reason ?? 'truncation marker measurement is heuristic',
    }
  }
  if (markerMeasurement.tokens > tokenBudget) {
    return {
      ok: false,
      stage: 'hard-budget-marker',
      reason: `hard budget ${tokenBudget} cannot reserve the ${markerMeasurement.tokens}-token truncation marker`,
    }
  }

  let retained = repairOrphanedToolPairs([...messages])
  while (retained.length > 0) {
    const candidate = [markerMessage, ...retained]
    const measurement = measureMessages(
      candidate,
      charsPerToken,
      tokenCounter,
      model,
    )
    if (!isHardBudgetMeasurement(measurement)) {
      return {
        ok: false,
        stage: 'token-measurement',
        reason: measurement.reason ?? 'hard-trim measurement is heuristic',
      }
    }
    if (measurement.tokens <= tokenBudget) {
      return { ok: true, messages: candidate, measurement }
    }
    retained = repairOrphanedToolPairs(retained.slice(1))
  }

  return {
    ok: true,
    messages: [markerMessage],
    measurement: markerMeasurement,
  }
}

function hardBudgetFailure(
  messages: BaseMessage[],
  existingSummary: string | null,
  tokenBudget: number,
  measurement: TokenMeasurementResult,
  degradations: CompressionDegradation[],
): HardBudgetCompressionResult {
  return {
    messages,
    summary: existingSummary,
    level: 0,
    degradations,
    estimatedTokens: measurement.tokens,
    tokenMeasurement: measurement,
    ratio: 0,
    hardBudget: {
      limit: tokenBudget,
      satisfied: false,
      adoptionSafe: false,
      truncated: false,
      markerIncluded: false,
    },
  }
}

async function compressThroughLevels(
  messages: BaseMessage[],
  tokenBudget: number,
  existingSummary: string | null,
  model: BaseChatModel,
  config?: ProgressiveCompressConfig,
): Promise<ProgressiveCompressResult> {
  const charsPerToken = config?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  let level = selectCompressionLevel(
    messages,
    tokenBudget,
    charsPerToken,
    config?.tokenCounter,
    config?.model,
  )
  if (level === 3 && config?.allowModelSummarization === false) {
    level = 4
  }
  let result = await compressToLevel(messages, level, existingSummary, model, config)
  if (
    result.estimatedTokens <= tokenBudget ||
    result.degradations?.some((degradation) => !degradation.adoptionSafe)
  ) {
    return result
  }

  for (let nextLevel = level + 1; nextLevel <= 4; nextLevel++) {
    if (nextLevel === 3 && config?.allowModelSummarization === false) {
      continue
    }
    result = await compressToLevel(
      messages,
      nextLevel as CompressionLevel,
      existingSummary,
      model,
      config,
    )
    if (
      result.estimatedTokens <= tokenBudget ||
      result.degradations?.some((degradation) => !degradation.adoptionSafe)
    ) {
      return result
    }
  }
  return result
}

/**
 * Compress message content under a proven hard token ceiling.
 *
 * Unlike `compressToBudget`, this API rejects heuristic measurement. If
 * destructive trimming is still required after level 4, it reserves the
 * complete truncation marker before retaining recent messages. A budget too
 * small for that marker returns the original transcript with an
 * adoption-unsafe degradation.
 *
 * The ceiling covers returned message contents. Callers must separately
 * reserve model/chat envelope and summary insertion overhead.
 */
export async function compressToHardBudget(
  messages: BaseMessage[],
  tokenBudget: number,
  existingSummary: string | null,
  model: BaseChatModel,
  config?: ProgressiveCompressConfig,
): Promise<HardBudgetCompressionResult> {
  if (!Number.isInteger(tokenBudget) || tokenBudget < 0) {
    throw new RangeError('hard token budget must be a non-negative integer')
  }

  const charsPerToken = config?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const originalMeasurement = measureMessages(
    messages,
    charsPerToken,
    config?.tokenCounter,
    config?.model,
  )
  if (!isHardBudgetMeasurement(originalMeasurement)) {
    const reason = originalMeasurement.reason ?? 'hard budget measurement is heuristic'
    return hardBudgetFailure(
      messages,
      existingSummary,
      tokenBudget,
      originalMeasurement,
      [{ stage: 'token-measurement', reason, adoptionSafe: false }],
    )
  }

  if (originalMeasurement.tokens <= tokenBudget) {
    return {
      messages,
      summary: existingSummary,
      level: 0,
      estimatedTokens: originalMeasurement.tokens,
      tokenMeasurement: originalMeasurement,
      ratio: 0,
      hardBudget: {
        limit: tokenBudget,
        satisfied: true,
        adoptionSafe: true,
        truncated: false,
        markerIncluded: false,
      },
    }
  }

  const compressed = await compressThroughLevels(
    messages,
    tokenBudget,
    existingSummary,
    model,
    config,
  )
  const unsafeDegradation = compressed.degradations?.find(
    (degradation) => !degradation.adoptionSafe,
  )
  if (unsafeDegradation) {
    return hardBudgetFailure(
      messages,
      existingSummary,
      tokenBudget,
      originalMeasurement,
      compressed.degradations ?? [unsafeDegradation],
    )
  }
  if (!isHardBudgetMeasurement(compressed.tokenMeasurement)) {
    const reason = compressed.tokenMeasurement.reason
      ?? 'compressed output measurement is heuristic'
    return hardBudgetFailure(
      messages,
      existingSummary,
      tokenBudget,
      originalMeasurement,
      [{ stage: 'token-measurement', reason, adoptionSafe: false }],
    )
  }
  if (compressed.estimatedTokens <= tokenBudget) {
    return {
      ...compressed,
      hardBudget: {
        limit: tokenBudget,
        satisfied: true,
        adoptionSafe: true,
        truncated: false,
        markerIncluded: false,
      },
    }
  }

  const hardTrimmed = hardTrimToBudgetWithMarker(
    compressed.messages,
    tokenBudget,
    charsPerToken,
    config?.tokenCounter,
    config?.model,
  )
  if (!hardTrimmed.ok) {
    return hardBudgetFailure(
      messages,
      existingSummary,
      tokenBudget,
      originalMeasurement,
      [{
        stage: hardTrimmed.stage,
        reason: hardTrimmed.reason,
        adoptionSafe: false,
      }],
    )
  }

  const ratio = originalMeasurement.tokens > 0
    ? 1 - hardTrimmed.measurement.tokens / originalMeasurement.tokens
    : 0
  return {
    messages: hardTrimmed.messages,
    summary: compressed.summary,
    level: 4,
    ...(compressed.degradedFrom ? { degradedFrom: compressed.degradedFrom } : {}),
    ...(compressed.degradations ? { degradations: compressed.degradations } : {}),
    estimatedTokens: hardTrimmed.measurement.tokens,
    tokenMeasurement: hardTrimmed.measurement,
    ratio: Math.max(0, Math.min(1, ratio)),
    hardBudget: {
      limit: tokenBudget,
      satisfied: true,
      adoptionSafe: true,
      truncated: true,
      markerIncluded: true,
    },
  }
}
