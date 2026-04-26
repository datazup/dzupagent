/**
 * Context-aware routing strategy.
 *
 * Estimates context size from prompt content and injected context chunks,
 * then routes to providers with sufficient context windows. Also provides
 * middleware for injecting contextual data into prompts.
 */

import type {
  AdapterProviderId,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextEstimate {
  /** Estimated input tokens */
  inputTokens: number
  /** Estimated output tokens (rough heuristic) */
  outputTokens: number
  /** Total estimated tokens */
  totalTokens: number
  /** Whether this fits in the provider's context window */
  fitsInContext: boolean
  /** Recommended provider based on context needs */
  recommendedProvider?: AdapterProviderId | undefined
}

export interface ContextAwareRouterConfig {
  /** Provider context window sizes (override defaults) */
  contextWindows?: Partial<Record<AdapterProviderId, number>> | undefined
  /** Safety margin -- reserve this percentage of context window. Default 0.2 (20%) */
  safetyMargin?: number | undefined
  /** Default estimated output tokens when unknown. Default 4000 */
  defaultOutputTokens?: number | undefined
  /** Custom token estimator. Default: ~4 chars per token */
  tokenEstimator?: (text: string) => number
}

export interface ContextInjection {
  /** Label for this context chunk */
  label: string
  /** The content to inject */
  content: string
  /** Priority (higher = injected first if space is tight) */
  priority: number
  /** Whether this is required or can be dropped if budget is tight */
  required?: boolean | undefined
}

export interface ContextInjectionConfig {
  /** Max tokens to use for injected context. Default: 50% of provider's context window */
  maxContextTokens?: number | undefined
  /** Separator between context chunks. Default: '\n\n---\n\n' */
  separator?: string | undefined
  /** Where to inject: 'prepend' (before prompt) or 'system' (as system prompt). Default 'prepend' */
  position?: 'prepend' | 'system'
}

// ---------------------------------------------------------------------------
// Default context windows
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOWS: Record<AdapterProviderId, number> = {
  claude: 200_000,
  codex: 128_000,
  gemini: 1_000_000,
  'gemini-sdk': 1_000_000,
  qwen: 128_000,
  crush: 32_000,
  goose: 128_000,
  openrouter: 200_000,
  openai: 128_000,
}

/**
 * Provider priority order: prefer claude first, then codex, gemini, qwen, crush.
 * Used as a tiebreaker when multiple providers can handle the context.
 */
const PROVIDER_PRIORITY: readonly AdapterProviderId[] = [
  'claude',
  'codex',
  'gemini',
  'qwen',
  'crush',
]

// ---------------------------------------------------------------------------
// Default token estimator
// ---------------------------------------------------------------------------

/**
 * Simple heuristic: ~4 characters per token (average for GPT/Claude tokenizers).
 * Override via config.tokenEstimator for more accurate estimation.
 */
function defaultTokenEstimator(text: string): number {
  return Math.ceil(text.length / 4)
}

// ---------------------------------------------------------------------------
// ContextAwareRouter
// ---------------------------------------------------------------------------

/**
 * Routes tasks to providers based on context window fit.
 *
 * Logic:
 * 1. Estimate context from task prompt + any injected context
 * 2. Filter providers that can handle the estimated context (with safety margin)
 * 3. Among those that fit, prefer by priority: claude > codex > gemini > qwen > crush
 * 4. If no provider fits, route to gemini (largest context window) with a warning
 * 5. Confidence is based on how well the context fits (closer to max = lower confidence)
 */
export class ContextAwareRouter implements TaskRoutingStrategy {
  readonly name = 'context-aware'

  private readonly contextWindows: Record<AdapterProviderId, number>
  private readonly safetyMargin: number
  private readonly defaultOutputTokens: number
  private readonly tokenEstimator: (text: string) => number

  constructor(config?: ContextAwareRouterConfig) {
    this.contextWindows = {
      ...DEFAULT_CONTEXT_WINDOWS,
      ...config?.contextWindows,
    }
    this.safetyMargin = config?.safetyMargin ?? 0.2
    this.defaultOutputTokens = config?.defaultOutputTokens ?? 4000
    this.tokenEstimator = config?.tokenEstimator ?? defaultTokenEstimator
  }

  /** Estimate context requirements for an input */
  estimateContext(input: AgentInput, injections?: ContextInjection[]): ContextEstimate {
    let inputTokens = this.tokenEstimator(input.prompt)

    if (input.systemPrompt) {
      inputTokens += this.tokenEstimator(input.systemPrompt)
    }

    if (injections) {
      for (const injection of injections) {
        inputTokens += this.tokenEstimator(injection.content)
        // Small overhead for the label and separator
        inputTokens += this.tokenEstimator(injection.label) + 10
      }
    }

    const outputTokens = this.defaultOutputTokens
    const totalTokens = inputTokens + outputTokens

    // Find the best-fit provider
    const recommended = this.findRecommendedProvider(totalTokens)

    const fitsInContext = recommended !== undefined

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      fitsInContext,
      recommendedProvider: recommended,
    }
  }

  /** TaskRoutingStrategy.route -- routes based on context window fit */
  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision {
    // Respect explicit preference if available and fits
    if (task.preferredProvider && availableProviders.includes(task.preferredProvider)) {
      const inputTokens = this.tokenEstimator(task.prompt)
      const totalTokens = inputTokens + this.defaultOutputTokens
      const effectiveWindow = this.getEffectiveWindow(task.preferredProvider)

      if (totalTokens <= effectiveWindow) {
        return {
          provider: task.preferredProvider,
          reason: `Preferred provider "${task.preferredProvider}" has sufficient context window`,
          fallbackProviders: availableProviders.filter((p) => p !== task.preferredProvider),
          confidence: 0.95,
        }
      }
    }

    if (availableProviders.length === 0) {
      return {
        provider: 'auto',
        reason: 'No adapters available for context-aware routing',
        fallbackProviders: [],
        confidence: 0,
      }
    }

    const inputTokens = this.tokenEstimator(task.prompt)
    const totalTokens = inputTokens + this.defaultOutputTokens

    // Filter providers that can handle the context
    const fittingProviders = availableProviders.filter((providerId) =>
      this.canHandle(providerId, {
        inputTokens,
        outputTokens: this.defaultOutputTokens,
        totalTokens,
        fitsInContext: true,
      }),
    )

    if (fittingProviders.length > 0) {
      // Sort by priority order
      const sorted = fittingProviders.sort((a, b) => {
        const aIdx = PROVIDER_PRIORITY.indexOf(a)
        const bIdx = PROVIDER_PRIORITY.indexOf(b)
        return aIdx - bIdx
      })

      const best = sorted[0]!
      const effectiveWindow = this.getEffectiveWindow(best)
      const utilization = totalTokens / effectiveWindow
      // Higher utilization = lower confidence (tighter fit)
      const confidence = Math.max(0.4, Math.min(0.95, 1.0 - utilization * 0.6))

      return {
        provider: best,
        reason: `Context fits within ${best} window (${totalTokens} / ${effectiveWindow} tokens, ${Math.round(utilization * 100)}% utilization)`,
        fallbackProviders: sorted.slice(1),
        confidence,
      }
    }

    // No provider fits -- fall back to gemini (largest context window)
    const fallback: AdapterProviderId = availableProviders.includes('gemini')
      ? 'gemini'
      : availableProviders[0]!

    const effectiveWindow = this.getEffectiveWindow(fallback)
    const utilization = totalTokens / effectiveWindow

    return {
      provider: fallback,
      reason: `No provider has sufficient context window for ${totalTokens} tokens; falling back to ${fallback} (${effectiveWindow} effective tokens, ${Math.round(utilization * 100)}% utilization)`,
      fallbackProviders: availableProviders.filter((p) => p !== fallback),
      confidence: Math.max(0.1, 0.4 - (utilization - 1.0) * 0.3),
    }
  }

  /** Check if a specific provider can handle the estimated context */
  canHandle(providerId: AdapterProviderId, estimate: ContextEstimate): boolean {
    const effectiveWindow = this.getEffectiveWindow(providerId)
    return estimate.totalTokens <= effectiveWindow
  }

  /** Get effective context window (after safety margin) for a provider */
  private getEffectiveWindow(providerId: AdapterProviderId): number {
    const rawWindow = this.contextWindows[providerId] ?? 0
    return Math.floor(rawWindow * (1 - this.safetyMargin))
  }

  /** Find the best recommended provider by priority among those that fit */
  private findRecommendedProvider(totalTokens: number): AdapterProviderId | undefined {
    for (const providerId of PROVIDER_PRIORITY) {
      const effectiveWindow = this.getEffectiveWindow(providerId)
      if (totalTokens <= effectiveWindow) {
        return providerId
      }
    }
    return undefined
  }
}

