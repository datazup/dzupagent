import type { CompressionDegradation } from './message-manager.js'
import type {
  HardBudgetCompliance,
  TokenMeasurementResult,
} from './token-lifecycle.js'

export interface HardBudgetTextResult {
  /** Null when the fitted payload is not safe to adopt. */
  text: string | null
  /** Measurement of the fitted text, or the rejected measurement. */
  tokenMeasurement: TokenMeasurementResult
  hardBudget: HardBudgetCompliance
  degradation?: CompressionDegradation
}

export interface FitTextToHardBudgetOptions {
  text: string
  tokenBudget: number
  marker: string
  /** Prefix that must remain complete so the fitted payload keeps its identity. */
  requiredPrefix?: string
  measure: (text: string) => TokenMeasurementResult
  /** Human-readable operation name used only in sanitized failure reasons. */
  operation: string
}

function isHardBudgetMeasurement(
  measurement: TokenMeasurementResult,
): boolean {
  return measurement.method === 'exact' || measurement.method === 'encoding-fallback'
}

function failure(
  tokenBudget: number,
  measurement: TokenMeasurementResult,
  stage: 'token-measurement' | 'hard-budget-marker',
  reason: string,
): HardBudgetTextResult {
  return {
    text: null,
    tokenMeasurement: measurement,
    hardBudget: {
      limit: tokenBudget,
      satisfied: false,
      adoptionSafe: false,
      truncated: false,
      markerIncluded: false,
    },
    degradation: { stage, reason, adoptionSafe: false },
  }
}

/** Fit text to a hard ceiling while preserving a complete truncation marker. */
export function fitTextToHardBudget(
  options: FitTextToHardBudgetOptions,
): HardBudgetTextResult {
  const {
    text,
    tokenBudget,
    marker,
    requiredPrefix = '',
    measure,
    operation,
  } = options
  if (!text.startsWith(requiredPrefix)) {
    throw new Error(`${operation} text does not start with its required prefix`)
  }
  const measurement = measure(text)
  if (!isHardBudgetMeasurement(measurement)) {
    return failure(
      tokenBudget,
      measurement,
      'token-measurement',
      measurement.reason ?? `${operation} measurement is heuristic`,
    )
  }
  if (measurement.tokens <= tokenBudget) {
    return {
      text,
      tokenMeasurement: measurement,
      hardBudget: {
        limit: tokenBudget,
        satisfied: true,
        adoptionSafe: true,
        truncated: false,
        markerIncluded: false,
      },
    }
  }

  const reservedText = requiredPrefix + marker
  const reservedMeasurement = measure(reservedText)
  if (!isHardBudgetMeasurement(reservedMeasurement)) {
    return failure(
      tokenBudget,
      reservedMeasurement,
      'token-measurement',
      reservedMeasurement.reason ?? `${operation} marker measurement is heuristic`,
    )
  }
  if (reservedMeasurement.tokens > tokenBudget) {
    return failure(
      tokenBudget,
      measurement,
      'hard-budget-marker',
      `${operation} ${tokenBudget} cannot reserve the ${reservedMeasurement.tokens}-token identity and truncation marker`,
    )
  }

  const body = text.slice(requiredPrefix.length)
  let low = 0
  let high = body.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidateMeasurement = measure(
      requiredPrefix + body.slice(0, mid) + marker,
    )
    if (!isHardBudgetMeasurement(candidateMeasurement)) {
      return failure(
        tokenBudget,
        candidateMeasurement,
        'token-measurement',
        candidateMeasurement.reason ?? `${operation} trim measurement is heuristic`,
      )
    }
    if (candidateMeasurement.tokens <= tokenBudget) low = mid
    else high = mid - 1
  }

  const candidate = requiredPrefix + body.slice(0, low) + marker
  const candidateMeasurement = measure(candidate)
  if (
    isHardBudgetMeasurement(candidateMeasurement) &&
    candidateMeasurement.tokens <= tokenBudget
  ) {
    return {
      text: candidate,
      tokenMeasurement: candidateMeasurement,
      hardBudget: {
        limit: tokenBudget,
        satisfied: true,
        adoptionSafe: true,
        truncated: true,
        markerIncluded: true,
      },
    }
  }

  // Token counts can be non-monotonic for some encodings. The reserved
  // identity plus marker remains the proven fallback after the search.
  return {
    text: reservedText,
    tokenMeasurement: reservedMeasurement,
    hardBudget: {
      limit: tokenBudget,
      satisfied: true,
      adoptionSafe: true,
      truncated: true,
      markerIncluded: true,
    },
  }
}
