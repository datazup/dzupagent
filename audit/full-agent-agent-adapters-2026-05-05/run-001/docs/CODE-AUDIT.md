# Code Quality Audit — `@dzupagent/agent` + `@dzupagent/agent-adapters`

**Date:** 2026-05-05
**Scope:** 693 TypeScript source files, 324 test files
**Lint:** 0 warnings in both packages
**TypeScript errors:** 0

---

## Executive Summary

Both packages are structurally sound with a healthy test suite (184 test files in `agent`, 140 in `agent-adapters`). The dominant finding category is **complexity debt** — several mega-files and functions that do too much — followed by **type-system workarounds** (`as never`, `as unknown as`) that hide either spread-narrowing gaps or missing entries in `DzupEvent`. Test coverage is strong at the class level but thin at the sub-module level for several critical paths.

---

## Findings

### P1 — Must Fix

#### CODE-001 · P1 · `agent:rate_limited` event type missing from `DzupEvent` union
**File:** `packages/agent/src/agent/dzip-agent.ts:730`
`agent:rate_limited` is not a member of the `DzupEvent` discriminated union. The `as never` cast silences the compile error, but consumers subscribing to `DzupEvent` will never see this event type — rate-limit telemetry is silently discarded for any typed subscriber.
**Effort:** 1h — add `{ type: 'agent:rate_limited'; agentId: string; reason: string }` to `DzupEvent` union in `packages/core/src/events/event-types.ts`.

#### CODE-009 · P1 · `executeStreamingToolCall` is 396 LOC with high cyclomatic complexity (~25+)
**File:** `packages/agent/src/agent/run-engine.ts:634–1030`
Single function handles: permission policy checks, budget enforcement, tool existence validation, PII scanning, prompt-injection scanning, approval gating, tool invocation with timeout, tool result scanning, telemetry emission, error categorisation (8 distinct error types), and stat tracking.
**Effort:** 8h — extract `checkToolPermission`, `enforceApprovalGate`, `executeWithPiiScan`, `enforceResultScan` sub-functions. The non-streaming path already has these helpers — wire the streaming variant through them.

#### CODE-010 · P1 · `runToolLoop` is 336 LOC with ~67 branching points
**File:** `packages/agent/src/agent/tool-loop.ts:489–825`
The entire tool loop — model turn, tool scheduling, approval gate polling, stuck detection, budget accounting, error escalation, learning hooks, journal writes — lives in one function. Sub-modules `model-turn-kernel.ts` and `tool-scheduler-kernel.ts` exist as stubs but have not received extracted logic.
**Effort:** 6h — complete the extraction into the existing stubs; `runToolLoop` should become a ≤60 LOC orchestrator.

#### CODE-015 · P1 · `RecoveryAttemptHandler` (658 LOC) has no dedicated unit test
**File:** `packages/agent-adapters/src/recovery/recovery-attempt-handler.ts`
Orchestrates: provider routing, execution tracing, approval gating, escalation, max-attempts exhaustion, cross-provider handoff. Tested only indirectly via the higher-level `AdapterRecovery` class.
**Key untested paths:** trace store throws; escalation at max attempts; cross-provider handoff with pre-aborted signal.
**Effort:** 6h — add `recovery-attempt-handler.test.ts`.

---

### P2 — Should Fix

#### CODE-002 · P2 · Systematic `as never` spread-narrowing workaround (15 occurrences)
**Files:** `dzip-agent.ts:514`, `streaming-run.ts:145`, `run-engine.ts:741,895`, `tool-lifecycle-policy.ts:130,180,242,288`, `policy-enabled-tool-executor.ts:148,353,398,556,571`, `approval-gate.ts:88,144,161`
Root cause: `DzupEvent` union members require certain fields as non-optional but emit code spreads them conditionally. Suppresses compile-time exhaustiveness checks — a future field addition to a union member will not produce a compile error at the emit site.
**Effort:** 4h — make relevant optional fields optional in the union, or use direct assignments.

