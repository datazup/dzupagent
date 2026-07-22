/**
 * ContextAwareRouter -- routes tasks to providers based on context window fit.
 *
 * Split out of `context-aware-router.ts` as part of the ARCH-M-06 god-module
 * decomposition.
 */

import type {
  AdapterProviderId,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from "../../types.js";
import {
  DEFAULT_CONTEXT_WINDOWS,
  PROVIDER_PRIORITY,
  defaultTokenEstimator,
  getProviderPriority,
} from "./context-windows.js";
import type {
  ContextAwareRouterConfig,
  ContextEstimate,
  ContextInjection,
} from "./types.js";

/**
 * Routes tasks to providers based on context window fit.
 *
 * Logic:
 * 1. Estimate context from task prompt + any injected context
 * 2. Filter providers that can handle the estimated context (with safety margin)
 * 3. Among those that fit, prefer by provider priority order
 * 4. If no provider fits, route to gemini (largest context window) with a warning
 * 5. Confidence is based on how well the context fits (closer to max = lower confidence)
 */
export class ContextAwareRouter implements TaskRoutingStrategy {
  readonly name = "context-aware";

  private readonly contextWindows: Record<AdapterProviderId, number>;
  private readonly safetyMargin: number;
  private readonly defaultOutputTokens: number;
  private readonly tokenEstimator: (text: string) => number;

  constructor(config?: ContextAwareRouterConfig) {
    this.contextWindows = {
      ...DEFAULT_CONTEXT_WINDOWS,
      ...config?.contextWindows,
    };
    this.safetyMargin = config?.safetyMargin ?? 0.2;
    this.defaultOutputTokens = config?.defaultOutputTokens ?? 4000;
    this.tokenEstimator = config?.tokenEstimator ?? defaultTokenEstimator;
  }

  /** Estimate context requirements for an input */
  estimateContext(
    input: AgentInput,
    injections?: ContextInjection[]
  ): ContextEstimate {
    let inputTokens = this.tokenEstimator(input.prompt);

    if (input.systemPrompt) {
      inputTokens += this.tokenEstimator(input.systemPrompt);
    }

    if (injections) {
      for (const injection of injections) {
        inputTokens += this.tokenEstimator(injection.content);
        // Small overhead for the label and separator
        inputTokens += this.tokenEstimator(injection.label) + 10;
      }
    }

    const outputTokens = this.defaultOutputTokens;
    const totalTokens = inputTokens + outputTokens;

    // Find the best-fit provider
    const recommended = this.findRecommendedProvider(totalTokens);

    const fitsInContext = recommended !== undefined;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      fitsInContext,
      recommendedProvider: recommended,
    };
  }

  /**
   * Estimate input tokens for a task, accounting for systemPrompt and
   * pre-computed estimatedInputTokens when available.
   */
  private estimateTaskInputTokens(task: TaskDescriptor): number {
    // Use caller-supplied estimate when available — more precise than our heuristic
    if (task.estimatedInputTokens !== undefined) {
      return task.estimatedInputTokens;
    }
    let tokens = this.tokenEstimator(task.prompt);
    if (task.systemPrompt) {
      tokens += this.tokenEstimator(task.systemPrompt);
    }
    return tokens;
  }

  /** TaskRoutingStrategy.route -- routes based on context window fit */
  route(
    task: TaskDescriptor,
    availableProviders: AdapterProviderId[]
  ): RoutingDecision {
    // Respect explicit preference if available and fits
    if (
      task.preferredProvider &&
      availableProviders.includes(task.preferredProvider)
    ) {
      const inputTokens = this.estimateTaskInputTokens(task);
      const totalTokens = inputTokens + this.defaultOutputTokens;
      const effectiveWindow = this.getEffectiveWindow(task.preferredProvider);

      if (totalTokens <= effectiveWindow) {
        return {
          provider: task.preferredProvider,
          reason: `Preferred provider "${task.preferredProvider}" has sufficient context window`,
          fallbackProviders: availableProviders.filter(
            (p) => p !== task.preferredProvider
          ),
          confidence: 0.95,
        };
      }
    }

    if (availableProviders.length === 0) {
      return {
        provider: "auto",
        reason: "No adapters available for context-aware routing",
        fallbackProviders: [],
        confidence: 0,
      };
    }

    const inputTokens = this.estimateTaskInputTokens(task);
    const totalTokens = inputTokens + this.defaultOutputTokens;

    // Filter providers that can handle the context
    const fittingProviders = availableProviders.filter((providerId) =>
      this.canHandle(providerId, {
        inputTokens,
        outputTokens: this.defaultOutputTokens,
        totalTokens,
        fitsInContext: true,
      })
    );

    if (fittingProviders.length > 0) {
      // Sort by priority order
      const sorted = fittingProviders.sort((a, b) => {
        return getProviderPriority(a) - getProviderPriority(b);
      });

      const best = sorted[0]!;
      const effectiveWindow = this.getEffectiveWindow(best);
      const utilization = totalTokens / effectiveWindow;
      // Higher utilization = lower confidence (tighter fit)
      const confidence = Math.max(0.4, Math.min(0.95, 1.0 - utilization * 0.6));

      return {
        provider: best,
        reason: `Context fits within ${best} window (${totalTokens} / ${effectiveWindow} tokens, ${Math.round(
          utilization * 100
        )}% utilization)`,
        fallbackProviders: sorted.slice(1),
        confidence,
      };
    }

    // No provider fits -- fall back to gemini (largest context window)
    const fallback: AdapterProviderId = availableProviders.includes("gemini")
      ? "gemini"
      : availableProviders[0]!;

    const effectiveWindow = this.getEffectiveWindow(fallback);
    const utilization = totalTokens / effectiveWindow;

    return {
      provider: fallback,
      reason: `No provider has sufficient context window for ${totalTokens} tokens; falling back to ${fallback} (${effectiveWindow} effective tokens, ${Math.round(
        utilization * 100
      )}% utilization)`,
      fallbackProviders: availableProviders.filter((p) => p !== fallback),
      confidence: Math.max(0.1, 0.4 - (utilization - 1.0) * 0.3),
    };
  }

  /** Check if a specific provider can handle the estimated context */
  canHandle(providerId: AdapterProviderId, estimate: ContextEstimate): boolean {
    const effectiveWindow = this.getEffectiveWindow(providerId);
    return estimate.totalTokens <= effectiveWindow;
  }

  /** Get effective context window (after safety margin) for a provider */
  private getEffectiveWindow(providerId: AdapterProviderId): number {
    const rawWindow = this.contextWindows[providerId] ?? 0;
    return Math.floor(rawWindow * (1 - this.safetyMargin));
  }

  /** Find the best recommended provider by priority among those that fit */
  private findRecommendedProvider(
    totalTokens: number
  ): AdapterProviderId | undefined {
    for (const providerId of PROVIDER_PRIORITY) {
      const effectiveWindow = this.getEffectiveWindow(providerId);
      if (totalTokens <= effectiveWindow) {
        return providerId;
      }
    }
    return undefined;
  }
}
