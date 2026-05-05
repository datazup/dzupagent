/** @deprecated Import from observability/trace-ui instead. Framework-internal only. */
export type {
  TimelineNode,
  TimelineData,
  StateDiffEntry,
} from '../../replay/replay-types.js'

export type {
  NodeMetrics,
  ReplaySummary,
} from '../../replay/replay-inspector.js'

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
} from '../../observability/trace-ui/utils.js'

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
} from '../../observability/trace-ui/utils.js'
