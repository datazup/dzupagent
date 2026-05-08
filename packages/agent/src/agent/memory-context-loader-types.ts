import type { BaseMessage } from '@langchain/core/messages'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'
import type { FrozenSnapshot } from '@dzupagent/context'
import { calculateStrength } from '@dzupagent/memory'
import type { DecayMetadata } from '@dzupagent/memory'

import type { DzupAgentConfig } from './agent-types.js'
import type { ArrowMemoryConfig } from './arrow-memory-types.js'

/**
 * Thrown when an Arrow memory configuration is supplied but no
 * `loadArrowRuntime` injector was provided. The dynamic
 * `await import('@dzupagent/memory-ipc')` was removed in ADR-0005 to keep
 * the agent's runtime dependency surface explicit.
 */
export class ArrowRuntimeNotInjectedError extends Error {
  constructor() {
    super(
      'Arrow memory runtime is not injected. Pass ' +
        '`loadArrowRuntime` (e.g. `() => import("@dzupagent/memory-ipc")`) ' +
        'to AgentMemoryContextLoader or DzupAgent. See ADR-0005.',
    )
    this.name = 'ArrowRuntimeNotInjectedError'
  }
}

/** Default ranker: sort records by decay strength, strongest first. */
export function defaultMemoryRanker(
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  const now = Date.now()
  return [...records].sort((a, b) => {
    const aMeta = a['_decay'] as DecayMetadata | undefined
    const bMeta = b['_decay'] as DecayMetadata | undefined
    const aStrength = aMeta ? calculateStrength(aMeta, now) : 0.5
    const bStrength = bMeta ? calculateStrength(bMeta, now) : 0.5
    return bStrength - aStrength
  })
}

export type AgentMemoryService = NonNullable<DzupAgentConfig['memory']>
export type ResolvedArrowMemoryConfig = ArrowMemoryConfig
export type StandardMemoryBudgetConfig = Required<
  Pick<
    ResolvedArrowMemoryConfig,
    'totalBudget' | 'maxMemoryFraction' | 'minResponseReserve'
  >
>

export const DEFAULT_ARROW_FAILURE_FALLBACK_MAX_TOKENS = 4_000
export const FALLBACK_CHARS_PER_TOKEN = 4
export const DEFAULT_STANDARD_MEMORY_MAX_ITEMS = 10
export const DEFAULT_STANDARD_MEMORY_MAX_CHARS_PER_ITEM = 2_000
export const DEFAULT_STANDARD_MEMORY_BUDGET_CONFIG: StandardMemoryBudgetConfig = {
  totalBudget: 128_000,
  maxMemoryFraction: 0.3,
  minResponseReserve: 4_000,
}

/**
 * Per-agent overrides for the in-loader memory-budget limits (audit M-08).
 *
 * Each field is optional; omitted fields fall back to the package-level
 * defaults preserved from before the audit fix so existing callers see no
 * behaviour change.
 */
export interface AgentMemoryContextLoaderLimits {
  /**
   * Token budget reserved for the standard (non-Arrow) memory path.
   *
   * Maps to {@link ResolvedArrowMemoryConfig.totalBudget}. Default 128_000.
   */
  standardTotalBudget?: number
  /**
   * Maximum fraction of `standardTotalBudget` the loader may spend on
   * memory context. Default 0.3.
   */
  standardMaxMemoryFraction?: number
  /**
   * Minimum response token reserve subtracted from the standard budget.
   * Default 4_000.
   */
  standardMinResponseReserve?: number
  /**
   * Hard cap on records emitted into the prompt by the standard path.
   * Default 10.
   */
  standardMaxItems?: number
  /**
   * Hard cap on per-record character length emitted into the prompt by
   * the standard path. Default 2_000.
   */
  standardMaxCharsPerItem?: number
  /**
   * Token cap applied when the Arrow path fails and the loader falls back
   * to the standard path. Default 4_000.
   */
  arrowFallbackMaxTokens?: number
}

export interface ArrowMemoryRecord {
  value: Record<string, unknown>
  meta: {
    namespace?: string
  }
}

export interface ArrowMemoryRuntime {
  extendMemoryServiceWithArrow: (
    memory: MemoryServiceLike,
  ) => {
    exportFrame: (
      namespace: string,
      scope: Record<string, string>,
    ) => Promise<unknown>
  }
  selectMemoriesByBudget: (
    frame: unknown,
    memoryBudget: number,
  ) => Array<{ rowIndex: number }>
  phaseWeightedSelection: (
    frame: unknown,
    phase: NonNullable<ResolvedArrowMemoryConfig['currentPhase']>,
    memoryBudget: number,
  ) => Array<{ rowIndex: number }>
  FrameReader: new (frame: unknown) => {
    toRecords(): ArrowMemoryRecord[]
  }
}

export interface AgentMemoryContextLoaderConfig {
  instructions: string
  memory?: DzupAgentConfig['memory']
  memoryNamespace?: string
  memoryScope?: Record<string, string>
  /**
   * Optional run context for provenance/reference tracking on memory reads.
   * Contains only stable identifiers; prompt text and memory content are not
   * copied into provenance metadata.
   */
  memoryReadContext?: AgentMemoryReadContext
  arrowMemory?: DzupAgentConfig['arrowMemory']
  memoryProfile?: DzupAgentConfig['memoryProfile']
  estimateConversationTokens: (messages: BaseMessage[]) => number
  loadArrowRuntime?: () => Promise<ArrowMemoryRuntime>
  /**
   * Telemetry callback invoked when the Arrow memory path falls back to the
   * standard memory path, or when the computed memory budget is zero.
   */
  onFallback?: (reason: string, before: number, after: number) => void
  /**
   * Structured diagnostic callback with richer context than onFallback.
   * Receives reason code, human-readable detail, provider label, namespace,
   * and optional token estimates. Never receives raw scope keys/values or
   * memory record content.
   */
  onFallbackDetail?: (event: {
    reason: string
    detail: string
    namespace: string
    /** Provider label such as 'arrow' or 'standard'. */
    provider?: string
    tokensBefore?: number
    tokensAfter?: number
  }) => void
  /**
   * Optional frozen snapshot for prompt-cache optimization.
   * When set and not invalidated, skips memory reload and returns cached context.
   */
  frozenSnapshot?: FrozenSnapshot
  /**
   * Optional memory record ranker (RF-10 / AG-07).
   *
   * Called on the raw record list before the token budget bound is applied.
   * Defaults to decay-strength ordering (strongest/freshest records first)
   * so the most relevant memories are included when the budget truncates.
   *
   * Pass `(records) => records` to disable ranking.
   */
  memoryRanker?: (records: Record<string, unknown>[]) => Record<string, unknown>[]
  /**
   * Per-agent overrides for the in-loader memory-budget limits (audit M-08).
   *
   * When omitted, the loader uses the package-level defaults
   * (128 K token total budget, 30 % memory fraction, 4 K response reserve,
   * 10 items max, 2 000 chars/item, 4 K Arrow-fallback ceiling).
   * Pass any subset of fields to tune limits per agent instance.
   */
  limits?: AgentMemoryContextLoaderLimits
}

export interface AgentMemoryReadContext {
  runId: string
}
