/**
 * Phase-aware memory selection.
 *
 * Adjusts memory scoring based on the current conversation phase
 * (planning, coding, debugging, reviewing, general). Each phase
 * boosts or dampens records by namespace and category.
 */

import { Table } from 'apache-arrow'
import {
  batchTokenEstimate,
  computeCompositeScore,
} from './columnar-ops.js'
import type { ScoredRecord } from './token-budget.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Known conversation phases. */
export type ConversationPhase = 'planning' | 'coding' | 'debugging' | 'reviewing' | 'general'

// ---------------------------------------------------------------------------
// Phase weight tables
// ---------------------------------------------------------------------------

/** Namespace weight multipliers per conversation phase. */
export const PHASE_NAMESPACE_WEIGHTS: Record<ConversationPhase, Record<string, number>> = {
  planning: { decisions: 2.0, conventions: 1.5, lessons: 1.2, observations: 0.8 },
  coding: { conventions: 2.0, decisions: 1.5, lessons: 1.0, observations: 0.8 },
  debugging: { lessons: 2.5, incidents: 2.0, decisions: 1.0, conventions: 0.8, observations: 1.2 },
  reviewing: { conventions: 2.0, decisions: 1.5, lessons: 1.0, observations: 0.5 },
  general: {},
}

/** Category weight multipliers per conversation phase. */
export const PHASE_CATEGORY_WEIGHTS: Record<ConversationPhase, Record<string, number>> = {
  planning: { decision: 2.0, convention: 1.5, lesson: 1.0, observation: 0.7 },
  coding: { convention: 2.0, procedural: 1.8, decision: 1.0, observation: 0.6 },
  debugging: { lesson: 2.5, observation: 2.0, 'causal-edge': 1.8, decision: 1.0 },
  reviewing: { convention: 2.0, decision: 1.5, lesson: 1.0, observation: 0.5 },
  general: {},
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStr(
  table: Table,
  columnName: string,
  row: number,
): string | null {
  const col = table.getChild(columnName)
  if (!col) return null
  const raw: unknown = col.get(row)
  if (raw === null || raw === undefined) return null
  return String(raw)
}

// ---------------------------------------------------------------------------
// phaseWeightedSelection
// ---------------------------------------------------------------------------

/**
 * Select memories optimized for current conversation phase.
 *
 * Reads namespace and category columns (dictionary-encoded), multiplies each
 * record's composite score by the phase weight, then greedily selects within
 * the token budget.
 *
 * @param table       Arrow Table conforming to MEMORY_FRAME_SCHEMA
 * @param currentPhase Current conversation phase
 * @param tokenBudget Maximum tokens to select
 * @param options     Optional overrides for weights and parameters
 * @returns Array of scored records that fit within the budget
 */
export function phaseWeightedSelection(
  table: Table,
  currentPhase: ConversationPhase,
  tokenBudget: number,
  options?: {
    namespaceWeights?: Record<string, number>
    categoryWeights?: Record<string, number>
    charsPerToken?: number
    now?: number
  },
): ScoredRecord[] {
  try {
    if (table.numRows === 0 || tokenBudget <= 0) {
      return []
    }

    const now = options?.now ?? Date.now()
    const charsPerToken = options?.charsPerToken ?? 4

    // Resolve phase weights (custom overrides > default phase weights)
    const nsWeights = options?.namespaceWeights ?? PHASE_NAMESPACE_WEIGHTS[currentPhase]
    const catWeights = options?.categoryWeights ?? PHASE_CATEGORY_WEIGHTS[currentPhase]

    // 1. Compute base composite scores
    const baseScores = computeCompositeScore(
      table,
      { decay: 0.3, importance: 0.3, recency: 0.3 },
      now,
    )

    // 2. Estimate tokens per row
    const tokenEstimates = batchTokenEstimate(table, charsPerToken)

    // 3. Build scored records with phase adjustments
    const candidates: ScoredRecord[] = []

    for (let i = 0; i < table.numRows; i++) {
      const baseScore = baseScores[i] ?? 0

      // Look up phase multiplier from namespace, then fall back to category
      let phaseMultiplier = 1.0
      const ns = readStr(table, 'namespace', i)
      const cat = readStr(table, 'category', i)

      if (ns !== null && ns in nsWeights) {
        phaseMultiplier = nsWeights[ns] ?? 1.0
      }

      // Category weight stacks multiplicatively with namespace weight
      if (cat !== null && cat in catWeights) {
        const catMultiplier = catWeights[cat] ?? 1.0
        phaseMultiplier *= catMultiplier
      }

      const adjustedScore = baseScore * phaseMultiplier
      const tokenCost = Math.max(1, tokenEstimates[i] ?? 1)

      candidates.push({ rowIndex: i, score: adjustedScore, tokenCost })
    }

    // 4. Sort by score/tokenCost ratio (efficiency), descending
    candidates.sort((a, b) => (b.score / b.tokenCost) - (a.score / a.tokenCost))

    // 5. Greedy selection within budget
    const selected: ScoredRecord[] = []
    let remaining = tokenBudget
    for (const candidate of candidates) {
      if (candidate.tokenCost <= remaining) {
        selected.push(candidate)
        remaining -= candidate.tokenCost
      }
    }

    // Sort by original row index to preserve document order
    selected.sort((a, b) => a.rowIndex - b.rowIndex)
    return selected
  } catch {
    return []
  }
}
