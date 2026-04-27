# Replay Architecture

## Scope
This document covers `packages/agent/src/replay` in `@dzupagent/agent`.

Included modules:
- `replay-types.ts`
- `trace-capture.ts`
- `replay-engine.ts`
- `replay-controller.ts`
- `replay-inspector.ts`
- `trace-serializer.ts`
- `index.ts` (replay barrel)

Out of scope:
- Server-side run trace persistence (`@dzupagent/server`)
- Playground app composables outside this package
- Snapshot internals in `src/snapshot/*` except where replay consumes `stateSnapshot` fields

## Responsibilities
The replay subsystem provides an in-memory debugging workflow for agent runs:
- Capture `DzupEventBus` traffic into a normalized `ReplayEvent[]` stream.
- Convert a captured trace into one or more navigable `ReplaySession`s.
- Control playback (play/pause/step/seek/reset) with breakpoint support.
- Build analysis artifacts (timeline, state diffs, summaries, per-node metrics).
- Serialize/deserialize traces for storage or sharing, including optional field redaction.

## Structure
### Types and contracts
- `replay-types.ts` defines shared contracts used by all replay classes:
  - `ReplayEvent`, `Breakpoint`, `ReplayStatus`, `ReplaySession`
  - `TraceCaptureConfig`, `CapturedTrace`
  - `StateDiffEntry`, `TimelineNode`, `TimelineData`
  - `SerializationFormat`, `SerializeOptions`

### Capture
- `TraceCapture` subscribes to `DzupEventBus.onAny` and appends replay events.
- Config defaults:
  - `snapshotInterval: 10`
  - `maxEvents: 10_000`
- Supports include/exclude event-type filters with `*` suffix prefix matching.

### Session lifecycle
- `ReplayEngine` stores sessions in an in-memory `Map<string, ReplaySession>`.
- Session IDs are generated as `replay_<timestamp>_<counter>`.
- `createSession()` copies trace events into session-local state (`currentIndex`, `status`, `speed`, `breakpoints`).

### Playback
- `ReplayController` mutates a provided `ReplaySession` and exposes:
  - Event callbacks (`onEvent`)
  - Breakpoint callbacks (`onBreakpointHit`)
  - Status callbacks (`onStatusChange`)
- Uses `AbortController` to stop in-flight timed playback.

### Analysis
- `ReplayInspector` reads a `ReplaySession` and computes:
  - UI timeline (`getTimeline`)
  - Snapshot-based diffs (`getStateDiff`)
  - Search helpers (`findEventsByType`, `findEventsByNode`, `findErrors`, `findRecoveryAttempts`)
  - Node metrics (`getNodeMetrics`)
  - Session summary (`getSummary`)

### Serialization
- `TraceSerializer` supports `json`, `json-compact`, and `binary`.
- Binary format is `FGTRACE` (7-byte magic) + version byte (`1`) + gzip-compressed JSON payload.
- Includes `sanitize()` for key-pattern redaction across event data, state snapshots, and trace metadata.

## Runtime and Control Flow
1. `TraceCapture.start(runId, agentId?)` begins bus subscription.
2. Each bus event is filtered, normalized (`type` + `data`), optionally snapshotted, and appended.
3. If `maxEvents` is exceeded, oldest events are dropped and remaining events are reindexed.
4. `TraceCapture.stop()` returns a `CapturedTrace` with schema `1.0.0`, timestamps, config, and events.
5. `ReplayEngine.createSession(trace, options?)` creates a paused session at `currentIndex = -1`.
6. `ReplayController` drives navigation:
   - `play()` advances according to timestamp deltas and `speed`, capped to 2000ms per hop.
   - `step()`/`stepBack()` move one event at a time.
   - `seekTo(index)` jumps to a specific event.
   - `reset()` returns to pre-first-event position.
7. During playback, breakpoints are checked in-session and can pause execution.
8. `ReplayInspector` derives timeline/summary/diff views from captured session events.
9. `TraceSerializer` can persist the trace in selected format, optionally sanitized.

## Key APIs and Types
### Public classes
- `TraceCapture`
  - `setStateProvider(provider)`
  - `start(runId, agentId?)`
  - `stop(): CapturedTrace`
  - `isCapturing()`, `peek()`, `eventCount`
