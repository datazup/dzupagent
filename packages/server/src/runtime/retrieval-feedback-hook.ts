/**
 * Retrieval Feedback Hook — Maps run reflection scores to AdaptiveRetriever feedback.
 *
 * Creates a closed loop: run -> reflect -> feedback -> retrieval weight tuning.
 *
 * Uses structural types only (no imports from @dzupagent/memory or @dzupagent/agent).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal interface matching AdaptiveRetriever.reportFeedback(). */
export interface RetrievalFeedbackSink {
  reportFeedback(query: string, intent: string, quality: 'good' | 'bad' | 'mixed'): void
}

export interface RetrievalFeedbackHookConfig {
  sink: RetrievalFeedbackSink
  /** Threshold for 'good' quality (default: 0.7) */
  goodThreshold?: number
  /** Threshold for 'bad' quality (default: 0.3) */
  badThreshold?: number
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Map a reflection overall score to a feedback quality label.
 */
export function mapScoreToQuality(
  overall: number,
  goodThreshold: number,
  badThreshold: number,
): 'good' | 'bad' | 'mixed' {
  if (overall >= goodThreshold) return 'good'
  if (overall <= badThreshold) return 'bad'
  return 'mixed'
}

/**
 * Extract a query string from run metadata.
 *
 * Checks, in order:
 * - metadata.query
 * - metadata.input.message
 * - metadata.input (if string)
 *
 * Returns undefined if no usable query is found.
 */
function extractQuery(metadata: Record<string, unknown>): string | undefined {
  // Direct query field
  if (typeof metadata['query'] === 'string' && metadata['query'].length > 0) {
    return metadata['query']
  }

  // Nested input.message or input as string
  const input = metadata['input']
  if (typeof input === 'string' && input.length > 0) {
    return input
  }
  if (input !== null && typeof input === 'object') {
    const inputObj = input as Record<string, unknown>
    if (typeof inputObj['message'] === 'string' && inputObj['message'].length > 0) {
      return inputObj['message']
    }
    // Fallback: input.query
    if (typeof inputObj['query'] === 'string' && inputObj['query'].length > 0) {
      return inputObj['query']
    }
  }

  return undefined
}

/**
 * Extract an intent string from run metadata.
 *
 * Checks: metadata.intent, metadata.routingReason
 */
function extractIntent(metadata: Record<string, unknown>): string | undefined {
  if (typeof metadata['intent'] === 'string' && metadata['intent'].length > 0) {
    return metadata['intent']
  }
  if (typeof metadata['routingReason'] === 'string' && metadata['routingReason'].length > 0) {
    return metadata['routingReason']
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps a reflection score to retrieval feedback quality and reports it.
 * Call this after each run that used memory retrieval.
 *
 * - Extracts query from runMetadata (input.message, input, or query field)
 * - Extracts intent from runMetadata.intent or runMetadata.routingReason
 * - Maps overall score to quality using configurable thresholds
 * - Calls sink.reportFeedback(query, intent, quality)
 * - Wrapped in try/catch: never throws
 */
export function reportRetrievalFeedback(
  config: RetrievalFeedbackHookConfig,
  runMetadata: Record<string, unknown>,
  reflectionScore: { overall: number },
): void {
  try {
    const query = extractQuery(runMetadata)
    if (!query) return // Cannot report feedback without a query

    const intent = extractIntent(runMetadata)
    if (!intent) return // Cannot report feedback without an intent

    const goodThreshold = config.goodThreshold ?? 0.7
    const badThreshold = config.badThreshold ?? 0.3

    const quality = mapScoreToQuality(reflectionScore.overall, goodThreshold, badThreshold)
    config.sink.reportFeedback(query, intent, quality)
  } catch {
    // Retrieval feedback is best-effort — never throw
  }
}