#### CODE-003 · P2 · Unsafe double-cast `as unknown as X` (10 occurrences)
**Files:** `dzip-agent.ts:463`, `mailbox/agent-mailbox.ts:91,93`, `orchestration/delegating-supervisor.ts:552`, `structured-output.ts:542`, `run-manager.ts:358`, `session-registry.ts:527`, `self-correction/recovery-feedback.ts:126,152,192`
`rateLimiter` and `registry` casts expose internal implementation details through reflection.
**Effort:** 3h — add typed interfaces or getter methods.

#### CODE-004 · P2 · Unsafe `config as Record<string, unknown>` in CodexAdapter timeout
**File:** `packages/agent-adapters/src/codex/codex-adapter.ts:508`
`timeoutMs` is not declared on `AdapterConfig`. Double cast will silently return `undefined` if the field is renamed. Critical path — controls hard abort of Codex streaming thread.
**Effort:** 30min — add `timeoutMs?: number` to `AdapterConfig`.

#### CODE-006 · P2 · Provider failover loop duplicated between `dzip-agent.ts` and `streaming-run.ts`
**Files:** `dzip-agent.ts:766–815`, `streaming-run.ts:148–207`
Both implement the same algorithm. Bug fixes must be mirrored. Already diverged: streaming path does NOT call `registry?.recordProviderSuccess()` on success.
**Effort:** 3h — extract shared `attemptWithFailover<T>` in new `provider-failover.ts`; fix the streaming success-recording gap.

#### CODE-007 · P2 · `sha256` content-hash helper duplicated across syncer + importer
**Files:** `dzupagent/syncer.ts:127–128`, `dzupagent/importer.ts:132,182`
**Effort:** 30min — move to `dzupagent/hash-utils.ts`.

#### CODE-011 · P2 · `TeamRuntime` is 1,281 LOC with 24 private/protected methods
**File:** `packages/agent/src/orchestration/team/team-runtime.ts`
Implements 5 coordination patterns (supervisor, contract_net, blackboard, peer_to_peer, council) in one class, plus circuit-breaker state, OTel, policy validation, blackboard context, checkpoint handling, concurrency semaphore.
**Effort:** 10h — extract each `run*` method into a `TeamCoordinationStrategy` concrete class.

#### CODE-012 · P2 · `BaseCliAdapter.execute` is 234 LOC
**File:** `packages/agent-adapters/src/base/base-cli-adapter.ts:324–558`
One method handles: session ID generation, assertReady, event emission, artifact watcher, abort controller, signal merging, rules plan, spawn args, env building, process spawning, stdout/stderr piping, event parsing, interaction detection, governance events, error normalisation, completion/failure events.
**Effort:** 6h — extract `spawnAndStream(input, signal)` and `parseProviderEvents(rawLine)` private methods.

#### CODE-013 · P2 · `CodexAdapter.runStreamedThread` is 291 LOC
**File:** `packages/agent-adapters/src/codex/codex-adapter.ts:494–785`
**Effort:** 4h — extract `classifyCodexItem(item)` and `createThreadAbortController(timeoutMs, callerSignal)`.

#### CODE-014 · P2 · `AdapterWorkflowBuilder` is 1,128 LOC with no internal decomposition
**File:** `packages/agent-adapters/src/workflow/adapter-workflow.ts`
Module-level helpers `executeLoop` and `executeAdapterStep` are defined at the bottom of the same 1,128 LOC file.
**Effort:** 6h — move execution helpers to `adapter-workflow-execution.ts` (already partially exists); extract `build()` pipeline-assembly logic into a `PipelineAssembler` helper.

#### CODE-016 · P2 · `runToolLoop` (336 LOC) tested only via integration
**File:** `packages/agent/src/agent/tool-loop.ts:489`
Error paths deep in the loop (learning hook failure, approval-gate resume, budget warning during stuck detection) require constructing a complete agent to test them.
**Effort:** 4h — add `tool-loop-direct.test.ts` calling `runToolLoop` directly with injected mocks.

