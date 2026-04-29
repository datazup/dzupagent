/**
 * Playground UI — framework-internal trace utility helpers.
 *
 * This source module supports rendering-independent trace formatting and style
 * helpers used by source-internal maintenance tests. `@dzupagent/agent` does
 * not publish Vue build artifacts, Vue peer requirements, or public
 * `./playground/ui` package subpaths.
 *
 * The current helper tests validate formatting, trace tone maps, and class
 * composition only. Because the Vue SFCs remain internal and unpublished, this
 * package does not run runtime visual validation, rendered component checks, or
 * design-token conformance checks for them.
 *
 * Product UIs should consume replay data/contracts from the public agent API
 * and render those states in the consuming app's own design system.
 *
 * @deprecated Framework-internal source module. Do not import playground UI
 * internals as a product UI API.
 * @module playground/ui
 */

// Re-export replay-derived types used by trace helpers.
export type {
  TimelineNode,
  TimelineData,
  StateDiffEntry,
} from '../../replay/replay-types.js'

export type {
  NodeMetrics,
  ReplaySummary,
} from '../../replay/replay-inspector.js'

// Re-export utility functions for source-internal maintenance use.
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
  traceUiStyles,
  traceToneStyles,
  getTraceStatusTone,
  getTraceStatusStyles,
  getTraceChangeTone,
  getTraceChangeStyles,
} from './utils.js'

export type {
  NodeStatus,
  ChangeType,
  TraceTone,
  TraceToneStyles,
  DiffRow,
} from './utils.js'
