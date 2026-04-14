# Replay Module Architecture (`packages/agent/src/replay`)

## 1. Scope and Responsibility

This folder implements the runtime replay debugger stack for `@dzupagent/agent`.

It provides the full lifecycle for debugging and post-run analysis:

1. Capture runtime events (`TraceCapture`).
2. Build replay sessions (`ReplayEngine`).
3. Navigate sessions with VCR-style controls and breakpoints (`ReplayController`).
4. Analyze timelines, errors, diffs, and per-node metrics (`ReplayInspector`).
5. Serialize traces for persistence/sharing with optional redaction (`TraceSerializer`).

The replay module is exported publicly through both:

- local barrel: `packages/agent/src/replay/index.ts`
- package root: `packages/agent/src/index.ts`

## 2. Module Inventory

- `replay-types.ts`
  - Canonical data model: events, sessions, breakpoints, timeline nodes, state diff, serialization options.
- `trace-capture.ts`
  - Captures `DzupEventBus` traffic into replay events, with filtering, snapshots, and retention limits.
- `replay-engine.ts`
  - Session lifecycle manager (`create/get/list/delete/clear`).
- `replay-controller.ts`
  - Playback controls: play/pause/step/stepBack/seek/reset, breakpoint management, state reconstruction.
- `replay-inspector.ts`
  - Timeline generation, error/recovery search, state diffs, node metrics, summary aggregation.
- `trace-serializer.ts`
  - JSON / compact JSON / binary encoding and decoding, plus sensitive-data sanitization.
- `index.ts`
  - Stable re-export surface for consumers.

## 3. Data Model and Contracts

### 3.1 `ReplayEvent`

`ReplayEvent` is the core event unit used across all replay components.

- `index`: stream position (zero-based)
- `timestamp`: capture time in epoch ms
- `type`: event discriminator
- `nodeId?`: normalized node/tool identifier
- `data`: payload object (event body excluding `type`)
- `stateSnapshot?`: optional state clone at capture interval

### 3.2 `ReplaySession`

`ReplaySession` wraps an immutable event list with mutable playback state.

- `currentIndex = -1` means playback is before the first event.
- `status`: `'paused' | 'playing' | 'stepping' | 'completed'`
- `breakpoints`: active/pending conditions
- `speed`: playback multiplier

### 3.3 Breakpoints

Supported breakpoint types:

- `event-type`: exact event type match
- `node-id`: exact node ID match
- `condition`: custom predicate `(event) => boolean`
- `error`: matches events with `data.error` or `data.message`

### 3.4 Serializable Trace

`CapturedTrace` format:

- `schemaVersion: '1.0.0'`
- run metadata (`runId`, `agentId`, timestamps)
- captured `events`
- effective capture `config`
- optional `metadata`

## 4. Feature Breakdown

### 4.1 `TraceCapture`

Primary features:

- Event bus subscription via `onAny`.
- Include/exclude filters with wildcard-prefix pattern support (`tool:*`, `agent:*`, etc.).
- Configurable snapshot cadence (`snapshotInterval`).
- Optional memory guard (`maxEvents`) with oldest-event eviction.
- Automatic event re-indexing after eviction.
- `peek()` and `eventCount` introspection while capture is active.

Behavior notes:

- `start()` while already capturing throws.
- `stop()` before `start()` throws.
- Snapshot capture uses `structuredClone`; non-cloneable state is skipped safely.
- `nodeId` extraction prioritizes `data.nodeId`, then `data.toolName`.

### 4.2 `ReplayEngine`

Primary features:

- Creates replay sessions from captured traces.
- Supports optional initial `speed` and `breakpoints` on session creation.
- Tracks multiple sessions concurrently in-memory.

Lifecycle methods:

- `createSession(trace, options?)`
- `getSession(sessionId)`
- `listSessions()`
- `deleteSession(sessionId)`
- `clear()`

