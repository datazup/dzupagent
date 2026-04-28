/**
 * Playground UI — framework-internal Vue 3 trace visualizations.
 *
 * This source module supports the local playground trace components and their
 * rendering-independent utilities. The Vue SFCs are not a packaged design
 * surface: `@dzupagent/agent` does not publish Vue build artifacts, Vue peer
 * requirements, or public `./playground/ui` package subpaths.
 *
 * Product UIs should consume replay data/contracts from the public agent API
 * and render those states in the consuming app's own design system.
 *
 * @deprecated Framework-internal source module. Do not import Vue SFCs from
 * package internals.
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
