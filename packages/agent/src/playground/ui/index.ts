/**
 * Playground trace UI — framework-internal utility helpers.
 *
 * This source module supports rendering-independent trace formatting and style
 * helpers used by source-internal maintenance tests. Vue SFC source was removed
 * from this package; `@dzupagent/agent` does not publish Vue build artifacts,
 * Vue peer requirements, or public `./playground/ui` package subpaths.
 *
 * The current helper tests validate formatting, trace tone maps, and class
 * composition only. Because no Vue SFCs are maintained in this package, this
 * package does not run runtime visual validation, rendered component checks, or
 * design-token conformance checks for playground UI components.
 *
 * Product UIs should consume replay data/contracts from the public agent API
 * and render those states in the consuming app's own design system.
 *
 * Dark-mode precondition for hosts that intentionally reuse these internal
 * class strings: Tailwind must use class-based dark mode, and the host must
 * toggle a `.dark` class on an ancestor. The machine-readable form of this
 * contract is exported as `traceUiHostContract`.
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
  traceUiHostContract,
  traceInteractionStyles,
  traceUiStyles,
  traceDensityStyles,
  traceToneStyles,
  getTraceStatusTone,
  getTraceStatusStyles,
  getTraceChangeTone,
  getTraceChangeStyles,
  getTraceDensityStyles,
} from './utils.js'

export type {
  NodeStatus,
  ChangeType,
  TraceTone,
  TraceDensity,
  TraceToneStyles,
  TraceDensityStyles,
  TraceInteractionStyles,
  TraceUiHostContract,
  DiffRow,
} from './utils.js'
