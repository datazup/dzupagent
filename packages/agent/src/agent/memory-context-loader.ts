import type { BaseMessage } from '@langchain/core/messages'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'
import type { FrozenSnapshot } from '@dzupagent/context'
import { estimateTokens } from '@dzupagent/core'
import { calculateStrength } from '@dzupagent/memory'
import type { DecayMetadata } from '@dzupagent/memory'

import type { DzupAgentConfig } from './agent-types.js'
import { resolveArrowMemoryConfig } from './memory-profiles.js'

/**
 * Thrown when an Arrow memory configuration is supplied but no
 * `loadArrowRuntime` injector was provided. The dynamic
 * `await import('@dzupagent/memory-ipc')` was removed in ADR-0005 to keep
 * the agent's runtime dependency surface explicit.
 */
class ArrowRuntimeNotInjectedError extends Error {
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
function defaultMemoryRanker(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const now = Date.now()
  return [...records].sort((a, b) => {
    const aMeta = a['_decay'] as DecayMetadata | undefined
    const bMeta = b['_decay'] as DecayMetadata | undefined
    const aStrength = aMeta ? calculateStrength(aMeta, now) : 0.5
    const bStrength = bMeta ? calculateStrength(bMeta, now) : 0.5
    return bStrength - aStrength
  })
}

type AgentMemoryService = NonNullable<DzupAgentConfig['memory']>
type ResolvedArrowMemoryConfig = NonNullable<ReturnType<typeof resolveArrowMemoryConfig>>
type StandardMemoryBudgetConfig = Required<
  Pick<
    ResolvedArrowMemoryConfig,
    'totalBudget' | 'maxMemoryFraction' | 'minResponseReserve'
  >
>

const DEFAULT_ARROW_FAILURE_FALLBACK_MAX_TOKENS = 4_000
const FALLBACK_CHARS_PER_TOKEN = 4
const DEFAULT_STANDARD_MEMORY_MAX_ITEMS = 10
const DEFAULT_STANDARD_MEMORY_MAX_CHARS_PER_ITEM = 2_000
const DEFAULT_STANDARD_MEMORY_BUDGET_CONFIG: StandardMemoryBudgetConfig = {
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

interface ArrowMemoryRecord {
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

/**
 * Default Arrow runtime loader.
 *
 * ADR-0005 made the loader a first-class injectable: callers SHOULD pass
 * `config.loadArrowRuntime` (typically `() => import('@dzupagent/memory-ipc')`)
 * so the dependency is visible at the construction site. For backwards
 * compatibility this default retains a dynamic import behind a runtime
 * feature flag so existing call-sites and tests that rely on
 * `vi.mock('@dzupagent/memory-ipc', ...)` continue to work unchanged.
 *
 * Set `DZUPAGENT_REQUIRE_ARROW_INJECTION=1` to enforce explicit injection;
 * the loader will throw `ArrowRuntimeNotInjectedError` instead of falling
 * back to dynamic import. This flag will become the default in a future
 * major release.
 */
async function defaultLoadArrowRuntime(): Promise<ArrowMemoryRuntime> {
  if (
    typeof process !== 'undefined' &&
    process.env != null &&
    process.env['DZUPAGENT_REQUIRE_ARROW_INJECTION'] === '1'
  ) {
    throw new ArrowRuntimeNotInjectedError()
  }
  // Back-compat dynamic import (ADR-0005). The module name is held in a
  // local variable so the loader source can be statically scanned for
  // unintended dynamic imports of memory-ipc.
  const moduleName = '@dzupagent/memory-ipc'
  return (await import(moduleName)) as unknown as ArrowMemoryRuntime
}

export class AgentMemoryContextLoader {
  private readonly loadArrowRuntime: () => Promise<ArrowMemoryRuntime>
  private readonly arrowFailureFallbackMaxTokens: number
  private readonly standardMemoryMaxItems: number
  private readonly standardMemoryMaxCharsPerItem: number
  private readonly standardMemoryBudgetConfig: StandardMemoryBudgetConfig

  constructor(private readonly config: AgentMemoryContextLoaderConfig) {
    this.loadArrowRuntime = config.loadArrowRuntime ?? defaultLoadArrowRuntime

    const limits = config.limits ?? {}
    this.arrowFailureFallbackMaxTokens =
      limits.arrowFallbackMaxTokens ?? DEFAULT_ARROW_FAILURE_FALLBACK_MAX_TOKENS
    this.standardMemoryMaxItems =
      limits.standardMaxItems ?? DEFAULT_STANDARD_MEMORY_MAX_ITEMS
    this.standardMemoryMaxCharsPerItem =
      limits.standardMaxCharsPerItem ?? DEFAULT_STANDARD_MEMORY_MAX_CHARS_PER_ITEM
    this.standardMemoryBudgetConfig = {
      totalBudget:
        limits.standardTotalBudget ?? DEFAULT_STANDARD_MEMORY_BUDGET_CONFIG.totalBudget,
      maxMemoryFraction:
        limits.standardMaxMemoryFraction ??
        DEFAULT_STANDARD_MEMORY_BUDGET_CONFIG.maxMemoryFraction,
      minResponseReserve:
        limits.standardMinResponseReserve ??
        DEFAULT_STANDARD_MEMORY_BUDGET_CONFIG.minResponseReserve,
    }
  }

  async load(
    messages: BaseMessage[],
    memoryReadContext: AgentMemoryReadContext | undefined = this.config.memoryReadContext,
  ): Promise<{ context: string | null; frame?: unknown }> {
    const memory = this.config.memory
    const scope = this.config.memoryScope
    const namespace = this.config.memoryNamespace

    if (!memory || !scope || !namespace) {
      return { context: null }
    }

    // Frozen snapshot optimization: skip reload when cache prefix is stable.
    // Returns the cached context immediately, preserving Anthropic prompt-cache
    // prefix hits across agent iterations.
    if (this.config.frozenSnapshot?.isActive()) {
      return { context: this.config.frozenSnapshot.get() }
    }

    const resolvedArrowConfig = resolveArrowMemoryConfig(
      this.config.arrowMemory,
      this.config.memoryProfile,
    )

    if (resolvedArrowConfig) {
      try {
        const result = await this.loadArrowMemoryContext(
          memory,
          namespace,
          scope,
          messages,
          resolvedArrowConfig,
        )
        // Freeze snapshot after a successful Arrow load so subsequent calls
        // can short-circuit to the cached context.
        if (result.context !== null) {
          this.config.frozenSnapshot?.freeze(result.context, result.frame)
        }
        return result
      } catch (err) {
        // Fall back to the standard path if Arrow selection fails.
        // Emit structured reason so operators can distinguish absence from outage.
        // Tokens before = estimated conversation+system before fallback;
        // tokensAfter is unknown until the standard path runs, so emit 0
        // as a non-leaking placeholder.
        const reason = err instanceof Error ? err.message : String(err)
        const tokensBefore = this.safeEstimateInputTokens(messages)
        this.config.onFallback?.('arrow_fallback', tokensBefore, 0)
        this.config.onFallbackDetail?.({
          reason: 'arrow_runtime_failure',
          detail: reason,
          namespace: this.safeNamespace(namespace),
          provider: 'arrow',
          tokensBefore,
          tokensAfter: 0,
        })
        return await this.loadBoundedStandardMemoryContext(
          memory,
          namespace,
          scope,
          messages,
          resolvedArrowConfig,
          memoryReadContext,
        )
      }
    }

    return await this.loadStandardMemoryContext(
      memory,
      namespace,
      scope,
      messages,
      memoryReadContext,
    )
  }

  private async loadStandardMemoryContext(
    memory: AgentMemoryService,
    namespace: string,
    scope: Record<string, string>,
    messages: BaseMessage[],
    memoryReadContext?: AgentMemoryReadContext,
  ): Promise<{ context: string | null }> {
    const records = memoryReadContext
      ? await memory.get(namespace, scope, undefined, memoryReadContext)
      : await memory.get(namespace, scope)
    return this.formatStandardMemoryContext(
      memory,
      records,
      messages,
      this.standardMemoryBudgetConfig,
    )
  }

  private async loadBoundedStandardMemoryContext(
    memory: AgentMemoryService,
    namespace: string,
    scope: Record<string, string>,
    messages: BaseMessage[],
    arrowCfg: ResolvedArrowMemoryConfig,
    memoryReadContext?: AgentMemoryReadContext,
  ): Promise<{ context: string | null }> {
    const records = memoryReadContext
      ? await memory.get(namespace, scope, undefined, memoryReadContext)
      : await memory.get(namespace, scope)

    return this.formatStandardMemoryContext(
      memory,
      records,
      messages,
      arrowCfg,
      this.arrowFailureFallbackMaxTokens,
    )
  }

  private formatStandardMemoryContext(
    memory: AgentMemoryService,
    records: Record<string, unknown>[],
    messages: BaseMessage[],
    budgetCfg: ResolvedArrowMemoryConfig,
    maxMemoryBudget?: number,
  ): { context: string | null } {
    if (records.length === 0) {
      return { context: null }
    }

    // Apply ranker before budget truncation so the strongest memories survive.
    const ranker = this.config.memoryRanker ?? defaultMemoryRanker
    const ranked = ranker(records)

    const memoryBudget = this.safeComputeMemoryBudget(messages, budgetCfg, maxMemoryBudget)
    if (memoryBudget === undefined) {
      return { context: memory.formatForPrompt(ranked) || null }
    }
    if (memoryBudget <= 0) {
      return { context: null }
    }

    const bounds = this.deriveStandardMemoryPromptBounds(memoryBudget, ranked.length)
    if (!bounds) {
      return { context: null }
    }

    const context = memory.formatForPrompt(ranked, bounds) || null

    return {
      context: this.boundContextToTokenBudget(context, memoryBudget),
    }
  }

  /**
   * Estimate the input token cost (system prompt + conversation) without
   * touching memory content. Used purely for telemetry; never leaks
   * scope keys/values or stored records.
   */
  private safeEstimateInputTokens(messages: BaseMessage[]): number {
    try {
      const systemTokens = estimateTokens(this.config.instructions)
      const conversationTokens = this.config.estimateConversationTokens(messages)
      return systemTokens + conversationTokens
    } catch {
      return 0
    }
  }

  /**
   * Return a redacted namespace label safe for telemetry. The namespace is
   * a logical bucket name (e.g. 'facts', 'episodic') and never a secret in
   * the framework, but we cap the length defensively in case operators
   * choose unconventional values.
   */
  private safeNamespace(namespace: string | undefined): string {
    if (!namespace) return 'unknown'
    return namespace.length > 64 ? `${namespace.slice(0, 64)}...` : namespace
  }

  private computeMemoryBudget(
    messages: BaseMessage[],
    arrowCfg: ResolvedArrowMemoryConfig,
  ): {
    memoryBudget: number
    totalBudget: number
    maxMemoryFraction: number
    minResponseReserve: number
    systemPromptTokens: number
    conversationTokens: number
  } {
    const totalBudget = arrowCfg.totalBudget ?? 128_000
    const maxMemoryFraction = arrowCfg.maxMemoryFraction ?? 0.3
    const minResponseReserve = arrowCfg.minResponseReserve ?? 4_000
    const systemPromptTokens = estimateTokens(this.config.instructions)
    const conversationTokens = this.config.estimateConversationTokens(messages)
    const remaining = totalBudget - systemPromptTokens - conversationTokens - minResponseReserve
    const memoryBudget = Math.max(0, Math.min(
      Math.floor(remaining),
      Math.floor(totalBudget * maxMemoryFraction),
    ))

    return {
      memoryBudget,
      totalBudget,
      maxMemoryFraction,
      minResponseReserve,
      systemPromptTokens,
      conversationTokens,
    }
  }

  private safeComputeMemoryBudget(
    messages: BaseMessage[],
    budgetCfg: ResolvedArrowMemoryConfig,
    maxMemoryBudget?: number,
  ): number | undefined {
    try {
      const memoryBudget = this.computeMemoryBudget(messages, budgetCfg).memoryBudget
      return maxMemoryBudget === undefined
        ? memoryBudget
        : Math.min(memoryBudget, maxMemoryBudget)
    } catch {
      return undefined
    }
  }

  private deriveStandardMemoryPromptBounds(
    memoryBudget: number,
    recordCount: number,
  ): { maxItems: number; maxCharsPerItem: number } | undefined {
    if (memoryBudget <= 0 || recordCount <= 0) {
      return undefined
    }

    const defaultTokensPerItem = Math.ceil(
      this.standardMemoryMaxCharsPerItem / FALLBACK_CHARS_PER_TOKEN,
    )
    const maxItemsByBudget = Math.max(
      1,
      Math.floor(memoryBudget / defaultTokensPerItem),
    )
    const maxItems = Math.max(
      1,
      Math.min(recordCount, this.standardMemoryMaxItems, maxItemsByBudget),
    )
    const maxCharsPerItem = Math.max(
      1,
      Math.min(
        this.standardMemoryMaxCharsPerItem,
        Math.floor((memoryBudget * FALLBACK_CHARS_PER_TOKEN) / maxItems),
      ),
    )

    return { maxItems, maxCharsPerItem }
  }

  private boundContextToTokenBudget(
    context: string | null,
    memoryBudget: number,
  ): string | null {
    if (!context) return null
    if (estimateTokens(context) <= memoryBudget) return context

    let low = 0
    let high = Math.min(context.length, memoryBudget * FALLBACK_CHARS_PER_TOKEN)
    let best = ''

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = context.slice(0, mid)
      if (estimateTokens(candidate) <= memoryBudget) {
        best = candidate
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    return best.trimEnd() || null
  }

  private async loadArrowMemoryContext(
    memory: AgentMemoryService,
    namespace: string,
    scope: Record<string, string>,
    messages: BaseMessage[],
    arrowCfg: ResolvedArrowMemoryConfig,
  ): Promise<{ context: string | null; frame: unknown }> {
    const {
      extendMemoryServiceWithArrow,
      selectMemoriesByBudget,
      phaseWeightedSelection,
      FrameReader,
    } = await this.loadArrowRuntime()

    const arrowExt = extendMemoryServiceWithArrow(
      memory as unknown as MemoryServiceLike,
    )
    const frame = await arrowExt.exportFrame(namespace, scope) as { numRows: number }

    if (frame.numRows === 0) {
      return { context: null, frame }
    }

    const {
      memoryBudget,
      totalBudget,
      maxMemoryFraction,
      minResponseReserve,
      systemPromptTokens,
      conversationTokens,
    } = this.computeMemoryBudget(messages, arrowCfg)

    if (memoryBudget <= 0) {
      const tokensBefore = systemPromptTokens + conversationTokens
      this.config.onFallback?.('budget_zero', tokensBefore, 0)
      this.config.onFallbackDetail?.({
        reason: 'memory_budget_zero',
        // detail uses only numeric estimates — no scope or record content.
        detail:
          `systemPromptTokens=${systemPromptTokens} ` +
          `conversationTokens=${conversationTokens} ` +
          `totalBudget=${totalBudget} ` +
          `minResponseReserve=${minResponseReserve} ` +
          `maxMemoryFraction=${maxMemoryFraction}`,
        namespace: this.safeNamespace(namespace),
        provider: 'arrow',
        tokensBefore,
        tokensAfter: 0,
      })
      return { context: null, frame }
    }

    const phase = arrowCfg.currentPhase
    const selected = phase && phase !== 'general'
      ? phaseWeightedSelection(frame, phase, memoryBudget)
      : selectMemoriesByBudget(frame, memoryBudget)

    if (selected.length === 0) {
      return { context: null, frame }
    }

    const reader = new FrameReader(frame)
    const allRecords = reader.toRecords()
    const lines: string[] = ['## Memory Context']

    for (const candidate of selected) {
      const record = allRecords[candidate.rowIndex]
      if (!record) {
        continue
      }

      const recordNamespace = record.meta.namespace || namespace
      const text = typeof record.value.text === 'string'
        ? record.value.text
        : JSON.stringify(record.value)
      lines.push(`- [${recordNamespace}] ${text}`)
    }

    return { context: lines.join('\n'), frame }
  }
}
