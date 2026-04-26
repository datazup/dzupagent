/**
 * Recovery strategy selector — pure decision logic for choosing the next
 * `RecoveryStrategy` from a configured order, given a `FailureContext`
 * and the current set of available providers.
 *
 * This is extracted as a standalone, side-effect-free helper so the
 * non-stream and stream recovery loops in `AdapterRecoveryCopilot` can
 * share one implementation, and so its invariants can be tested in
 * isolation without spinning up the full copilot.
 *
 * Invariants preserved from the in-class `selectStrategy`:
 *   - When `strategySelector` is provided, its result wins unconditionally.
 *   - Otherwise, the walk starts at `attemptNumber - 1` (0-based) into
 *     `strategyOrder` and returns the first applicable strategy.
 *   - `'retry-different-provider'` is skipped iff every available provider
 *     has already been exhausted in this run.
 *   - If the walk runs off the end (or every entry is skipped), the
 *     strategy falls back to `'abort'`.
 *   - `undefined` slots in `strategyOrder` are skipped without consuming
 *     an attempt (mirrors the defensive guard in the original).
 *
 * @module recovery/recovery-strategy
 */

import type { AdapterProviderId } from '../types.js'
import type { FailureContext, RecoveryStrategy } from './adapter-recovery.js'

/** Inputs needed to pick the next strategy without touching the registry. */
export interface SelectStrategyInputs {
  /** Failure descriptor — `attemptNumber` is 1-based. */
  failure: FailureContext
  /** Configured strategy order (typically from `RecoveryConfig.strategyOrder`). */
  strategyOrder: RecoveryStrategy[]
  /** Providers currently registered as candidates (e.g. `registry.listAdapters()`). */
  availableProviders: AdapterProviderId[]
  /** Optional custom selector that overrides the default walk. */
  strategySelector?: ((failure: FailureContext) => RecoveryStrategy) | undefined
}

/**
 * Pick the next `RecoveryStrategy` for a failed attempt.
 *
 * The default walk advances into `strategyOrder` based on the (1-based)
 * attempt number, mirroring the original in-class behaviour: attempt 1
 * starts at index 0, attempt 2 at index 1, and so on. This is preserved
 * even though it can skip entries on later attempts — that policy is
 * intentional and tested.
 */
export function selectRecoveryStrategy(inputs: SelectStrategyInputs): RecoveryStrategy {
  const { failure, strategyOrder, availableProviders, strategySelector } = inputs

  if (strategySelector) {
    return strategySelector(failure)
  }

  const attemptIndex = failure.attemptNumber - 1 // 0-based

  for (let i = attemptIndex; i < strategyOrder.length; i++) {
    const strategy = strategyOrder[i]
    if (strategy === undefined) continue

    if (strategy === 'retry-different-provider') {
      const available = availableProviders.filter(
        (id) => !failure.exhaustedProviders.includes(id),
      )
      if (available.length === 0) continue
    }

    return strategy
  }

  // Fall back to abort if nothing else is applicable.
  return 'abort'
}
