# Replay Architecture

## Scope
This document describes the replay subsystem implemented in `packages/agent/src/replay`.

Primary files in scope:
- `replay-types.ts`
- `trace-capture.ts`
- `replay-engine.ts`
- `replay-controller.ts`
- `replay-inspector.ts`
- `trace-serializer.ts`
- `index.ts`

Related integration files referenced for boundary/context:
- `src/replay.ts` (public subpath entrypoint for `@dzupagent/agent/replay`)
- `src/observability/trace-ui/index.ts`, `src/observability/trace-ui/types.ts`, `src/observability/trace-ui/utils.ts` (internal trace UI helpers consuming replay types)
- `src/__tests__/replay-debugger.test.ts`, `src/__tests__/playground-ui-utils.test.ts` (verification)

Out of scope:
- Persistence and storage services outside this module (for example server-side run archival)
- Snapshot generation internals outside replay (replay only consumes `stateSnapshot` fields when present)
- Product UI rendering (this package keeps trace UI helpers rendering-independent)

## Responsibilities
The replay subsystem provides an in-process trace debugging pipeline for agent runs:
- Capture `DzupEventBus` traffic as normalized `ReplayEvent` records.
- Optionally attach periodic cloned state snapshots during capture.
- Build isolated replay sessions from captured traces.
- Drive VCR-style playback with speed control, stepping, seeking, and breakpoints.
- Provide inspection outputs for timelines, state diffs, filtering/search, node metrics, and summary rollups.
- Serialize/deserialize traces in shareable formats, with optional redaction.

## Structure
- `replay-types.ts`
- Defines shared contracts: `ReplayEvent`, `Breakpoint`, `ReplaySession`, `CapturedTrace`, `TimelineData`, `StateDiffEntry`, and serialization options.
- `trace-capture.ts`
- `TraceCapture` subscribes to `DzupEventBus.onAny`, filters event types, extracts `nodeId` from common payload shapes (`nodeId` or `toolName`), optionally snapshots state, and enforces bounded retention (`maxEvents`) with reindexing.
- `replay-engine.ts`
- `ReplayEngine` stores sessions in memory (`Map<string, ReplaySession>`), generates IDs (`replay_<timestamp>_<counter>`), and manages create/get/list/delete/clear.
- `replay-controller.ts`
- `ReplayController` mutates one `ReplaySession` and exposes callback subscriptions for event hits, breakpoint hits, and status transitions. It owns playback control and breakpoint operations.
- `replay-inspector.ts`
- `ReplayInspector` computes timeline and summary aggregates, state diffs, event filtering, and per-node metrics.
- `trace-serializer.ts`
- `TraceSerializer` handles `json`, `json-compact`, and binary (`FGTRACE` + version byte + gzip payload) formats, plus recursive key-based redaction.
- `index.ts`
- Replay barrel re-exporting replay classes/types and controller callback types.

## Runtime and Control Flow
1. A caller constructs `TraceCapture` with a `DzupEventBus` and optional partial `TraceCaptureConfig`.
2. `start(runId, agentId?)` resets internal state and subscribes to all bus events.
3. Each event passes include/exclude matching (`*` suffix prefix support), is normalized into a `ReplayEvent`, and may receive a `stateSnapshot` every `snapshotInterval` events when `stateProvider` is set.
4. If retention exceeds `maxEvents`, oldest entries are dropped and remaining entries are reindexed from zero.
5. `stop()` unsubscribes and returns a `CapturedTrace` (`schemaVersion: '1.0.0'`) including run metadata, timestamps, capture config, and event list.
6. `ReplayEngine.createSession(trace, options?)` copies trace events into a new paused session (`currentIndex = -1`, default `speed = 1`).
7. `ReplayController` drives session movement:
- `play()` advances from current index, waits by timestamp delta / speed (delay capped at 2000ms), emits event callbacks, checks breakpoints, and stops at pause/completion.
- `step()`, `stepBack()`, `seekTo()`, and `reset()` support manual navigation.
- Status transitions are emitted through `onStatusChange`.
8. During replay, breakpoint matching supports:
- `event-type` exact type match
- `node-id` exact node ID match
- `error` when `event.data.error` or `event.data.message` exists
- `condition` user predicate
9. `ReplayInspector` derives timeline nodes, cost/token aggregates, error/recovery counts, node metrics, event-type counts, and state diffs.
10. `TraceSerializer` can export/import traces and optionally sanitize sensitive keys in `event.data`, snapshots, and metadata.

## Key APIs and Types
- `TraceCapture`
- `setStateProvider(provider)`
- `start(runId, agentId?)`
- `stop(): CapturedTrace`
- `isCapturing()`, `peek()`, `eventCount`

- `ReplayEngine`
- `createSession(trace, options?)`
- `getSession(sessionId)`, `listSessions()`, `deleteSession(sessionId)`, `clear()`, `sessionCount`

