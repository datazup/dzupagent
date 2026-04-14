/**
 * Playground UI — Vue 3 components for visualizing agent execution traces.
 *
 * These components consume data structures from the `@dzupagent/agent` replay
 * module (TimelineNode, ReplaySummary, NodeMetrics, etc.) and render them as
 * interactive panels.
 *
 * Usage:
 * ```ts
 * import TraceTimeline from '@dzupagent/agent/playground/ui/TraceTimeline.vue'
 * import TraceNodeDetail from '@dzupagent/agent/playground/ui/TraceNodeDetail.vue'
 * import TraceStateInspector from '@dzupagent/agent/playground/ui/TraceStateInspector.vue'
 * import TraceSummary from '@dzupagent/agent/playground/ui/TraceSummary.vue'
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
