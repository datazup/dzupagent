/**
 * Replay debugger types — defines the data structures used across
 * TraceCapture, ReplayEngine, ReplayController, and ReplayInspector.
 *
 * @module replay/replay-types
 */

// ---------------------------------------------------------------------------
// Replay event
// ---------------------------------------------------------------------------

/**
 * A single captured event from an agent run, enriched with index and
 * optional state snapshot for reconstruction during replay.
 */
export interface ReplayEvent {
  /** Zero-based position in the event stream. */
  index: number
  /** When the event was captured (epoch ms). */
  timestamp: number
  /** Event type discriminator (mirrors DzupEvent['type']). */
  type: string
  /** Pipeline node that emitted this event, if applicable. */
  nodeId?: string
  /** Full event payload (excluding `type` which is stored separately). */
  data: Record<string, unknown>
  /** State snapshot captured at this point (present at snapshot intervals). */
  stateSnapshot?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Breakpoint
// ---------------------------------------------------------------------------

/**
 * A debugger breakpoint that pauses replay when its condition is met.
 */
export interface Breakpoint {
  /** Unique breakpoint identifier. */
  id: string
  /** What kind of condition triggers this breakpoint. */
  type: 'event-type' | 'node-id' | 'condition' | 'error'
  /**
   * Match value:
   * - For 'event-type': the event type string to match.
   * - For 'node-id': the nodeId to break on.
   * - For 'error': matches any event with an `error` field.
   * - For 'condition': human-readable label (actual logic in `condition`).
   */
  value: string
  /** Custom predicate for 'condition' breakpoints. */
  condition?: (event: ReplayEvent) => boolean
  /** Whether this breakpoint is active. */
  enabled: boolean
}

// ---------------------------------------------------------------------------
// Replay session
// ---------------------------------------------------------------------------

/** Replay playback status. */
export type ReplayStatus = 'paused' | 'playing' | 'stepping' | 'completed'

/**
 * Full state of an active replay session.
 */
export interface ReplaySession {
  /** Unique session identifier. */
  id: string
  /** The run being replayed. */
  runId: string
  /** All captured events for this run. */
  events: ReplayEvent[]
  /** Current playback position (index into events). */
  currentIndex: number
  /** Current playback status. */
  status: ReplayStatus
  /** Active breakpoints. */
  breakpoints: Breakpoint[]
  /** Playback speed multiplier (1 = real-time, 2 = 2x, 0.5 = half-speed). */
  speed: number
}

// ---------------------------------------------------------------------------
// Trace capture configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the TraceCapture module.
 */
export interface TraceCaptureConfig {
  /** How often to capture full state snapshots (every N events). 0 = never. */
  snapshotInterval: number
  /** Event type patterns to include. Empty = capture all. */
  includeTypes?: string[]
  /** Event type patterns to exclude (applied after include filter). */
  excludeTypes?: string[]
  /** Maximum number of events to capture (oldest are dropped). 0 = unlimited. */
  maxEvents?: number
}

// ---------------------------------------------------------------------------
// Captured trace (serializable)
// ---------------------------------------------------------------------------

/**
 * A complete captured trace that can be serialized and shared.
 */
export interface CapturedTrace {
  /** Schema version for forward compatibility. */
  schemaVersion: '1.0.0'
  /** The run this trace belongs to. */
  runId: string
  /** Agent that produced this trace. */
  agentId?: string
  /** All captured events. */
  events: ReplayEvent[]
  /** When the trace capture started (epoch ms). */
  startedAt: number
  /** When the trace capture ended (epoch ms). */
  completedAt?: number
  /** Capture configuration used. */
  config: TraceCaptureConfig
  /** Arbitrary metadata attached by the user. */
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// State diff
// ---------------------------------------------------------------------------

/**
 * A single field-level change between two state snapshots.
 */
export interface StateDiffEntry {
  /** The field path (dot-separated for nested). */
  path: string
  /** Previous value (undefined if added). */
  previous?: unknown
  /** Current value (undefined if removed). */
  current?: unknown
  /** Type of change. */
  changeType: 'added' | 'modified' | 'removed'
}

// ---------------------------------------------------------------------------
// Timeline visualization data
// ---------------------------------------------------------------------------

/**
 * A single node in the timeline visualization.
 */
export interface TimelineNode {
  /** Event index. */
  index: number
  /** Timestamp (epoch ms). */
  timestamp: number
  /** Event type. */
  type: string
  /** Node ID if applicable. */
  nodeId?: string
  /** Duration in ms (for tool/llm calls). */
  durationMs?: number
  /** Whether this event represents an error. */
  isError: boolean
  /** Token usage at this point (cumulative). */
  tokenUsage?: number
  /** Cost at this point in cents (cumulative). */
  costCents?: number
  /** Latency of this specific step in ms. */
  latencyMs?: number
}

/**
 * Complete timeline data suitable for rendering in a UI.
 */
export interface TimelineData {
  /** Ordered timeline nodes. */
  nodes: TimelineNode[]
  /** Total duration of the trace in ms. */
  totalDurationMs: number
  /** Total token usage. */
  totalTokens: number
  /** Total cost in cents. */
  totalCostCents: number
  /** Count of errors in the trace. */
  errorCount: number
  /** Count of recovery attempts (retries). */
  recoveryCount: number
  /** Distinct node IDs visited. */
  nodeIds: string[]
}

// ---------------------------------------------------------------------------
// Serialization format
// ---------------------------------------------------------------------------

/** Supported serialization formats. */
export type SerializationFormat = 'json' | 'json-compact' | 'binary'

/**
 * Options for trace serialization.
 */
export interface SerializeOptions {
  /** Output format. */
  format: SerializationFormat
  /** Strip potentially sensitive data from event payloads. */
  sanitize?: boolean
  /** Specific field paths to redact (dot-separated). */
  redactFields?: string[]
}
