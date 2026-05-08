/**
 * `AdapterStuckDetector` — thin extension of the canonical
 * {@link StuckDetector} from `@dzupagent/core`. Kept as a named subclass so
 * the long-standing `AdapterStuckDetector` export from
 * `@dzupagent/agent-adapters` continues to work.
 *
 * Detects when an adapter execution is stuck by tracking:
 * - Repeated identical tool calls (same name + same input hash)
 * - High error rate within a sliding time window
 * - Idle iterations with no tool calls
 * - Repeated non-overlapping tool-name block patterns
 * - Semantic plateau (single-tool fixation)
 *
 * The legacy 3-mode contract (`recordToolCall`, `recordError`,
 * `recordIteration`, `reset`) is fully preserved; the additional 5-mode
 * detection (semantic plateau + progress-hash) is now available transparently.
 */
import { StuckDetector } from '@dzupagent/core/utils'
import type { StuckDetectorConfig } from '@dzupagent/core/utils'

export class AdapterStuckDetector extends StuckDetector {
  constructor(config?: StuckDetectorConfig) {
    super(config)
  }
}
