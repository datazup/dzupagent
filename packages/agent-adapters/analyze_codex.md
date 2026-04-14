# `@dzupagent/agent-adapters` Implementation Analysis (Codex)

Date: 2026-04-03

## Scope

This review analyzes the current implementation in `packages/agent-adapters` with focus on:

- architecture and module boundaries
- reliability and correctness
- routing/recovery behavior
- HTTP/API consistency
- extensibility and operational gaps
- feature roadmap proposals

## Method

- Static review of core sources (`src/**`) and key tests (`src/__tests__/**`).
- Focused test run:
  - `yarn workspace @dzupagent/agent-adapters vitest run src/__tests__/request-schemas.test.ts src/__tests__/adapter-http-handler.test.ts src/__tests__/supervisor.test.ts`
  - Result: `94/94` tests passed.
- Size/shape snapshot:
  - non-test source: `~21,032` LOC
  - test files: `88`
  - largest modules:
    - `workflow/adapter-workflow.ts` (1133 lines)
    - `recovery/adapter-recovery.ts` (1069 lines)
    - `http/adapter-http-handler.ts` (794 lines)
    - `orchestration/parallel-executor.ts` (718 lines)

## Current Architecture (What Exists)

- Provider adapters:
  - SDK: Claude, Codex, Gemini SDK, OpenRouter
  - CLI: Gemini CLI, Qwen, Crush, Goose
- Shared contracts:
  - `AgentEvent`/`AgentCLIAdapter` via `@dzupagent/adapter-types`
- Core runtime:
  - `AdapterRegistry` with fallback + circuit breaker integration
  - routers: tag/cost/round-robin/composite/capability/context/learning
  - orchestration: supervisor, parallel, map-reduce, contract-net
  - workflow DSL + validator + checkpointing
  - middleware: cost tracking/optimization, sanitization, tracing
  - recovery copilot + escalation handlers
  - HTTP facade (`AdapterHttpHandler`)
  - plugin SDK/loader

## Strengths

- Robust fallback execution semantics in registry with explicit terminal checks (`adapter-registry.ts:216-257`, `:288-299`).
- Strong process execution hygiene in CLI helper:
  - abort and timeout handling,
  - SIGTERM->SIGKILL escalation,
  - cleanup in `finally`
  (`process-helpers.ts:71-87`, `:194-221`, `:222-248`).
- Large, meaningful test surface (many subsystems covered).
- Good feature breadth and consistent public exports (`src/index.ts`).

## Severity-Ranked Gap Analysis

### 1) Critical: Recovery can mark failed executions as success

Evidence:

- `AdapterRecoveryCopilot.executeWithRecovery()` records success after stream iteration without verifying terminal `adapter:completed` (`adapter-recovery.ts:401-415`).
- Same pattern in streaming recovery (`adapter-recovery.ts:643-651`).
- `BaseCliAdapter` can emit `adapter:failed` and not throw non-`ForgeError` failures (`base-cli-adapter.ts:147-161`).

Impact:

- false-positive success in recovery paths
- incident masking and incorrect automation decisions

Gap:

- Recovery path bypasses stronger terminal semantics used in registry fallback.

### 2) High: `retry-different-provider` strategy does not actually steer routing

Evidence:

- Strategy writes alternative provider to `input.options.preferredProvider` (`adapter-recovery.ts:959-962`).
- Routing uses unchanged `effectiveTask` via `registry.getForTask(effectiveTask)` (`adapter-recovery.ts:383`).

Impact:

- repeated retries can continue on same failing provider
- reduced recovery effectiveness under outages

Gap:

- Recovery strategy mutates `AgentInput`, but router consumes `TaskDescriptor`.

### 3) High: `/run` streaming behavior diverges from `/run` non-stream behavior

Evidence:

- Non-stream uses `orchestrator.run()` with tags/provider/maxTurns (`adapter-http-handler.ts:393-400`).
- Stream path uses `orchestrator.chat()` (`adapter-http-handler.ts:567-573`), not `run`.

Impact:

