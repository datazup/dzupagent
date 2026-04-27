# Context Module Architecture (`packages/agent/src/context`)

## Scope
This document covers the `packages/agent/src/context` folder in `@dzupagent/agent` and its package-level wiring through `packages/agent/src/index.ts`.

It is limited to what this folder owns directly:
- A compatibility re-export for context compression utilities (`auto-compress.ts`).
- A local integration layer that connects token pressure tracking to compression (`token-lifecycle-integration.ts`).

It does not restate internals implemented inside `@dzupagent/context` beyond what is required to describe integration behavior.

## Responsibilities
`src/context` currently has two responsibilities:
- Preserve a stable import path from `@dzupagent/agent` to context utilities implemented in `@dzupagent/context` (`autoCompress`, `FrozenSnapshot`, `AutoCompressConfig`, `CompressResult`).
- Provide `withTokenLifecycle(manager)` hooks that bridge a `TokenLifecycleManager` to run-loop behavior:
  - Track usage (`onUsage`, `trackPhase`).
  - Emit pressure transitions (`onPressure`).
  - Trigger `autoCompress` when status is under pressure (`warn`, `critical`, `exhausted`).
  - Reset manager state after successful compression.

## Structure
Current files in this folder:
- `auto-compress.ts`
  - Re-export-only shim:
    - `autoCompress`, `FrozenSnapshot`
    - `AutoCompressConfig`, `CompressResult`
- `token-lifecycle-integration.ts`
  - Defines integration types:
    - `TokenLifecyclePhase`
    - `TokenPressureListener`
    - `TokenLifecycleHooks`
  - Exposes `withTokenLifecycle(manager)` hook factory.
- `ARCHITECTURE.md`
  - This subsystem document.

Package root export wiring:
- `packages/agent/src/index.ts` re-exports the above APIs under the `// --- Context ---` section.
- `packages/agent/package.json` exports only `"."`, so consumers import these APIs from `@dzupagent/agent` root, not via subpath exports.

## Runtime and Control Flow
`auto-compress.ts` has no runtime logic; it delegates fully to `@dzupagent/context`.

`withTokenLifecycle(manager)` runtime flow:
1. Build local listener state and capture initial manager status.
2. `onUsage(usage, phaseOverride?)`:
  - Tracks input tokens to `phaseOverride ?? 'input'`.
  - Tracks output tokens to `phaseOverride ?? 'output'`.
  - Checks for status transitions and notifies listeners.
3. `trackPhase(phase, tokens)`:
  - Tracks arbitrary non-LLM phases (for example tool output ingestion).
  - Ignores non-positive token counts.
  - Checks transitions and notifies listeners.
4. `maybeCompress(messages, model, existingSummary, config?)`:
  - If manager status is `ok`, returns passthrough (`compressed: false`).
  - Otherwise calls delegated `autoCompress(...)`.
  - If compression succeeds (`compressed: true`), calls `manager.reset()` and emits transition notifications (typically returning to `ok`).
5. `onPressure(listener)` subscribes to transition events and returns unsubscribe.
6. `cleanup()` is idempotent and disables future tracking/notification from this hook set.

Important behavior boundary:
- This integration compresses at `warn` or above.
- The higher-level default-loop plugin in `src/token-lifecycle-wiring.ts` intentionally defers compression to `critical`/`exhausted` and uses `warn` only for soft hints.

## Key APIs and Types
Public APIs surfaced from `@dzupagent/agent`:
- `autoCompress(messages, existingSummary, model, config?)` (re-export from `@dzupagent/context`)
- `FrozenSnapshot` (re-export from `@dzupagent/context`)
- `withTokenLifecycle(manager)` (owned by this folder)

Public types surfaced from `@dzupagent/agent`:
- `AutoCompressConfig`, `CompressResult` (re-export)
- `TokenLifecycleHooks`
- `TokenLifecyclePhase`
- `TokenPressureListener`

`TokenLifecycleHooks` contract:
- Methods:
  - `onUsage(usage, phaseOverride?)`
  - `trackPhase(phase, tokens)`
  - `maybeCompress(messages, model, existingSummary?, config?)`
  - `onPressure(listener) -> unsubscribe`
  - `cleanup()`
- Properties:
  - `status` (derived from current manager status)
  - `manager` (reference to underlying `TokenLifecycleManager`)

## Dependencies
Direct dependencies used by this subsystem:
- `@dzupagent/context`
  - `autoCompress`, `TokenLifecycleManager`, `TokenLifecycleStatus` types.
- `@langchain/core`
  - `BaseChatModel`, `BaseMessage` types used in hook signatures.
- `@dzupagent/core`
  - `TokenUsage` type for usage tracking inputs.

Packaging/build context:
- Included in `@dzupagent/agent` package build (`tsup` entrypoint is `src/index.ts`).
- No dedicated subpath export for `src/context`; access is via root package exports.

## Integration Points
Primary integrations:
- Root package export surface:
  - `src/index.ts` re-exports context APIs for consumers.
- Default agent loop lifecycle wiring:
  - `src/token-lifecycle-wiring.ts` composes this folder's `withTokenLifecycle` hooks into `createTokenLifecyclePlugin(...)`.
  - Plugin policy layer maps status transitions to:
    - `warn`: optional compression hint callback.
    - `critical`: compression attempts.
    - `exhausted`: compression attempts + halt signal.
- Run-loop token accounting:
  - Hook methods are designed to be attached to tool-loop usage events and non-LLM token charges.

## Testing and Observability
Direct package tests for this subsystem:
- `src/__tests__/token-lifecycle-integration.test.ts`
  - Verifies hook API shape, status transitions, listener behavior, compression gating, config forwarding, manager reset behavior, and idempotent cleanup.
  - Uses a mocked `autoCompress` path for deterministic behavior.
- `src/__tests__/token-lifecycle-wiring.test.ts`
  - Verifies plugin-level policy layered on top of these hooks (warn hint vs critical/exhausted compression, halt behavior, reset/cleanup semantics).

Related context behavior is tested in `@dzupagent/context` (outside this folder), where the actual compression algorithm and `FrozenSnapshot` implementation live.

Observability in this folder:
- No logging/event-bus emission is implemented here.
- Pressure transition observability is callback-based through `onPressure(listener)`.

## Risks and TODOs
- Documentation drift risk exists if this module is described as re-export-only; it now also owns token lifecycle integration logic.
- Root-export contract coverage is indirect. Existing tests import internal module paths; there is no explicit test asserting these context APIs remain exported from `@dzupagent/agent` root.
- Compression policy can diverge by integration layer:
  - `withTokenLifecycle`: compress at `warn+`.
  - `createTokenLifecyclePlugin`: compress at `critical+`.
  This is intentional in current code but should stay clearly documented to avoid misconfiguration.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

