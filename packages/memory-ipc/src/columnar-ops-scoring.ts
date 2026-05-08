/**
 * Scoring and token-budget operations over Arrow Tables.
 *
 * - computeCompositeScore: weighted decay/importance/recency score
 * - batchTokenEstimate: per-row token estimate from text+payload column lengths
 * - selectByTokenBudget: greedy knapsack selection by composite score
 */

import { type Table } from 'apache-arrow'

import { readNum, readStr, takeRows } from './columnar-ops-helpers.js'

/**
 * Compute a weighted combination of decay strength, importance, and recency.
 *
 *   score = w_decay * strength + w_importance * importance + w_recency * recency
 *   recency = 1 / (1 + ageHours)
 *   ageHours = (now - system_created_at) / 3600000
 *
 * Defaults: strength=1.0 if null, importance=0.5 if null.
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param weights Weight coefficients for each scoring dimension
 * @param now Current timestamp in epoch milliseconds (default: Date.now())
 * @returns Float64Array of composite scores per row
 */
export function computeCompositeScore(
  table: Table,
  weights: { decay: number; importance: number; recency: number },
  now?: number,
): Float64Array {
  const len = table.numRows
  const scores = new Float64Array(len)

  try {
    const currentTime = now ?? Date.now()

    for (let i = 0; i < len; i++) {
      const strength = readNum(table, 'decay_strength', i, 1.0)
      const importance = readNum(table, 'importance', i, 0.5)
      const createdAt = readNum(table, 'system_created_at', i, currentTime)
      const ageHours = Math.max(0, (currentTime - createdAt) / 3600000)
      const recency = 1 / (1 + ageHours)

      scores[i] =
        weights.decay * strength +
        weights.importance * importance +
        weights.recency * recency
    }
  } catch {
    scores.fill(0)
  }

  return scores
}

/**
 * Estimate tokens per record from `text` and `payload_json` column lengths.
 *
 *   tokens = ceil((text.length + payload.length) / charsPerToken)
 *
 * Missing or null text/payload treated as empty string (0 chars).
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param charsPerToken Characters per token ratio (default 4)
 * @returns Int32Array of token estimates per row
 */
export function batchTokenEstimate(
  table: Table,
  charsPerToken = 4,
): Int32Array {
  const len = table.numRows
  const tokens = new Int32Array(len)

  try {
    const effectiveCpt = charsPerToken > 0 ? charsPerToken : 4

    for (let i = 0; i < len; i++) {
      const text = readStr(table, 'text', i, '') ?? ''
      const payload = readStr(table, 'payload_json', i, '') ?? ''
      const totalChars = text.length + payload.length
      tokens[i] = Math.ceil(totalChars / effectiveCpt)
    }
  } catch {
    // Return zeros on error
  }

  return tokens
}

/**
 * Greedy knapsack: pick the highest-scoring records that fit within a token budget.
 *
 * 1. Compute composite scores
 * 2. Compute token estimates
 * 3. Sort by score descending
 * 4. Greedily select until budget exhausted
 *
 * @param table Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param budget Maximum total tokens to select
 * @param weights Scoring weights (default: decay=0.4, importance=0.3, recency=0.3)
 * @param charsPerToken Characters per token ratio (default 4)
 * @returns Filtered Table within budget
 */
export function selectByTokenBudget(
  table: Table,
  budget: number,
  weights?: { decay: number; importance: number; recency: number },
  charsPerToken?: number,
): Table {
  try {
    const effectiveWeights = weights ?? { decay: 0.4, importance: 0.3, recency: 0.3 }
    const scores = computeCompositeScore(table, effectiveWeights)
    const tokens = batchTokenEstimate(table, charsPerToken)

    // Create index array sorted by score descending
    const order: number[] = []
    for (let i = 0; i < table.numRows; i++) {
      order.push(i)
    }
    order.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))

    // Greedy selection
    const selected: number[] = []
    let remaining = budget
    for (const idx of order) {
      const cost = tokens[idx] ?? 0
      if (cost <= remaining) {
        selected.push(idx)
        remaining -= cost
      }
    }

    // Sort selected indices to preserve original order
    selected.sort((a, b) => a - b)
    return takeRows(table, selected)
  } catch {
    return takeRows(table, [])
  }
}
