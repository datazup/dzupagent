/**
 * Cheap `chars/4` heuristic token counter. No external dependencies and no
 * model-specific behaviour — good enough for coarse budget estimates but
 * should be replaced with `TiktokenCounter` when accurate counts matter
 * (e.g. tight context-window management for OpenAI models).
 */

import {
  estimateTokensByChars,
  type TokenCounter,
  type TokenMeasurementResult,
} from './token-lifecycle.js'

export class CharEstimateCounter implements TokenCounter {
  count(text: string): number {
    return this.countDetailed(text).tokens
  }

  countDetailed(text: string, model?: string): TokenMeasurementResult {
    return {
      tokens: estimateTokensByChars(text),
      method: 'heuristic',
      ...(model ? { model } : {}),
      reason: 'chars-per-token estimate',
    }
  }
}
