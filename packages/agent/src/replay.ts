/**
 * @dzupagent/agent/replay — runtime trace capture, replay, and inspection.
 *
 * Use this subpath when integrating the replay debugger: capture traces during
 * a run, replay them deterministically, drive breakpoints, inspect state
 * diffs, and serialize/deserialize captured traces. The root barrel re-exports
 * these symbols (annotated as `@deprecated`) for backwards compatibility.
 */

export {
  TraceCapture,
  ReplayEngine,
  ReplayController,
  ReplayInspector,
  TraceSerializer,
} from './replay/index.js'
export type {
  ReplayEvent,
  Breakpoint,
  ReplayStatus,
  ReplaySession,
  TraceCaptureConfig,
  CapturedTrace,
  StateDiffEntry,
  TimelineNode,
  TimelineData,
  SerializationFormat,
  SerializeOptions,
  ReplayEventCallback,
  BreakpointHitCallback,
  StatusChangeCallback,
  ReplayNodeMetrics,
  ReplaySummary,
} from './replay/index.js'