- `ReplayController`
- Callback subscriptions: `onEvent`, `onBreakpointHit`, `onStatusChange`
- Playback: `play`, `pause`, `step`, `stepBack`, `seekTo`, `reset`
- Breakpoints: `addBreakpoint`, `removeBreakpoint`, `toggleBreakpoint`, `clearBreakpoints`
- Session utilities: `getState(index)`, `getSession()`, `setSpeed(speed)`

- `ReplayInspector`
- Timeline/state: `getTimeline()`, `getStateDiff(fromIndex, toIndex)`, `getStateAt(index)`
- Search/filter: `findEventsByType`, `findEventsByNode`, `findErrors`, `findRecoveryAttempts`
- Metrics/summary: `getNodeMetrics()`, `getSummary()`

- `TraceSerializer`
- `serialize(trace, options)`
- `deserialize(data, format?)`
- `sanitize(trace, additionalRedactFields?)`

Important type semantics:
- `ReplaySession.currentIndex = -1` means "before first event".
- `ReplayStatus` is `'paused' | 'playing' | 'stepping' | 'completed'`.
- `Breakpoint.type` is `'event-type' | 'node-id' | 'condition' | 'error'`.
- `CapturedTrace.schemaVersion` is fixed to `'1.0.0'` in this implementation.
- `TraceCaptureConfig.snapshotInterval = 0` disables snapshots; `maxEvents = 0` means unlimited retention by contract.

## Dependencies
Direct code dependencies used by replay modules:
- `@dzupagent/core/events`
- `DzupEventBus`, `DzupEvent` for event capture subscription.
- `node:zlib`
- `gzipSync`, `gunzipSync` for binary trace encoding/decoding.
- Internal utility: `../utils/exact-optional.js`
- `omitUndefined` used when materializing replay events/traces and timeline nodes.

Package-level context from `packages/agent/package.json`:
- Replay is distributed as a dedicated subpath export (`./replay` -> `dist/replay.js` / `dist/replay.d.ts`).
- Build entrypoints include `src/replay.ts` via `tsup.config.ts`.

## Integration Points
- Public package surface:
- Consumers import replay APIs from `@dzupagent/agent/replay` (wired through `src/replay.ts` and `package.json` `exports`).

- Internal cross-module consumption:
- `src/observability/trace-ui/types.ts` and `src/observability/trace-ui/index.ts` re-export replay contracts for framework-internal trace helpers.
- `src/observability/trace-ui/utils.ts` uses `TimelineNode`, `NodeMetrics`, and `ReplaySummary` for rendering-independent formatting/tone/summary helpers.

- Test integration:
- `src/__tests__/replay-debugger.test.ts` validates capture, replay engine lifecycle, controller controls/breakpoints, inspector outputs, serializer formats/redaction, and end-to-end flow.
- `src/__tests__/playground-ui-utils.test.ts` validates trace UI helper behavior that depends on replay timeline/summary contracts.

- Root barrel note:
- Current `src/index.ts` does not re-export replay APIs; replay is exposed via the dedicated `./replay` subpath.

## Testing and Observability
Replay-specific coverage currently present in `packages/agent`:
- `replay-debugger.test.ts`
- Event filtering (`includeTypes`/`excludeTypes`), snapshot interval behavior, retention limits, capture lifecycle errors.
- Session creation defaults/options and in-memory session management.
- Playback behavior: play/pause/step/stepBack/seek/reset, status transitions, delay/speed behavior.
- Breakpoint behavior across all breakpoint kinds, including disabled and callback unsubscription behavior.
- State reconstruction and inspector summary/timeline/diff/event filtering.
- Serializer format correctness, auto-detect, validation failures, and redaction behavior.

- `playground-ui-utils.test.ts`
- Formatting/tone/density/diff utilities that operate on replay timeline and summary structures.

Observability surfaces in the replay runtime:
- `ReplayController` callback hooks: `onEvent`, `onBreakpointHit`, `onStatusChange`.
- `ReplayInspector` rollups (`getTimeline`, `getSummary`, `getNodeMetrics`) for building dashboards/tooling.
- `TraceCapture.peek()` and `eventCount` for live capture introspection before `stop()`.

## Risks and TODOs
- `src/replay.ts` comment drift:
- The file comment states root-barrel backward re-exports, but current root `src/index.ts` does not export replay symbols.

- Error breakpoint broadness:
- `ReplayController` treats any event with `data.error` or `data.message` as an error breakpoint hit, which can pause on non-error message payloads.

- Snapshot fidelity constraints:
- `getState()` and inspector diffs rely on available snapshots and merge only snapshot objects; sparse snapshots reduce reconstruction granularity.

- Diff depth:
- `ReplayInspector.computeDiff` is top-level key based and reports nested object changes as a single modified key.

- Validation strictness:
- `TraceSerializer.validateTrace()` checks schema version, `runId`, and `events` array shape, but does not deeply validate per-event payload contracts.

- Retention/index semantics:
- When `maxEvents` is exceeded, older entries are dropped and indices are rewritten, so original absolute event positions are not preserved.

- Session persistence:
- `ReplayEngine` stores sessions only in-memory; there is no built-in persistence, TTL, or multi-process coordination.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

