/**
 * Re-exports of replay types used by framework-internal playground trace
 * helpers.
 *
 * Vue SFC source is not maintained or published from this package. Consumers
 * should import replay contracts from the public agent API and render product
 * UI in the consuming app or design-system package.
 *
 * @module playground/ui/types
 */

export type {
  TimelineNode,
  TimelineData,
  StateDiffEntry,
} from '../../replay/replay-types.js'

export type {
  NodeMetrics,
  ReplaySummary,
} from '../../replay/replay-inspector.js'