// ---------------------------------------------------------------------------
// ContextInjectionMiddleware
// ---------------------------------------------------------------------------

/**
 * Middleware for injecting contextual data into agent prompts.
 *
 * Manages a queue of context injections (sorted by priority), trims them
 * to fit within token budgets, and applies them to AgentInput objects.
 */
export class ContextInjectionMiddleware {
  private injections: ContextInjection[] = []
  private readonly maxContextTokens: number | undefined
  private readonly separator: string
  private readonly position: 'prepend' | 'system'
  private readonly tokenEstimator: (text: string) => number

  constructor(config?: ContextInjectionConfig, tokenEstimator?: (text: string) => number) {
    this.maxContextTokens = config?.maxContextTokens
    this.separator = config?.separator ?? '\n\n---\n\n'
    this.position = config?.position ?? 'prepend'
    this.tokenEstimator = tokenEstimator ?? defaultTokenEstimator
  }

  /** Add a context injection for the next execution */
  addInjection(injection: ContextInjection): void {
    this.injections.push(injection)
  }

  /** Add multiple injections */
  addInjections(injections: ContextInjection[]): void {
    for (const injection of injections) {
      this.injections.push(injection)
    }
  }

  /** Clear all pending injections */
  clearInjections(): void {
    this.injections = []
  }

