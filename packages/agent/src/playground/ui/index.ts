/**
 * Playground UI — Vue 3 components for visualizing agent execution traces.
 *
 * These components consume data structures from the `@dzipagent/agent` replay
 * module (TimelineNode, ReplaySummary, NodeMetrics, etc.) and render them as
 * interactive panels.
 *
 * Usage:
 * ```ts
 * import TraceTimeline from '@dzipagent/agent/playground/ui/TraceTimeline.vue'
 * import TraceNodeDetail from '@dzipagent/agent/playground/ui/TraceNodeDetail.vue'
 * import TraceStateInspector from '@dzipagent/agent/playground/ui/TraceStateInspector.vue'
 * import TraceSummary from '@dzipagent/agent/playground/ui/TraceSummary.vue'
 * ```
 *
 * @module playground/ui
 */

// Re-export types used by the components
export type {
  TimelineNode,
  TimelineData,
  StateDiffEntry,
} from '../../replay/replay-types.js'

export type {
  NodeMetrics,
  ReplaySummary,
} from '../../replay/replay-inspector.js'

// Re-export utility functions for programmatic use
export {
  getNodeStatus,
  formatMs,
  formatCost,
  barWidthPercent,
  getMaxDuration,
  getTotalDuration,
  deepEqual,
  computeDiffRows,
  getFailedNodeCount,
  getBottleneckNodes,
  getErrorEventTypes,
  formatValue,
} from './utils.js'

export type {
  NodeStatus,
  ChangeType,
  DiffRow,
} from './utils.js'
