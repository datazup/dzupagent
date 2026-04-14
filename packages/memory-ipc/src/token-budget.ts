/**
 * Token budget analysis and allocation using Arrow Tables.
 *
 * Provides greedy knapsack-style memory selection within a token budget,
 * and a rebalancing allocator that adjusts memory budget as conversation grows.
 */

import { type Table } from 'apache-arrow'
import {
  batchTokenEstimate,
  computeCompositeScore,
} from './columnar-ops.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Weight coefficients for composite scoring dimensions. */
export interface CompositeScoreWeights {
  importance: number   // default: 0.3
  decay: number        // default: 0.3
  recency: number      // default: 0.2
  phase: number        // default: 0.2
}

/** A single scored record with its row index and token cost. */
export interface ScoredRecord {
  rowIndex: number
  score: number
  tokenCost: number
}

/** Result of token budget allocation across context window slots. */
export interface TokenBudgetAllocation {
  memoryTokens: number
  conversationTokens: number
  systemPromptTokens: number
  toolTokens: number
  responseReserve: number
  selectedMemoryIndices: number[]
  totalScore: number
}

/** Configuration for the TokenBudgetAllocator. */
export interface TokenBudgetAllocatorConfig {
  totalBudget: number
  systemPromptTokens: number
  toolTokens: number
  memoryFrame: Table
  maxMemoryFraction?: number    // default: 0.3
  minResponseReserve?: number   // default: 4000
  phaseWeights?: Record<string, number>
}