#### CODE-017 · P2 · `openStreamWithProviderFailover` has no path-level test
**File:** `packages/agent/src/agent/streaming-run.ts:148`
The CODE-006 divergence (missing `recordProviderSuccess`) would not be caught by existing tests.
**Effort:** 3h — add failover scenarios to `streaming-run-failover.test.ts`.

#### CODE-018 · P2 · `BaseCliAdapter.execute` tested only via artifact-watcher side effects
**File:** `packages/agent-adapters/src/base/base-cli-adapter.ts:324`
Abort signal combination, rules plan resolution, process exit code mapping, stderr piping, interaction detection, governance event emission — all untested.
**Effort:** 4h — add `base-cli-adapter-execute.test.ts` covering abort, error normalisation, governance events.

#### CODE-023 · P2 · `console.log`/`console.debug` in 8+ production files
**Key files:** `codex-adapter.ts` (11 console calls), `orchestration-telemetry.ts:36,50,68`, `self-learning-hook.ts:201`, `syncer.ts:610`, `memory-enrichment.ts:99,211`
**Effort:** 3h — replace with `@dzupagent/logger`.

---

### P3 — Nice to Have

#### CODE-005 · P3 · (False positive) — exported functions with inferred return types — no action required

#### CODE-008 · P3 · Retry-with-backoff loop pattern repeated in 5 locations
**Files:** `pipeline-runtime.ts:405–434`, `skill-chain-executor.ts:203–280`, `agent-mailbox.ts:151–180`, `policy-enabled-tool-executor.ts:260–290`, `recovery-loop-runner.ts:43+`
`retry-policy.ts` already exists — callers re-implement the loop instead of delegating.
**Effort:** 6h — add `withRetry(fn, policy, onRetry)` utility.

#### CODE-019 · P3 · Routing strategies lack failure/edge-case tests
**Files:** `routing/hash-routing.ts`, `llm-routing.ts`, `round-robin-routing.ts`, `rule-based-routing.ts`
**Effort:** 3h — extend `routing-policy.test.ts` with failure describe blocks.

#### CODE-020 · P3 · `tool-lifecycle-policy.ts` (359 LOC) tested only via run-engine integration
**File:** `packages/agent/src/agent/tool-lifecycle-policy.ts`
**Effort:** 3h — add `tool-lifecycle-policy.test.ts`.

#### CODE-021 · P3 · 8 `eslint-disable` suppressions without justification comments
**Files:** `failure-analyzer.ts:43`, `output-refinement.ts:211,222`, `root-cause-analyzer.ts:131,160`, `reflection-loop.ts:123,128,140`
**Effort:** 1h — add inline justification.

#### CODE-022 · P3 · `eslint-disable-next-line @typescript-eslint/no-explicit-any` in test file
**File:** `packages/agent/src/__tests__/edge-resolution-branches.test.ts:88`
**Effort:** 30min — use `as unknown as EdgeType` cast instead.

#### CODE-024 · P3 · `AgentPlayground` exported from three barrel locations with no external consumers
**Files:** `src/index.ts:392`, `src/playground.ts:10`, `src/playground/index.ts:1`
**Effort:** 1h — add `@deprecated` JSDoc on non-canonical exports.

#### CODE-025 · P3 · `memoryFrame: unknown` on `PreparedRunState` is an untyped escape hatch
**File:** `packages/agent/src/agent/run-engine.ts:77`
**Effort:** 2h — make `PreparedRunState` generic.

#### CODE-026 · P3 · Supervision-policy circuit-breaker state is class-level mutable (not run-scoped)
**File:** `packages/agent/src/orchestration/team/team-runtime.ts:284`
**Effort:** 2h — document as intentional with a `resetCircuitBreakers()` method, or reset in `execute()`.

---

## Summary

| Severity | Count |
|----------|-------|
| P1 | 4 |
| P2 | 14 |
| P3 | 9 |
| **Total** | **27** |