### 4.3 `ReplayController`

Primary features:

- Playback: `play`, `pause`, `step`, `stepBack`, `seekTo`, `reset`.
- Breakpoint operations: add/remove/toggle/clear.
- Observability callbacks: `onEvent`, `onBreakpointHit`, `onStatusChange`.
- Variable-speed playback using real timestamp deltas.

Playback timing behavior:

- Delay between events is based on timestamp delta of adjacent events.
- Delay is capped at 2000ms per hop to avoid long stalls.
- Delay is scaled by `speed`.
- Empty sessions complete immediately.

State behavior:

- `stepBack()` from start clamps to `-1`.
- `seekTo()` out-of-bounds returns `undefined`.
- `setSpeed(speed <= 0)` throws.

State reconstruction behavior (`getState(index)`):

- Locates nearest snapshot at or before `index`.
- Clones that snapshot.
- Merges subsequent event snapshots up to `index`.
- Returns `undefined` if no snapshot exists.

### 4.4 `ReplayInspector`

Primary features:

- UI-ready timeline generation (`getTimeline`).
- Error and recovery detection.
- Snapshot-based state diff (`getStateDiff`).
- Event search helpers.
- Per-node aggregate metrics.
- High-level summary generation (`getSummary`).

Timeline aggregation includes:

- total duration
- cumulative token usage
- cumulative cost
- error count
- recovery/retry count
- distinct node IDs

State diff semantics:

- Diffs are computed from nearest snapshots at `fromIndex` and `toIndex`.
- Diff is top-level key comparison (not deep path expansion).
- Value equality for objects/arrays uses JSON serialization fallback.

### 4.5 `TraceSerializer`

Primary features:

- Formats:
  - `json` (pretty)
  - `json-compact`
  - `binary` (`FGTRACE` magic + version byte + gzip JSON payload)
- Format autodetection on deserialize.
- Schema validation checks:
  - `schemaVersion === '1.0.0'`
  - `runId` is string
  - `events` is array
- Recursive key-based sanitization with default sensitive key patterns.
- Additional custom `redactFields` support.

Sanitization behavior:

- Redacts matching keys in:
  - `event.data`
  - `event.stateSnapshot`
  - top-level trace `metadata`
- Matching is case-insensitive substring on key names.

## 5. End-to-End Execution Flow

```text
EventBus events
  -> TraceCapture.start(runId)
  -> TraceCapture.handleEvent(...) [filters, nodeId extraction, snapshots, retention]
  -> CapturedTrace (TraceCapture.stop)
  -> ReplayEngine.createSession(trace)
  -> ReplayController(play/step/seek + breakpoints)
  -> ReplayInspector(getTimeline/getSummary/getStateDiff)
  -> TraceSerializer(serialize/sanitize/deserialize)
```

Detailed playback sequence:

1. `ReplayController.play()` enters `playing` status.
2. Computes delay from event timestamps and playback speed.
3. Advances index and emits event callbacks.
4. Evaluates breakpoints.
5. If breakpoint matches, transitions to `paused` and emits breakpoint callback.
6. If final event reached, transitions to `completed`.

## 6. Usage Examples

### 6.1 Minimal Capture -> Replay -> Inspect

```ts
import { createEventBus } from '@dzupagent/core'
import {
  TraceCapture,
  ReplayEngine,
  ReplayController,
  ReplayInspector,
} from '@dzupagent/agent'

const bus = createEventBus()

const capture = new TraceCapture(bus, { snapshotInterval: 5, maxEvents: 5000 })
capture.start('run-123', 'agent-a')

// ... your run emits events on the bus ...

const trace = capture.stop()

const engine = new ReplayEngine()
const session = engine.createSession(trace)

const controller = new ReplayController(session)
controller.onEvent((event) => {
  console.log(event.index, event.type, event.nodeId)
})

await controller.play()

const inspector = new ReplayInspector(session)
const summary = inspector.getSummary()
console.log(summary)
```