- API contract drift when `stream=true`
- routing tags/maxTurns/other options not equivalent across modes

Gap:

- missing single canonical streaming path for `run`.

### 4) High: Provider support is inconsistent across components (`goose`, `openrouter`)

Evidence:

- canonical provider union includes `goose` and `openrouter` (`packages/adapter-types/src/index.ts:10`).
- HTTP request schema excludes them (`http/request-schemas.ts:10`).
- Capability router default matrix omits both (`registry/capability-router.ts:65-120`).
- Context router priority list omits both (`context-aware-router.ts:83-89`).

Impact:

- API-level inability to select all supported providers
- inconsistent routing quality depending on router choice

Gap:

- no shared provider metadata source-of-truth.

### 5) Medium: Context-aware router has unintended ordering bias for omitted providers

Evidence:

- sorting by index in priority list (`context-aware-router.ts:210-214`).
- omitted providers get `indexOf(...) === -1`, which sorts ahead of listed providers.

Impact:

- unexpected provider selection precedence

Gap:

- ordering logic assumes complete priority vector.

### 6) Medium: Codex completion can return empty result despite successful output

Evidence:

- `turn.completed` maps to `adapter:completed` with `result: ''` (`codex-adapter.ts:494-501`).
- fallback completion with `finalResponse` only happens when `!lastUsage` (`codex-adapter.ts:447-457`).
- `OrchestratorFacade.run()` returns `completion.result` (`orchestrator-facade.ts:295-300`).

Impact:

- successful runs can produce empty returned text

Gap:

- completion event source-of-truth is split between usage and message aggregation.

### 7) Medium: Supervisor progress events are hard-coded to provider `claude`

Evidence:

- `providerId: 'claude'` in progress emitter (`supervisor.ts:505`).

Impact:

- telemetry corruption and misleading progress attribution

Gap:

- progress event identity model is not workflow-level.

### 8) Medium: `bid` HTTP endpoint ignores request-level strategy context

Evidence:

- `BidRequestBody` includes `tags?` (`adapter-http-handler.ts:92-95`) and schema supports `criteria` (`request-schemas.ts:41-44`).
- `handleBid()` passes only prompt to orchestrator (`adapter-http-handler.ts:446-449`).

Impact:

- API accepts fields that do not influence execution

Gap:

- request DTO and execution path are misaligned.

### 9) Medium: Shutdown lifecycle is incomplete relative to its own contract

Evidence:

- comment states shutdown should clear session registry/resources (`orchestrator-facade.ts:494-499`).
- implementation only flips `_isShutdown` and resets cost tracking (`orchestrator-facade.ts:501-506`).

Impact:

- lingering in-memory state over long-lived processes

Gap:

- no unified `dispose()` lifecycle across orchestration components.

### 10) Medium (Security/Ops): Webhook URL SSRF validation is hostname-only (no DNS/IP resolution)

Evidence:

- validator blocks literal loopback/private host patterns (`url-validator.ts:141-167`) but does not resolve DNS.

Impact:

- potential DNS-rebinding or internal resolution bypass in hostile network setups

Gap:

- no resolve-and-verify step before outbound webhook calls.

### 11) Low: Typed event contracts are bypassed with `as any` in plugin wiring

Evidence:

- `eventBus.on(... as any)` (`plugin/adapter-plugin.ts:228-230`).

Impact:

- compile-time safety reduction, harder refactors

Gap:

- adapter-layer events are not strongly typed end-to-end at plugin boundary.

## Test Coverage Observations

- Focused tests pass for HTTP schemas/handler and supervisor behavior.
- Gaps in test intent:
  - schema tests currently enforce 5-provider list and do not validate `goose/openrouter` (`request-schemas.test.ts:120-122`).
  - no parity test ensuring `/run` stream and non-stream semantics are equivalent.
  - no recovery test asserting that `adapter:failed` without thrown exception is treated as failure.

## Recommended New Features

### A) Unified Provider Capability Registry (High Value)

Create one source-of-truth metadata module used by:

- HTTP schemas
- task routers
- cost model defaults
- health and docs

Why:

- eliminates provider drift (`goose/openrouter` inconsistencies).

### B) Streaming-First `run` API Contract

Introduce `orchestrator.runStreamed()` returning `AsyncGenerator<AgentEvent>`, and make HTTP `/run?stream=true` call this path.

Why:

- removes `run` vs `chat` semantic split
- preserves tags/preferredProvider/maxTurns/correlation parity.

### C) Recovery State Machine v2

Rework recovery around explicit terminal states:

- success only on `adapter:completed`
- failed terminal on `adapter:failed` without completion
- strategy actions modify a mutable routing context (`preferred`, `exclude` set)

Why:

- resolves the two largest correctness bugs.

### D) Router Constraints API

Add routing constraints to `TaskDescriptor`:

- `excludeProviders: AdapterProviderId[]`
- `pinProvider?: AdapterProviderId`
- `providerTier?: 'local' | 'cloud' | 'any'`

Why:

- enables deterministic behavior for recovery, approvals, and policy engines.

### E) Lifecycle Manager + Disposable Interfaces

Add `dispose()` support for long-lived components and call from `OrchestratorFacade.shutdown()`:

- sessions cleanup/prune
- recovery trace timers
- plugin event subscriptions

Why:

- avoids timer/resource leaks in persistent services.

### F) Telemetry Contract Standardization

Introduce clear event ownership:

- workflow-level progress events (`providerId` optional)
- consistent correlation IDs across HTTP->orchestrator->adapter paths
- typed bridge events without `any` casts

### G) Security Hardening for Webhook Integrations

Add optional secure outbound controls:

- DNS resolution + resolved IP block checks
- response code validation and retry policy
- optional request signing

### H) Policy Engine for Approval/Recovery

Add declarative policy DSL:

- “if cost > X and tags contain prod => approval required”
- “if provider fails with rate_limit => retry-different with cooldown”

### I) Benchmark & Drift Detection Suite

Add `evals`-driven adapter quality/cost latency benchmarks per router strategy to prevent silent regressions.

### J) API Contract Linter

Add build-time checks to detect DTO/schema/handler drift (e.g., accepted field but unused field).

## Prioritized Roadmap

### Phase 1 (Immediate correctness)

1. Fix recovery terminal-state handling and retry-different routing.
2. Fix `/run` streaming parity with non-stream behavior.
3. Fix provider schema/router consistency for `goose` and `openrouter`.
4. Fix supervisor progress provider attribution.

### Phase 2 (Stability + operations)

1. Implement lifecycle/disposal in orchestrator shutdown.
2. Add parity and regression tests for above fixes.
3. Add router/provider metadata centralization.

### Phase 3 (Strategic capability)

1. Policy engine (approval/recovery).
2. Security-hard webhook mode.
3. Benchmark + drift detection automation.

## Suggested Success Metrics

- Recovery false-success rate: target `0%`.
- `/run` stream/non-stream output parity on contract tests: target `100%`.
- Provider-metadata drift incidents: target `0`.
- Mean-time-to-recover from provider outage: reduce by `>40%`.

## Appendix: Key Evidence References

- `packages/agent-adapters/src/recovery/adapter-recovery.ts:383`
- `packages/agent-adapters/src/recovery/adapter-recovery.ts:401`
- `packages/agent-adapters/src/recovery/adapter-recovery.ts:959`
- `packages/agent-adapters/src/base/base-cli-adapter.ts:147`
- `packages/agent-adapters/src/http/request-schemas.ts:10`
- `packages/agent-adapters/src/http/adapter-http-handler.ts:393`
- `packages/agent-adapters/src/http/adapter-http-handler.ts:567`
- `packages/agent-adapters/src/orchestration/supervisor.ts:505`
- `packages/agent-adapters/src/codex/codex-adapter.ts:494`
- `packages/agent-adapters/src/context/context-aware-router.ts:83`
- `packages/agent-adapters/src/registry/capability-router.ts:65`
- `packages/adapter-types/src/index.ts:10`
