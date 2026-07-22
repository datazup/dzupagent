/**
 * ContextInjectionMiddleware -- injects contextual data into agent prompts,
 * trimming to fit token budgets.
 *
 * Split out of `context-aware-router.ts` as part of the ARCH-M-06 god-module
 * decomposition.
 */

import type { AdapterProviderId, AgentInput } from "../../types.js";
import { defaultTokenEstimator } from "./context-windows.js";
import type { ContextAwareRouter } from "./router.js";
import type { ContextInjection, ContextInjectionConfig } from "./types.js";

/**
 * Middleware for injecting contextual data into agent prompts.
 *
 * Manages a queue of context injections (sorted by priority), trims them
 * to fit within token budgets, and applies them to AgentInput objects.
 */
export class ContextInjectionMiddleware {
  private injections: ContextInjection[] = [];
  private readonly maxContextTokens: number | undefined;
  private readonly separator: string;
  private readonly position: "prepend" | "system";
  private readonly tokenEstimator: (text: string) => number;

  constructor(
    config?: ContextInjectionConfig,
    tokenEstimator?: (text: string) => number
  ) {
    this.maxContextTokens = config?.maxContextTokens;
    this.separator = config?.separator ?? "\n\n---\n\n";
    this.position = config?.position ?? "prepend";
    this.tokenEstimator = tokenEstimator ?? defaultTokenEstimator;
  }

  /** Add a context injection for the next execution */
  addInjection(injection: ContextInjection): void {
    this.injections.push(injection);
  }

  /** Add multiple injections */
  addInjections(injections: ContextInjection[]): void {
    for (const injection of injections) {
      this.injections.push(injection);
    }
  }

  /** Clear all pending injections */
  clearInjections(): void {
    this.injections = [];
  }

  /** Get current injections sorted by priority (descending) */
  getInjections(): ContextInjection[] {
    return [...this.injections].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Apply injections to an AgentInput.
   * Sorts by priority, trims to fit budget, and injects.
   */
  apply(input: AgentInput, maxTokens?: number): AgentInput {
    const sorted = this.getInjections();
    if (sorted.length === 0) {
      return input;
    }

    const budget = maxTokens ?? this.maxContextTokens ?? Infinity;
    let usedTokens = 0;
    const includedChunks: string[] = [];

    // First pass: include all required injections
    const required = sorted.filter((inj) => inj.required);
    const optional = sorted.filter((inj) => !inj.required);

    for (const injection of required) {
      const chunkText = `[${injection.label}]\n${injection.content}`;
      const tokens = this.tokenEstimator(chunkText);
      // Required injections are always included even if over budget
      usedTokens += tokens;
      includedChunks.push(chunkText);
    }

    // Second pass: include optional injections until budget exhausted
    for (const injection of optional) {
      const chunkText = `[${injection.label}]\n${injection.content}`;
      const tokens = this.tokenEstimator(chunkText);
      if (usedTokens + tokens <= budget) {
        usedTokens += tokens;
        includedChunks.push(chunkText);
      }
    }

    if (includedChunks.length === 0) {
      return input;
    }

    const injectedContent = includedChunks.join(this.separator);

    if (this.position === "system") {
      const existingSystem = input.systemPrompt ?? "";
      const newSystemPrompt = existingSystem
        ? `${existingSystem}${this.separator}${injectedContent}`
        : injectedContent;

      return {
        ...input,
        systemPrompt: newSystemPrompt,
      };
    }

    // Default: prepend to prompt
    return {
      ...input,
      prompt: `${injectedContent}${this.separator}${input.prompt}`,
    };
  }

  /**
   * Wrap an adapter execution -- apply injections before yielding events.
   * Returns a modified AgentInput with context injected, respecting the
   * provider's context window via the router.
   */
  enrichInput(
    input: AgentInput,
    providerId: AdapterProviderId,
    router: ContextAwareRouter
  ): AgentInput {
    // Estimate how much room we have after the base prompt
    const baseEstimate = router.estimateContext(input);
    const providerWindow = this.getProviderContextBudget(providerId, router);

    // Reserve space for the prompt + output; remainder is available for injections
    const availableForInjections = Math.max(
      0,
      providerWindow - baseEstimate.totalTokens
    );

    // Use the smaller of: configured max, or what the provider has room for
    const effectiveBudget =
      this.maxContextTokens !== undefined
        ? Math.min(this.maxContextTokens, availableForInjections)
        : availableForInjections;

    return this.apply(input, effectiveBudget);
  }

  /**
   * Compute the available context budget for a provider, factoring in safety
   * margin via the router's canHandle check. We binary-search for the
   * effective window by using the router's public API.
   */
  private getProviderContextBudget(
    providerId: AdapterProviderId,
    router: ContextAwareRouter
  ): number {
    // Use canHandle to find the effective window:
    // The effective window is the largest totalTokens that canHandle returns true for
    const contextWindows: Record<AdapterProviderId, number> = {
      claude: 200_000,
      codex: 128_000,
      gemini: 1_000_000,
      "gemini-sdk": 1_000_000,
      qwen: 128_000,
      crush: 32_000,
      goose: 128_000,
      openrouter: 200_000,
      openai: 128_000,
      ollama: 32_000,
    };
    const rawWindow = contextWindows[providerId] ?? 0;

    // Probe the router to find the effective window (with safety margin applied)
    // We test with a synthetic estimate; the router applies its own safety margin
    const probeEstimate = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: rawWindow,
      fitsInContext: true,
    };

    // If the full window doesn't fit, reduce by increments
    if (router.canHandle(providerId, probeEstimate)) {
      return rawWindow;
    }

    // Binary search for the effective threshold
    let low = 0;
    let high = rawWindow;
    while (high - low > 100) {
      const mid = Math.floor((low + high) / 2);
      const midEstimate = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: mid,
        fitsInContext: true,
      };
      if (router.canHandle(providerId, midEstimate)) {
        low = mid;
      } else {
        high = mid;
      }
    }
    return low;
  }
}
