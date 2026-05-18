# Context Module Architecture (`packages/agent/src/context`)

## Scope
This document covers the context-facing module in `packages/agent/src/context` and its direct integration points inside `@dzupagent/agent`.

In-scope files:
- `src/context/auto-compress.ts`
- `src/context/token-lifecycle-integration.ts`
- `src/context/ARCHITECTURE.md`

In-scope package wiring:
- `src/index.ts` context exports
- `src/runtime.ts` context exports
- `src/token-lifecycle-wiring.ts` consumption of `withTokenLifecycle`
- runtime call sites that feed token usage and invoke compression/halt behavior in non-streaming and streaming loops

Out of scope:
- compression algorithm internals from `@dzupagent/context` (`autoCompress`, `FrozenSnapshot`)
- broader agent subsystems unrelated to token lifecycle/context compression

## Responsibilities
`src/context` has two concrete responsibilities:

1. Compatibility facade for compression primitives:
- Re-export `autoCompress`, `FrozenSnapshot`, `AutoCompressConfig`, and `CompressResult` from `@dzupagent/context` so agent consumers can keep importing from `@dzupagent/agent`.

2. Token lifecycle integration hooks:
- Provide `withTokenLifecycle(manager)` to bind a `TokenLifecycleManager` to agent loop-friendly callbacks:
- `onUsage` for LLM usage accounting
- `trackPhase` for non-LLM token accounting
- `maybeCompress` for pressure-triggered compression
- `onPressure` for transition callbacks
- `cleanup` for lifecycle teardown

## Structure
- `auto-compress.ts`
- Re-export-only shim to `@dzupagent/context`.

- `token-lifecycle-integration.ts`
- Owns integration types and logic:
- `TokenLifecyclePhase`
- `TokenPressureListener`
- `TokenLifecycleHooks`
- `withTokenLifecycle(manager)`

- `ARCHITECTURE.md`
- This architecture description.

Package/export surface:
- `src/index.ts` exports the context API at package root (`@dzupagent/agent`).
- `src/runtime.ts` also exports the same context API for `@dzupagent/agent/runtime`.
- `package.json` has exports for `"."` and `"./runtime"`, but no dedicated `"./context"` subpath.

## Runtime and Control Flow
Core context flow is split across two layers:

1. Low-level hooks (`withTokenLifecycle` in `src/context/token-lifecycle-integration.ts`)
- Creates local listener state and snapshots initial manager status.
- `onUsage(usage, phaseOverride?)`:
- tracks positive `inputTokens` and `outputTokens` into the manager
- defaults phases to `input` / `output` unless overridden
- calls transition notifier
- `trackPhase(phase, tokens)`:
- tracks arbitrary positive token charges
- ignores `tokens <= 0`
- calls transition notifier
- `maybeCompress(messages, model, existingSummary?, config?)`:
- returns passthrough when manager status is `ok`
- otherwise calls `autoCompress(...)`
- if `compressed === true`, resets manager and emits post-reset transition notification
- `onPressure(listener)` registers transition listeners and returns unsubscribe.
- listener failures are swallowed so run-loop control flow is not interrupted.
- `cleanup()` is idempotent and disables future tracking/notifications for this hook instance.

2. Default loop plugin (`createTokenLifecyclePlugin` in `src/token-lifecycle-wiring.ts`)
- Builds on top of `withTokenLifecycle`.
- Policy behavior:
- `warn`: emit optional `onCompressionHint`, no compression
- `critical` or `exhausted`: forward `onPressure`
- `maybeCompress`: only compress for `critical`/`exhausted`
- `shouldHalt`: true only on `exhausted`
- no manager provided: returns a no-op plugin

Runtime call sites in agent execution:
- `prepareRunState` charges prompt construction tokens via `tokenLifecyclePlugin.trackPhase('prompt', ...)`.
- Non-streaming tool loop (`runToolLoop` path):
- usage is recorded each LLM turn via `onUsage`
- `maybeCompress` runs after usage recording and before halt/tool execution
- `shouldHalt` runs before tool execution and can stop with `token_exhausted`
- tool-result payloads are charged through `trackPhase('tool-result', ...)`
- Streaming run (`streamRun` path):
- wraps `options.onUsage` to also feed `tokenLifecyclePlugin.onUsage`
- runs compression adoption before halt/tool handling
- checks `shouldHalt` before tool execution
- charges tool-result payloads through `trackPhase('tool-result', ...)`

