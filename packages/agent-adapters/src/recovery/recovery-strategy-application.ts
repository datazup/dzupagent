/**
 * Recovery strategy application — pure transformation of an `AgentInput`
 * for the next recovery attempt, given the chosen `RecoveryStrategy`.
 *
 * Extracted as a standalone, side-effect-free helper so the non-stream
 * (`executeWithRecovery`) and stream (`executeWithRecoveryStream`)
 * recovery loops in `AdapterRecoveryCopilot` share one implementation,
 * and so the per-strategy mutation rules can be tested in isolation.
 *
 * Invariants preserved from the in-class `applyStrategy`:
 *   - `'retry-same-provider'` returns a shallow clone of `input`; no
 *     fields are touched.
 *   - `'retry-different-provider'` injects an `options.preferredProvider`
 *     hint pointing at the first provider not in `exhaustedProviders`,
 *     resolved via the supplied `resolveAlternativeProvider`. When no
 *     alternative exists, returns a shallow clone unchanged.
 *   - `'increase-budget'` multiplies `maxTurns` (rounded up via
 *     `Math.ceil`) and `maxBudgetUsd` by `budgetMultiplier`. Each field
 *     is only re-emitted when it was present on the original input.
 *   - `'simplify-task'` prepends a directive marker to `prompt` and
 *     appends an instruction to `systemPrompt` (creating it when absent).
 *   - `'escalate-human'` and `'abort'` return `input` unchanged — the
 *     caller is expected to handle these strategies before this function
 *     would re-run.
 *   - The `default` branch performs an exhaustive `never` check so
 *     adding a new `RecoveryStrategy` member surfaces as a type error.
 *
 * @module recovery/recovery-strategy-application
 */

import type { AdapterProviderId, AgentInput } from '../types.js'
import type { RecoveryStrategy } from './adapter-recovery.js'

/** Inputs needed to apply a strategy without touching the registry. */
export interface ApplyStrategyInputs {
  strategy: RecoveryStrategy
  input: AgentInput
  /** Providers already exhausted in this run (used for retry-different-provider). */
  exhaustedProviders?: Set<AdapterProviderId> | undefined
  /** Multiplier applied by `increase-budget`. */
  budgetMultiplier: number
  /**
   * Resolver that returns an alternative provider id given the set of
   * already-exhausted ids. Kept as a parameter (rather than a registry
   * reference) so the helper stays pure and testable.
   */
  resolveAlternativeProvider: (excluded: AdapterProviderId[]) => AdapterProviderId | undefined
}

/**
 * Produce the `AgentInput` that should drive the next recovery attempt.
 *
 * This function never mutates `input`; callers receive a fresh object
 * suitable for handing to the next `adapter.execute()` call.
 */
export function applyRecoveryStrategy(inputs: ApplyStrategyInputs): AgentInput {
  const {
    strategy,
    input,
    exhaustedProviders,
    budgetMultiplier,
    resolveAlternativeProvider,
  } = inputs

  switch (strategy) {
    case 'retry-same-provider':
      // Retry with the same input — no modifications needed.
      // The registry may still route to the same provider.
      return { ...input }

    case 'retry-different-provider': {
      // Find an alternative that hasn't been exhausted
      const excluded = exhaustedProviders ? [...exhaustedProviders] : []
      const alternative = resolveAlternativeProvider(excluded)
      if (alternative) {
        // Route to this specific provider by adding preference
        return {
          ...input,
          options: { ...input.options, preferredProvider: alternative },
        }
      }
      // If no alternatives, fall through with unmodified input
      return { ...input }
    }

    case 'increase-budget': {
      const newMaxTurns = input.maxTurns
        ? Math.ceil(input.maxTurns * budgetMultiplier)
        : undefined
      const newMaxBudget = input.maxBudgetUsd
        ? input.maxBudgetUsd * budgetMultiplier
        : undefined
      return {
        ...input,
        ...(newMaxTurns !== undefined && { maxTurns: newMaxTurns }),
        ...(newMaxBudget !== undefined && { maxBudgetUsd: newMaxBudget }),
      }
    }

    case 'simplify-task':
      // Prepend a simplification directive to the prompt
      return {
        ...input,
        prompt: `[SIMPLIFIED] Please provide a simpler, more direct solution. Avoid complex approaches.\n\n${input.prompt}`,
        systemPrompt: input.systemPrompt
          ? `${input.systemPrompt}\n\nIMPORTANT: Simplify your approach. Use the most straightforward solution available.`
          : 'IMPORTANT: Simplify your approach. Use the most straightforward solution available.',
      }

    case 'escalate-human':
    case 'abort':
      // These are handled in the main loop — no input modification needed.
      return input

    default: {
      // Exhaustive check
      const _exhaustive: never = strategy
      return _exhaustive
    }
  }
}
