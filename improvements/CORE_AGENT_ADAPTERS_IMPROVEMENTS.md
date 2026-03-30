# CORE / AGENT / AGENT-ADAPTERS: Gap Analysis and Improvement Proposal

Date: 2026-03-29
Scope: `packages/core`, `packages/agent`, `packages/agent-adapters`

## 1. Executive Summary

The codebase is already substantial and feature-rich, with strong unit-test coverage and broad APIs. The main problems are **not lack of modules**, but:

1. **Uneven implementation maturity**, especially in `agent-adapters` (Qwen/Crush are explicit stubs).
2. **Reliability gaps in adapter success/failure semantics**, which can misclassify failed runs as successful.
3. **Duplication of orchestration/concurrency primitives** across `core`, `agent`, and `agent-adapters`, increasing maintenance cost.
4. **Interface fragmentation** between “core primitives”, “agent runtime”, and “adapter orchestration”, making the stack harder to use consistently.
5. **Missing contract/integration tests** for real adapter behavior and cross-package end-to-end execution.

## 2. Current State Snapshot

- `core` source files: 178 (non-test), test files: 29
- `agent` source files: 118 (non-test), test files: 67
- `agent-adapters` source files: 38 (non-test), test files: 27

General assessment:

- `core`: broad foundational capabilities (LLM, routing, policy/security, MCP, vector, plugin, identity).
- `agent`: mature runtime with tool loop, guardrails, orchestration patterns, workflow/pipeline, structured output.
- `agent-adapters`: wide surface, but provider maturity is inconsistent and orchestration reliability contracts are not fully hardened.

## 3. Gap Analysis by Package

## 3.1 `packages/agent-adapters` (Highest Priority)

### A. Missing/Partial Implementations

1. Qwen adapter is explicitly a stub.
- Evidence: `packages/agent-adapters/src/qwen/qwen-adapter.ts:2`, `:14-16`, `:139-146`, `:241`, `:277-282`
- Gap:
  - Event mapping is provisional.
  - Resume semantics are not provider-guaranteed.
  - CLI argument schema is not finalized.

2. Crush adapter is explicitly a stub.
- Evidence: `packages/agent-adapters/src/crush/crush-adapter.ts:2`, `:10-13`, `:132-137`, `:231-238`, `:268-292`
- Gap:
  - Session resume not supported.
  - Tool event mapping and provider flags remain TODO.

3. No direct tests for concrete `QwenAdapter` or `CrushAdapter` behavior.
- Evidence: no references in `packages/agent-adapters/src/__tests__` for `QwenAdapter` / `CrushAdapter`.
- Gap:
  - Claimed provider support exists at type/router level, but not validated at adapter-runtime level.

### B. Reliability Contract Gaps

1. Registry can mark execution successful if adapter stream ends without throwing, even if adapter emitted `adapter:failed` and no `adapter:completed`.
- Evidence:
  - Registry success on normal generator completion: `packages/agent-adapters/src/registry/adapter-registry.ts:142-150`
  - Qwen/Gemini/Crush catch non-Forge errors, emit failed event, then do not rethrow: `qwen-adapter.ts:218-232`, `gemini-adapter.ts:215-230`, `crush-adapter.ts:208-222`
- Impact:
  - False positives in health/circuit behavior.
  - Fallback chain may stop too early.

2. `OrchestratorFacade.run` defaults provider to `'claude'` and empty result if no completed event observed.
- Evidence: `packages/agent-adapters/src/facade/orchestrator-facade.ts:254-272`
- Impact:
  - Ambiguous success result shape.
  - Hard to distinguish true completion vs silent failure/pathological stream.

3. Supervisor skipped-subtask results hardcode provider `'claude'` as placeholder.
- Evidence: `packages/agent-adapters/src/orchestration/supervisor.ts:323`
- Impact:
  - Misleading telemetry and reports.

4. MapReduce silently drops rejected chunk tasks.
- Evidence: `packages/agent-adapters/src/orchestration/map-reduce.ts:232-237`
- Impact:
  - Under-reported failure counts and incomplete diagnostics.

### C. Abstraction/Reusability Gaps

1. CLI adapters duplicate lifecycle code (start event, abort composition, spawn, completion synthesis, failure mapping).
- Evidence: similar execution blocks in `gemini-adapter.ts`, `qwen-adapter.ts`, `crush-adapter.ts`.
- Impact:
  - Bug fixes and feature parity require repeated edits.

2. Multiple local semaphore implementations instead of shared primitive.
- Evidence:
  - `packages/core/src/concurrency/semaphore.ts`
  - `packages/agent-adapters/src/orchestration/supervisor.ts:175`
  - `packages/agent-adapters/src/orchestration/map-reduce.ts:96`
  - `packages/agent-adapters/src/testing/ab-test-runner.ts:125`
  - `packages/agent/src/orchestration/map-reduce.ts:52`