  /** Get current injections sorted by priority (descending) */
  getInjections(): ContextInjection[] {
    return [...this.injections].sort((a, b) => b.priority - a.priority)
  }

  /**
   * Apply injections to an AgentInput.
   * Sorts by priority, trims to fit budget, and injects.
   */
  apply(input: AgentInput, maxTokens?: number): AgentInput {
    const sorted = this.getInjections()
    if (sorted.length === 0) {
      return input
    }

    const budget = maxTokens ?? this.maxContextTokens ?? Infinity
    let usedTokens = 0
    const includedChunks: string[] = []

    // First pass: include all required injections
    const required = sorted.filter((inj) => inj.required)
    const optional = sorted.filter((inj) => !inj.required)

    for (const injection of required) {
      const chunkText = `[${injection.label}]\n${injection.content}`
      const tokens = this.tokenEstimator(chunkText)
      // Required injections are always included even if over budget
      usedTokens += tokens
      includedChunks.push(chunkText)
    }

    // Second pass: include optional injections until budget exhausted
    for (const injection of optional) {
      const chunkText = `[${injection.label}]\n${injection.content}`
      const tokens = this.tokenEstimator(chunkText)
      if (usedTokens + tokens <= budget) {
        usedTokens += tokens
        includedChunks.push(chunkText)
      }
    }

    if (includedChunks.length === 0) {
      return input
    }

    const injectedContent = includedChunks.join(this.separator)

    if (this.position === 'system') {
      const existingSystem = input.systemPrompt ?? ''
      const newSystemPrompt = existingSystem
        ? `${existingSystem}${this.separator}${injectedContent}`
        : injectedContent

      return {
        ...input,
        systemPrompt: newSystemPrompt,
      }
    }

    // Default: prepend to prompt
    return {
      ...input,
      prompt: `${injectedContent}${this.separator}${input.prompt}`,
    }
  }

  /**
   * Wrap an adapter execution -- apply injections before yielding events.
   * Returns a modified AgentInput with context injected, respecting the
   * provider's context window via the router.
   */
  enrichInput(
    input: AgentInput,
    providerId: AdapterProviderId,
    router: ContextAwareRouter,
  ): AgentInput {
    // Estimate how much room we have after the base prompt
    const baseEstimate = router.estimateContext(input)
    const providerWindow = this.getProviderContextBudget(providerId, router)

    // Reserve space for the prompt + output; remainder is available for injections
    const availableForInjections = Math.max(0, providerWindow - baseEstimate.totalTokens)

    // Use the smaller of: configured max, or what the provider has room for
    const effectiveBudget = this.maxContextTokens !== undefined
      ? Math.min(this.maxContextTokens, availableForInjections)
      : availableForInjections

    return this.apply(input, effectiveBudget)
  }

  /**
   * Compute the available context budget for a provider, factoring in safety
   * margin via the router's canHandle check. We binary-search for the
   * effective window by using the router's public API.
   */
  private getProviderContextBudget(
    providerId: AdapterProviderId,
    router: ContextAwareRouter,
  ): number {
    // Use canHandle to find the effective window:
    // The effective window is the largest totalTokens that canHandle returns true for
    const contextWindows: Record<AdapterProviderId, number> = {
      claude: 200_000,
      codex: 128_000,
      gemini: 1_000_000,
      'gemini-sdk': 1_000_000,
      qwen: 128_000,
      crush: 32_000,
      goose: 128_000,
      openrouter: 200_000,
      openai: 128_000,
    }
    const rawWindow = contextWindows[providerId] ?? 0

    // Probe the router to find the effective window (with safety margin applied)
    // We test with a synthetic estimate; the router applies its own safety margin
    const probeEstimate: ContextEstimate = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: rawWindow,
      fitsInContext: true,
    }

    // If the full window doesn't fit, reduce by increments
    if (router.canHandle(providerId, probeEstimate)) {
      return rawWindow
    }

    // Binary search for the effective threshold
    let low = 0
    let high = rawWindow
    while (high - low > 100) {
      const mid = Math.floor((low + high) / 2)
      const midEstimate: ContextEstimate = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: mid,
        fitsInContext: true,
      }
      if (router.canHandle(providerId, midEstimate)) {
        low = mid
      } else {
        high = mid
      }
    }
    return low
  }
}
