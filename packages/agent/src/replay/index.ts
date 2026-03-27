/**
 * Runtime Replay Debugger — capture, replay, inspect, and serialize
 * agent execution traces for debugging and analysis.
 *
 * @module replay
 */

// --- Types ---
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
} from './replay-types.js'

// --- Trace Capture ---
export { TraceCapture } from './trace-capture.js'

// --- Replay Engine ---
export { ReplayEngine } from './replay-engine.js'

// --- Replay Controller ---
export { ReplayController } from './replay-controller.js'
export type {
  ReplayEventCallback,
  BreakpointHitCallback,
  StatusChangeCallback,
} from './replay-controller.js'

// --- Replay Inspector ---
export { ReplayInspector } from './replay-inspector.js'
export type {
  NodeMetrics as ReplayNodeMetrics,
  ReplaySummary,
} from './replay-inspector.js'

// --- Trace Serializer ---
export { TraceSerializer } from './trace-serializer.js'