// ---------------------------------------------------------------------------
// Default weights
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS: CompositeScoreWeights = {
  importance: 0.3,
  decay: 0.3,
  recency: 0.2,
  phase: 0.2,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a string value from a column at a given row index.
 */
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
// selectMemoriesByBudget
// ---------------------------------------------------------------------------

/**
 * Select records from a MemoryFrame that fit within a token budget.
 *
 * Algorithm:
 * 1. Compute composite score per row (importance, decay, recency).
 * 2. Apply phase weights from namespace/category if provided.
 * 3. Estimate tokens per row.
 * 4. Sort by score/tokenCost ratio (efficiency).
 * 5. Greedily select until budget exhausted.
 */
export function selectMemoriesByBudget(
  table: Table,
  tokenBudget: number,
  options?: {
    weights?: Partial<CompositeScoreWeights>
    phaseWeights?: Record<string, number>
    now?: number
    charsPerToken?: number
    minScore?: number
  },
): ScoredRecord[] {
  try {
    if (table.numRows === 0 || tokenBudget <= 0) {
      return []
    }

    const weights: CompositeScoreWeights = {
      ...DEFAULT_WEIGHTS,
      ...options?.weights,
    }
    const now = options?.now ?? Date.now()
    const charsPerToken = options?.charsPerToken ?? 4
    const minScore = options?.minScore ?? 0
    const phaseWeights = options?.phaseWeights

    // 1. Compute base composite scores using columnar-ops
    const baseScores = computeCompositeScore(
      table,
      { decay: weights.decay, importance: weights.importance, recency: weights.recency },
      now,
    )

    // 2. Estimate tokens per row
    const tokenEstimates = batchTokenEstimate(table, charsPerToken)

    // 3. Build scored records with phase adjustments
    const candidates: ScoredRecord[] = []
    for (let i = 0; i < table.numRows; i++) {
      let score = baseScores[i] ?? 0

      // Apply phase weight multiplier based on namespace or category
      if (phaseWeights && weights.phase > 0) {
        const ns = readStr(table, 'namespace', i)
        const cat = readStr(table, 'category', i)
        let phaseMultiplier = 1.0
        if (ns !== null && ns in phaseWeights) {
          phaseMultiplier = phaseWeights[ns] ?? 1.0
        } else if (cat !== null && cat in phaseWeights) {
          phaseMultiplier = phaseWeights[cat] ?? 1.0
        }
        // Blend phase weight into score
        score = score * (1 - weights.phase) + score * phaseMultiplier * weights.phase
      }

      if (score < minScore) continue

      const tokenCost = tokenEstimates[i] ?? 1
      candidates.push({ rowIndex: i, score, tokenCost: Math.max(1, tokenCost) })
    }

    // 4. Sort by score/tokenCost ratio (efficiency), descending
    candidates.sort((a, b) => (b.score / b.tokenCost) - (a.score / a.tokenCost))

    // 5. Greedy selection
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

// ---------------------------------------------------------------------------
// TokenBudgetAllocator
// ---------------------------------------------------------------------------

/**
 * Token budget allocator. Rebalances memory budget as conversation grows.
 *
 * Fixed slots (system prompt, tools, response reserve) are subtracted first.
 * The remaining budget is split between conversation and memory, with memory
 * capped at maxMemoryFraction of the total.
 */
export class TokenBudgetAllocator {
  private frame: Table
  private readonly config: Required<Omit<TokenBudgetAllocatorConfig, 'memoryFrame'>>

  constructor(config: TokenBudgetAllocatorConfig) {
    this.frame = config.memoryFrame
    this.config = {
      totalBudget: config.totalBudget,
      systemPromptTokens: config.systemPromptTokens,
      toolTokens: config.toolTokens,
      maxMemoryFraction: config.maxMemoryFraction ?? 0.3,
      minResponseReserve: config.minResponseReserve ?? 4000,
      phaseWeights: config.phaseWeights ?? {},
    }
  }

  /**
   * Rebalance given current conversation size.
   *
   * Allocation order:
   * 1. System prompt (fixed)
   * 2. Tools (fixed)
   * 3. Response reserve (fixed minimum)
   * 4. Conversation tokens (given)
   * 5. Memory tokens (remainder, capped at maxMemoryFraction * totalBudget)
   */
  rebalance(conversationTokens: number): TokenBudgetAllocation {
    try {
      const { totalBudget, systemPromptTokens, toolTokens, minResponseReserve, maxMemoryFraction } = this.config

      // Fixed allocations
      const fixedCost = systemPromptTokens + toolTokens + minResponseReserve
      const availableForConvAndMem = Math.max(0, totalBudget - fixedCost)

      // Conversation gets what it needs (up to available)
      const actualConversation = Math.min(conversationTokens, availableForConvAndMem)

      // Memory gets the remainder, capped at max fraction
      const maxMemoryTokens = Math.floor(totalBudget * maxMemoryFraction)
      const remainingAfterConv = Math.max(0, availableForConvAndMem - actualConversation)
      const memoryBudget = Math.min(remainingAfterConv, maxMemoryTokens)

      // Select memories within budget
      const selected = selectMemoriesByBudget(this.frame, memoryBudget, {
        phaseWeights: this.config.phaseWeights,
      })

      const actualMemoryTokens = selected.reduce((sum, r) => sum + r.tokenCost, 0)
      const totalScore = selected.reduce((sum, r) => sum + r.score, 0)

      // Response reserve gets any slack
      const used = systemPromptTokens + toolTokens + actualConversation + actualMemoryTokens
      const responseReserve = Math.max(minResponseReserve, totalBudget - used)

      return {
        memoryTokens: actualMemoryTokens,
        conversationTokens: actualConversation,
        systemPromptTokens,
        toolTokens,
        responseReserve,
        selectedMemoryIndices: selected.map((r) => r.rowIndex),
        totalScore,
      }
    } catch {
      return {
        memoryTokens: 0,
        conversationTokens: 0,
        systemPromptTokens: this.config.systemPromptTokens,
        toolTokens: this.config.toolTokens,
        responseReserve: this.config.minResponseReserve,
        selectedMemoryIndices: [],
        totalScore: 0,
      }
    }
  }

  /** Update the memory frame (e.g. after new memories written). */
  updateFrame(newFrame: Table): void {
    this.frame = newFrame
  }
}