- Impact:
  - Divergent cancellation/error behavior.

## 3.2 `packages/agent` (Medium Priority)

### A. Architecture/Abstraction Gaps

1. `DzipAgent.generate()` and `DzipAgent.stream()` each implement substantial run logic with overlapping concerns (budget checks, tool execution, stuck detection, usage handling).
- Evidence:
  - generate path starts at `packages/agent/src/agent/dzip-agent.ts:84`
  - stream path starts at `packages/agent/src/agent/dzip-agent.ts:254`
- Impact:
  - Behavioral drift risk between streaming/non-streaming flows.
  - Harder to extend with consistent middleware/telemetry policy.

2. Structured-output fallback is fragile when LLM returns malformed fenced JSON; no dedicated retry/repair policy here.
- Evidence: `packages/agent/src/agent/dzip-agent.ts:240-246`
- Impact:
  - Poor DX for schema-constrained use cases compared to `StructuredOutputAdapter` in adapters package.

### B. Duplication Across Layers

1. MapReduce orchestration exists both in `agent` and `agent-adapters` with separate contracts and semaphore logic.
- Evidence:
  - `packages/agent/src/orchestration/map-reduce.ts`
  - `packages/agent-adapters/src/orchestration/map-reduce.ts`
- Impact:
  - Duplicate maintenance burden and uneven capability evolution.

2. Supervisor/orchestration concepts are duplicated with different execution semantics.
- Evidence:
  - `packages/agent/src/orchestration/orchestrator.ts`
  - `packages/agent-adapters/src/orchestration/supervisor.ts`
- Impact:
  - Increased user confusion over which orchestration API should be used for which runtime.

## 3.3 `packages/core` (Medium Priority)

### A. Incomplete/Placeholder Foundation Pieces

1. Forge URI registry resolver is placeholder logic (returns derived URL, no lookup).
- Evidence: `packages/core/src/identity/forge-uri.ts:179-183`
- Impact:
  - Identity/discovery features are not production-complete.

### B. Abstraction Boundary Gaps

1. Core has reusable concurrency primitive, but higher layers reimplement it.
- Evidence: same as semaphore duplication section.
- Impact:
  - Core is not fully acting as the single reusable substrate.

2. Very broad export surface without stable “capability bundles” for common runtime profiles (minimal, secure, high-throughput, local-only).
- Evidence: `packages/core/src/index.ts` exports a very large mixed API.
- Impact:
  - Steeper adoption curve and accidental coupling.

## 4. Missing Implementation (Concrete)

Priority-ordered missing implementation work:

1. Complete Qwen adapter to non-stub maturity.
- Finalize event mapping against stable provider schema.
- Implement deterministic session resume contract (or explicit capability flag if unsupported).
- Add provider-specific options (context, tool formatting, long-context features).

2. Complete Crush adapter to non-stub maturity.
- Finalize argument mapping.
- Implement or explicitly disable session lifecycle with capability introspection.
- Add local-runtime options (quantization/GPU/context-window controls).

3. Introduce adapter outcome contract and enforce it registry-wide.
- Registry should evaluate terminal state from stream events (`completed` vs `failed`) not only exceptions.
- Adapters should return a terminal outcome with explicit status.

4. Fix orchestration result semantics.
- `run()` should fail fast (typed error result) if no terminal completion event is received.
- Remove fake provider placeholders from skipped tasks.
- MapReduce should preserve and report rejected tasks.

5. Add integration/e2e harness for provider adapters.
- Smoke tests for each adapter with mocked process/SDK event streams.
- Contract tests verifying terminal-state invariants.

## 5. Refactoring Plan for Reusability and Better Abstraction

## 5.1 Unify Adapter Runtime Contracts

Introduce:

- `AdapterCapabilityProfile` (supportsResume, supportsFork, supportsToolCalls, supportsStreaming, supportsCostUsage, maxContext, etc.)
- `AdapterExecutionOutcome`:
  - `{ status: 'completed' | 'failed' | 'cancelled', providerId, sessionId, result?, usage?, error?, durationMs }`

Proposed interface:

```ts
interface AgentCLIAdapterV2 extends AgentCLIAdapter {
  getCapabilities(): AdapterCapabilityProfile
  executeWithOutcome(input: AgentInput): Promise<AdapterExecutionOutcome>
}
```

Benefits:

- Removes terminal-state ambiguity.
- Simplifies `AdapterRegistry` fallback logic.
- Enables capability-driven routing without hardcoded assumptions.

## 5.2 Extract `BaseCliAdapter`

Create reusable abstract class in `agent-adapters`:

- Common process spawn + JSONL reading + abort handling.
- Common lifecycle events (`started`, `completed`, `failed`).
- Adapter-specific hooks:
  - `buildArgs(input)`
  - `buildEnv()`
  - `mapProviderEvent(record)`
  - `normalizeError(err)`

Apply to:

- `GeminiCLIAdapter`
- `QwenAdapter`
- `CrushAdapter`

Benefits:

- Removes repeated boilerplate.
- Enforces consistent behavior for timeout/cancel/errors.

## 5.3 Consolidate Concurrency Primitives in `core`

- Promote `@dzipagent/core` semaphore to canonical implementation.
- Replace local semaphore copies in `agent` and `agent-adapters`.
- Add optional helper utilities:
  - `withSemaphoreLimit(tasks, limit, signal?)`
  - standardized abort error mapping.

## 5.4 Create Shared Orchestration Kernel

Extract common orchestration engine contracts into `core`:

- task graph model
- execution context
- retry policy
- fan-out/fan-in primitives

Then keep package-specific wrappers:

- `agent`: model/tool-centric orchestration wrappers
- `agent-adapters`: provider-routing orchestration wrappers

Benefits:

- Keeps user-friendly APIs while eliminating duplicate engine logic.

## 5.5 Improve Top-Level Usability APIs

Add “easy mode” builders:

- `createAgentRuntime(...)` in `agent`
- `createAdapterRuntime(...)` in `agent-adapters`
- `createDzipRuntime(...)` combining core + agent + adapters with sane defaults.

These should surface:

- one config schema
- one telemetry hook interface
- one error/result envelope

## 6. Proposed New Core Features

## 6.1 Execution Envelope Standard (Cross-Package)

Define a shared envelope in `core`:

- `ExecutionRequest`
- `ExecutionEvent`
- `ExecutionResult`
- `ExecutionError`

All packages adopt this envelope for consistent composability.

## 6.2 Capability Registry (Runtime-Discoverable)

Move provider/agent capability metadata to a registry in `core`:

- static defaults + runtime updates from learning loop
- used by routing, cost optimization, and orchestration planners.

## 6.3 Unified Policy Pipeline

Promote a single policy pipeline in `core` that can be reused by:

- agent tool loop
- adapter execution
- workflow/pipeline runtime

Policy stages:

- pre-execution validation
- runtime budget/guardrail checks
- output compliance checks

## 6.4 Orchestration Telemetry Schema

Create typed telemetry events for:

- node lifecycle
- retry/fallback transitions
- dependency-skip reasons
- terminal outcome quality

This reduces ad-hoc event shapes and makes observability tooling easier.

## 6.5 Identity/Registry Completion

Complete Forge URI registry lookup with real transport + cache + timeout and typed failure modes (instead of placeholder URL generation).

## 7. Recommended Delivery Roadmap

## Phase 1 (1-2 sprints): Reliability First

1. Fix adapter terminal-state contract and registry success logic.
2. Remove placeholder provider IDs and silent rejection drops.
3. Add contract tests for terminal states and fallback behavior.
4. Harden `OrchestratorFacade.run` to return explicit failure on missing completion.

## Phase 2 (2-4 sprints): Adapter Maturity + Reuse

1. Implement `BaseCliAdapter` and migrate Gemini/Qwen/Crush.
2. Raise Qwen and Crush to “non-stub” maturity (or explicitly mark experimental with capability flags).
3. Replace duplicate semaphore implementations with core primitive.

## Phase 3 (3-6 sprints): Core Abstraction Unification

1. Introduce execution envelope standard in core.
2. Extract shared orchestration kernel and converge `agent` + `agent-adapters` orchestration internals.
3. Add unified runtime builders for ease of use.

## 8. Success Criteria

The effort is complete when:

1. No adapter is marked successful without a terminal completion outcome.
2. Qwen/Crush either meet declared support level or are explicitly gated as experimental.
3. Cross-package orchestration primitives are reused rather than reimplemented.
4. End users can compose core + agent + adapters through a single predictable configuration and result model.
5. Contract/integration tests validate provider lifecycle invariants across all adapters.

## 9. Suggested Immediate Action Items (Next PR)

1. Introduce a minimal `AdapterExecutionOutcome` and update `AdapterRegistry.executeWithFallback` to depend on terminal event status.
2. Patch `OrchestratorFacade.run` to fail if no `adapter:completed` observed.
3. Replace `providerId: 'claude'` placeholder in supervisor skip paths with `providerId: 'unknown'` or nullable provider field.
4. Preserve rejected map tasks in `MapReduceOrchestrator` result accounting.
5. Add first contract tests covering:
- adapter emits `adapter:failed` without throw
- no `adapter:completed` emitted
- fallback progression and final outcome correctness