## Key APIs and Types
Public API exposed via `@dzupagent/agent` and `@dzupagent/agent/runtime`:
- `autoCompress`
- `FrozenSnapshot`
- `withTokenLifecycle`

Public types:
- `AutoCompressConfig`
- `CompressResult`
- `TokenLifecycleHooks`
- `TokenLifecyclePhase`
- `TokenPressureListener`

`TokenLifecycleHooks` contract:
- methods:
- `onUsage(usage, phaseOverride?)`
- `trackPhase(phase, tokens)`
- `maybeCompress(messages, model, existingSummary?, config?)`
- `onPressure(listener): () => void`
- `cleanup()`
- properties:
- `status` (live manager status)
- `manager` (underlying `TokenLifecycleManager`)

## Dependencies
Direct code dependencies used by `src/context`:
- `@dzupagent/context`
- `autoCompress`
- `TokenLifecycleManager` and `TokenLifecycleStatus` types
- `@dzupagent/core/llm`
- `TokenUsage` type
- `@langchain/core`
- `BaseChatModel` type
- `BaseMessage` type

Package-level dependency context (`packages/agent/package.json`):
- runtime deps include `@dzupagent/context` and `@dzupagent/core`
- peer deps include `@langchain/core`

## Integration Points
- `src/token-lifecycle-wiring.ts`
- adapts `withTokenLifecycle` into `AgentLoopPlugin` (`createTokenLifecyclePlugin`)
- `src/agent/run-engine.ts`
- prompt-phase token charging (`trackPhase('prompt', ...)`)
- `src/agent/run-engine-generate-tool-loop.ts`
- tool-result token charging (`trackPhase('tool-result', ...)`)
- tool-loop `maybeCompress`/`shouldHalt` wiring
- `src/agent/tool-loop/loop-stages.ts`
- resilient compression execution with `context:compress_failed` event emission on hook failure
- `src/agent/streaming-run.ts` and helpers
- usage forwarding to plugin in stream mode
- compression adoption and halt checks in streaming loop
- tool-result token charging in streaming tool handler
- package barrels:
- `src/index.ts`
- `src/runtime.ts`

## Testing and Observability
Direct tests covering this module and its wiring:
- `src/__tests__/token-lifecycle-integration.test.ts`
- `withTokenLifecycle` API shape, usage/phase tracking, pressure transitions, compression gating, reset behavior, cleanup behavior
- `src/__tests__/token-lifecycle-wiring.test.ts`
- `createTokenLifecyclePlugin` no-op mode, hint/pressure callbacks, compression thresholds, halt behavior, reset/cleanup
- `src/__tests__/token-lifecycle-stream-wiring.test.ts`
- stream-path `onUsage` forwarding and user callback preservation
- `src/__tests__/track-phase-wiring.test.ts`
- prompt/tool-result phase charging in run-engine wiring
- `src/__tests__/tool-loop-token-halt.test.ts`
- loop stop behavior for `shouldHalt` and `token_exhausted`

Observability behavior:
- `src/context` itself emits no logs or event-bus events.
- Transition observability is callback-based (`onPressure`).
- Failures in compression hooks are handled by consumers; the tool loop emits `context:compress_failed` when `maybeCompress` throws.

## Risks and TODOs
- Threshold split is intentional but easy to misread:
- `withTokenLifecycle` compresses at `warn+`
- default plugin compresses only at `critical+`
- APIs are exported via root/runtime barrels without a dedicated `./context` export; consumers importing internal paths may bypass stable entrypoints.
- Phase names are string-based (`TokenLifecyclePhase` allows arbitrary strings), so naming drift (`tool-output` vs `tool-result`) is possible across integrations.
- Export-contract tests are mostly behavior-level; there is no dedicated package-level test that asserts both root and runtime barrels keep exporting this context surface.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js