/**
 * CompactionStrategy -- determines when and how to compact session context
 * to stay within provider token budgets.
 *
 * Providers have varying support for native session compaction. This module
 * encapsulates the decision logic and request shape so callers can ask
 * "should I compact?" and get a ready-to-use compaction request.
 *
 * @example
 * ```ts
 * const strategy = new DefaultCompactionStrategy()
 * if (strategy.shouldCompact('claude', session, turnCount, tokenCount)) {
 *   const req = strategy.getCompactionRequest(session.sessionId)
 *   // ... execute compaction via adapter or summarizer
 * }
 * ```
 */

import type { AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal session information needed for compaction decisions. */
export interface CompactionSessionInfo {
  sessionId: string
  providerId: AdapterProviderId
  turnCount: number
  estimatedTokenCount: number
}

/** The type of compaction to perform. */
export type CompactionType = 'summarize' | 'truncate' | 'checkpoint'

/** A compaction request to be executed by the caller. */
export interface CompactionRequest {
  sessionId: string
  strategy: CompactionType
  /** Target token count after compaction (optional hint). */
  targetTokenBudget?: number
}

/** Contract for compaction decision logic. */
export interface CompactionStrategy {
  /**
   * Whether the given provider supports any form of context compaction.
   */
  canCompact(provider: AdapterProviderId): boolean

  /**
   * Whether compaction should be triggered given current session state.
   *
   * @param provider   - The adapter provider
   * @param session    - Current session info
   * @param turnCount  - Number of conversation turns so far
   * @param tokenCount - Estimated total tokens consumed
   */
  shouldCompact(
    provider: AdapterProviderId,
    session: CompactionSessionInfo,
    turnCount: number,
    tokenCount: number,
  ): boolean

  /**
   * Build a compaction request for the given session.
   * Caller should invoke this only after {@link shouldCompact} returns true.
   */
  getCompactionRequest(sessionId: string): CompactionRequest
}

// ---------------------------------------------------------------------------
// Provider capability map
// ---------------------------------------------------------------------------

interface ProviderCompactionCapability {
  /** Whether the provider supports any compaction mechanism. */
  supportsCompaction: boolean
  /** Preferred compaction type for this provider. */
  preferredStrategy: CompactionType
  /** Maximum context window size in tokens (approximate). */
  maxContextTokens: number
}

const PROVIDER_COMPACTION_MAP: Record<AdapterProviderId, ProviderCompactionCapability> = {
  claude: {
    supportsCompaction: true,
    preferredStrategy: 'summarize',
    maxContextTokens: 200_000,
  },
  codex: {
    supportsCompaction: true,
    preferredStrategy: 'summarize',
    maxContextTokens: 200_000,
  },
  gemini: {
    supportsCompaction: true,
    preferredStrategy: 'summarize',
    maxContextTokens: 1_000_000,
  },
  'gemini-sdk': {
    supportsCompaction: true,
    preferredStrategy: 'summarize',
    maxContextTokens: 1_000_000,
  },
  qwen: {
    supportsCompaction: false,
    preferredStrategy: 'truncate',
    maxContextTokens: 32_000,
  },
  crush: {
    supportsCompaction: false,
    preferredStrategy: 'truncate',
    maxContextTokens: 32_000,
  },
  goose: {
    supportsCompaction: true,
    preferredStrategy: 'checkpoint',
    maxContextTokens: 128_000,
  },
  openrouter: {
    supportsCompaction: false,
    preferredStrategy: 'truncate',
    maxContextTokens: 128_000,
  },
  openai: {
    supportsCompaction: false,
    preferredStrategy: 'truncate',
    maxContextTokens: 128_000,
  },
}

// ---------------------------------------------------------------------------
// DefaultCompactionStrategy
// ---------------------------------------------------------------------------

/** Configuration for {@link DefaultCompactionStrategy}. */
export interface DefaultCompactionConfig {
  /**
   * Trigger compaction when token usage exceeds this fraction of max context.
   * @default 0.8
   */
  tokenThresholdRatio?: number
  /**
   * Trigger compaction when turn count exceeds this value.
   * @default 50
   */
  maxTurnsBeforeCompaction?: number
  /**
   * Target token budget as a fraction of max context after compaction.
   * @default 0.5
   */
  targetBudgetRatio?: number
}

/**
 * Default compaction strategy with sensible thresholds.
 *
 * Triggers compaction when either:
 * - Token usage exceeds 80% of the provider's max context window, OR
 * - Turn count exceeds 50 turns
 *
 * Uses the provider's preferred compaction type and aims to reduce
 * context to 50% of the max window.
 */
export class DefaultCompactionStrategy implements CompactionStrategy {
  private readonly tokenThresholdRatio: number
  private readonly maxTurnsBeforeCompaction: number
  private readonly targetBudgetRatio: number

  /** Stores the last provider seen by shouldCompact for getCompactionRequest. */
  private lastProvider: AdapterProviderId = 'claude'

  constructor(config: DefaultCompactionConfig = {}) {
    this.tokenThresholdRatio = config.tokenThresholdRatio ?? 0.8
    this.maxTurnsBeforeCompaction = config.maxTurnsBeforeCompaction ?? 50
    this.targetBudgetRatio = config.targetBudgetRatio ?? 0.5
  }

  canCompact(provider: AdapterProviderId): boolean {
    return PROVIDER_COMPACTION_MAP[provider].supportsCompaction
  }

  shouldCompact(
    provider: AdapterProviderId,
    _session: CompactionSessionInfo,
    turnCount: number,
    tokenCount: number,
  ): boolean {
    this.lastProvider = provider
    const caps = PROVIDER_COMPACTION_MAP[provider]

    const tokenThreshold = caps.maxContextTokens * this.tokenThresholdRatio
    if (tokenCount >= tokenThreshold) return true

    if (turnCount >= this.maxTurnsBeforeCompaction) return true

    return false
  }

  getCompactionRequest(sessionId: string): CompactionRequest {
    const caps = PROVIDER_COMPACTION_MAP[this.lastProvider]
    return {
      sessionId,
      strategy: caps.preferredStrategy,
      targetTokenBudget: Math.round(caps.maxContextTokens * this.targetBudgetRatio),
    }
  }
}
