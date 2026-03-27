/**
 * Re-exports of replay types used by the Playground UI components.
 *
 * Consumers should import these types alongside the Vue SFC components
 * to satisfy prop type requirements.
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