### 6.2 Breakpoint-Driven Debugging

```ts
controller.addBreakpoint({
  id: 'bp-tool-error',
  type: 'event-type',
  value: 'tool:error',
  enabled: true,
})

controller.onBreakpointHit((bp, event) => {
  console.log('Paused on breakpoint', bp.id, 'at', event.index)
})

await controller.play()

// Inspect exact state at pause point
const pausedIndex = controller.getSession().currentIndex
const state = controller.getState(pausedIndex)
console.log(state)
```

### 6.3 Safe Trace Sharing

```ts
import { TraceSerializer } from '@dzupagent/agent'

const serializer = new TraceSerializer()

const sharedBinary = serializer.serialize(trace, {
  format: 'binary',
  sanitize: true,
  redactFields: ['customerEmail', 'sessionCookie'],
})

const restored = serializer.deserialize(sharedBinary)
```

### 6.4 Feeding Replay Data into Playground UI Types

```ts
import type { TimelineNode, ReplaySummary } from '@dzupagent/agent'
import { getBottleneckNodes } from '@dzupagent/agent/playground/ui/utils'

const timeline: TimelineNode[] = inspector.getTimeline().nodes
const summary: ReplaySummary = inspector.getSummary()
const bottlenecks = getBottleneckNodes(summary, 5)
```

## 7. References in Other Packages and Usage

### 7.1 Direct in-monorepo reuse

### Public export path

- `packages/agent/src/index.ts`
  - Re-exports replay classes/types for `@dzupagent/agent` consumers.

### Internal UI type coupling

- `packages/agent/src/playground/ui/index.ts`
- `packages/agent/src/playground/ui/types.ts`
- `packages/agent/src/playground/ui/utils.ts`
- `packages/agent/src/playground/ui/TraceTimeline.vue`
- `packages/agent/src/playground/ui/TraceNodeDetail.vue`
- `packages/agent/src/playground/ui/TraceSummary.vue`

These components/utilities consume replay outputs (`TimelineNode`, `ReplaySummary`, `NodeMetrics`) for rendering and derived UI metrics.

### Current instantiation footprint

In this monorepo, direct instantiation of replay classes (`new TraceCapture`, `new ReplayEngine`, etc.) is currently exercised in tests and examples, not in production runtime wiring across other packages.

### 7.2 Adjacent replay pipelines in other packages (separate implementations)

### Server trace API pipeline (`@dzupagent/server`)

- `packages/server/src/persistence/run-trace-store.ts`
  - Stores `TraceStep[]` with server-focused step taxonomy.
- `packages/server/src/runtime/run-worker.ts`
  - Creates and closes traces around run execution.
- `packages/server/src/routes/run-trace.ts`
  - Exposes `GET /api/runs/:id/messages` with optional pagination.

### Playground trace consumption pipeline (`@dzupagent/playground`)

- `packages/playground/src/composables/useTraceReplay.ts`
  - Maps server `TraceStep` responses to UI `TraceEvent` objects.
- `packages/playground/src/composables/useEventStream.ts`
  - Builds live replay-compatible events from WebSocket stream.
- `packages/playground/src/composables/useLiveTrace.ts`
  - Produces live metrics/timeline from stream events.
- `packages/playground/src/composables/useReplayControls.ts`
  - UI playback controls for timeline stepping.

### Agent adapters

- `packages/agent-adapters/src/recovery/adapter-recovery.ts`
  - Contains `ExecutionTraceCapture`, a separate trace mechanism for adapter recovery workflows.

### 7.3 Interoperability note

The server/playground replay path uses a different event schema than `packages/agent/src/replay`.

- Replay module core shape: `ReplayEvent`
- Server trace shape: `TraceStep`
- Playground live shape: `ReplayEvent` (local composable type)

Bridging between these models requires explicit mapping (as seen in `useTraceReplay.ts`).