- `ReplayEngine`
  - `createSession(trace, options?)`
  - `getSession(id)`, `listSessions()`, `deleteSession(id)`, `clear()`, `sessionCount`
- `ReplayController`
  - Callbacks: `onEvent`, `onBreakpointHit`, `onStatusChange`
  - Playback: `play`, `pause`, `step`, `stepBack`, `seekTo`, `reset`
  - Breakpoints: `addBreakpoint`, `removeBreakpoint`, `toggleBreakpoint`, `clearBreakpoints`
  - State/session: `getState(index)`, `getSession()`, `setSpeed(speed)`
- `ReplayInspector`
  - `getTimeline()`, `getStateDiff()`, `getStateAt()`
  - `findEventsByType()`, `findEventsByNode()`, `findErrors()`, `findRecoveryAttempts()`
  - `getNodeMetrics()`, `getSummary()`
- `TraceSerializer`
  - `serialize(trace, options)`
  - `deserialize(buffer, format?)`
  - `sanitize(trace, additionalRedactFields?)`

### Important type semantics
- `ReplaySession.currentIndex = -1` means "before first event".
- `ReplayStatus`: `'paused' | 'playing' | 'stepping' | 'completed'`.
- Breakpoint types: `'event-type' | 'node-id' | 'condition' | 'error'`.
- `CapturedTrace.schemaVersion` is fixed to `'1.0.0'`.

## Dependencies
### Direct runtime dependencies used by replay code
- `@dzupagent/core`
  - `DzupEventBus`, `DzupEvent` (used by `TraceCapture`)
- Node built-in `node:zlib`
  - `gzipSync`, `gunzipSync` (used by `TraceSerializer` binary format)

### Package-level context
- `packages/agent/package.json` does not declare replay-specific external runtime libraries beyond package-level dependencies.
- Replay APIs are exported through:
  - `src/replay/index.ts`
  - `src/index.ts` (package root public surface)

## Integration Points
- Package export integration:
  - `src/index.ts` re-exports replay classes/types so consumers import from `@dzupagent/agent`.

- Playground UI type integration inside this package:
  - `src/playground/ui/types.ts` re-exports `TimelineNode`, `TimelineData`, `StateDiffEntry`, `NodeMetrics`, `ReplaySummary` from replay modules.
  - `src/playground/ui/utils.ts` imports replay types for derived UI formatting/helpers.
  - Vue components (`TraceTimeline.vue`, `TraceNodeDetail.vue`, `TraceSummary.vue`) type against replay contracts.

- Test integration:
  - `src/__tests__/replay-debugger.test.ts` exercises capture -> engine -> controller -> inspector -> serializer flows.
  - `src/__tests__/playground-ui-utils.test.ts` validates utility logic operating on replay-derived types.

## Testing and Observability
Current test coverage in this package for replay behavior is primarily in:
- `src/__tests__/replay-debugger.test.ts`
  - Capture lifecycle and filtering
  - Session creation/lifecycle
  - Playback controls and status transitions
  - Breakpoint behavior (event-type, node-id, error, condition)
  - State reconstruction and diff behavior
  - Serialization/deserialization and sanitization
  - End-to-end workflow test
- `src/__tests__/playground-ui-utils.test.ts`
  - Replay-summary/timeline-driven UI helper behavior

Observability surface in replay itself:
- Callback hooks on `ReplayController` (`onEvent`, `onBreakpointHit`, `onStatusChange`).
- `ReplayInspector.getSummary()` and `getTimeline()` produce aggregation views suitable for dashboards or UI overlays.

## Risks and TODOs
- `ReplayController` error breakpoints match any event with `data.error` or `data.message`; events with generic `message` fields may pause unexpectedly.
- `getState()` and `getStateDiff()` depend on available snapshots; if snapshots are sparse or disabled, reconstruction quality degrades.
- State diffing is top-level key based, not deep path diffing.
- `TraceSerializer.validateTrace()` validates top-level structure and schema version, but does not deeply validate each event payload shape.
- `ReplayEngine` keeps sessions in-memory only; no built-in persistence, retention policy, or concurrency controls across processes.
- `TraceCapture` reindexes events after retention trimming, so absolute historical indices are not preserved once older events are dropped.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

