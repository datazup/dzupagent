/**
 * Framework-internal trace UI utilities. Not a public API surface.
 * Product UIs should consume replay data from the public agent API.
 */
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
  defaultTraceTheme,
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
  TraceTheme,
  TraceSurfaceStyles,
  TraceTextStyles,
  TraceToneStyles,
  TraceDensityStyles,
  TraceInteractionStyles,
  TraceUiHostContract,
  DiffRow,
} from './utils.js'

export type {
  TimelineNode,
  TimelineData,
  StateDiffEntry,
} from '../../replay/replay-types.js'

export type {
  NodeMetrics,
  ReplaySummary,
} from '../../replay/replay-inspector.js'