## 8. Test Coverage (Descriptive)

### 8.1 Replay module direct tests

- `packages/agent/src/__tests__/replay-debugger.test.ts`
- Scope: `TraceCapture`, `ReplayEngine`, `ReplayController`, `ReplayInspector`, `TraceSerializer`, plus end-to-end integration.
- Test count: 60.
- Executed and passing locally.

Covered behaviors include:

- Capture lifecycle, filtering, snapshots, retention, nodeId extraction.
- Session creation/lifecycle management.
- Full playback controls and status transitions.
- All breakpoint types and breakpoint management operations.
- State reconstruction and bounds handling.
- Timeline generation, error/recovery detection, state diff, summary.
- JSON/compact/binary serialization roundtrip, auto-detection, sanitization, validation failures.
- End-to-end workflow from capture to serialized replay.

### 8.2 Replay-derived UI utility coverage in `@dzupagent/agent`

- `packages/agent/src/__tests__/playground-ui-utils.test.ts`
- Test count: 53.
- Executed and passing locally.

Covers utility behavior on replay-derived types (`TimelineNode`, `ReplaySummary`, `NodeMetrics`) for status mapping, duration/cost formatting, diff rows, bottleneck/error aggregations.

### 8.3 Cross-package replay-flow coverage

- `packages/playground/src/__tests__/trace-replay.test.ts` (24 tests)
- `packages/playground/src/__tests__/replay-controls.test.ts` (16 tests)
- `packages/playground/src/__tests__/use-live-trace.test.ts` (29 tests)
- Combined executed count: 69 tests, all passing.

These validate server trace mapping, UI replay controls, and live trace analytics.

- `packages/server/src/__tests__/run-trace-store.test.ts` (22 tests)
- `packages/server/src/__tests__/run-worker.test.ts` (7 tests)
- Combined executed count: 29 tests, all passing.

These validate trace retention/pagination and run-worker trace lifecycle integration.

### 8.4 Verification commands run

Commands executed successfully:

- `yarn workspace @dzupagent/agent test src/__tests__/replay-debugger.test.ts`
- `yarn workspace @dzupagent/agent test src/__tests__/playground-ui-utils.test.ts`
- `yarn workspace @dzupagent/playground test src/__tests__/trace-replay.test.ts src/__tests__/replay-controls.test.ts src/__tests__/use-live-trace.test.ts`
- `yarn workspace @dzupagent/server test src/__tests__/run-trace-store.test.ts src/__tests__/run-worker.test.ts`

## 9. Behavioral Nuances and Current Limitations

- `ReplayController` error breakpoint currently matches on `data.error` OR `data.message`; generic message fields may trigger error breakpoints unexpectedly.
- `ReplayController.getState()` reconstructs state from snapshots only; it does not derive state changes from arbitrary event payloads.
- `ReplayInspector.getStateDiff()` uses nearest snapshots and top-level key diffs only (nested path-level diffs are not emitted).
- `TraceSerializer.validateTrace()` performs minimal structural validation and trusts event internals after top-level checks.
- Deep value comparison in diff/utility code depends on JSON serialization fallback for objects, which may be sensitive to key ordering or non-JSON values.
- `TraceCapture` retention drops oldest events and re-indexes remaining events, which preserves relative ordering but not original absolute indices.

## 10. Practical Adoption Guidance

If you are integrating replay into a new runtime surface:

1. Emit complete event payloads (especially `nodeId`/`toolName`, `durationMs`, token/cost fields) for richer inspector outputs.
2. Provide a clone-safe state provider if you need deterministic historical state reconstruction.
3. Add at least one error-focused breakpoint preset for interactive debugging UX.
4. Use `sanitize: true` before persisting or sharing traces outside trusted boundaries.
5. If you consume server trace APIs, define an explicit mapper between `TraceStep` and `ReplayEvent` to avoid schema drift.
