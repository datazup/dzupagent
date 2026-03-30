# CORE / AGENT / AGENT-ADAPTERS Implementation Plan

Date: 2026-03-29
Source review: `improvements/CORE_AGENT_ADAPTERS_IMPROVEMENTS.md`
Scope: `packages/core`, `packages/agent`, `packages/agent-adapters`

## 1) Review Outcome

The proposal is directionally correct. The highest-risk gaps are confirmed:

1. Adapter fallback success semantics can produce false positives when no terminal `adapter:completed` event is emitted.
2. `OrchestratorFacade.run()` can return ambiguous success with default provider/result.
3. Placeholder provider IDs (`'claude'`) are used where provider is unknown or execution is skipped.
4. Qwen/Crush adapters are explicitly stub-level and lack direct adapter-runtime contract tests.
5. Concurrency primitives are duplicated across packages.

Important refinement:
- Replacing placeholder provider IDs with `'unknown'` is not type-safe with current `AdapterProviderId`.
  - Current type is strict union: `'claude' | 'codex' | 'gemini' | 'qwen' | 'crush'`.
  - Plan must include a type-contract change (`providerId?: AdapterProviderId` or explicit `providerId: AdapterProviderId | null`) before switching placeholders.

## 2) Delivery Strategy

Use 3 phases with strict test gates to reduce regression risk.

## Phase 1 (Reliability Hardening, immediate)

Goal: remove terminal-state ambiguity and incorrect success accounting.

### 1.1 AdapterRegistry terminal-state contract
- File: `packages/agent-adapters/src/registry/adapter-registry.ts`
- Changes:
  1. Track terminal events while consuming adapter stream:
     - `sawCompleted`
     - `sawFailed`
     - `lastFailedEvent`
  2. Record success only if `sawCompleted === true`.
  3. If stream ends without completed:
     - mark provider failure,
     - continue fallback chain,
     - emit consistent failure event with reason (`MISSING_TERMINAL_COMPLETION`).
  4. If `adapter:failed` is observed and no later completion event, treat adapter as failed even if no throw occurred.

### 1.2 Harden `OrchestratorFacade.run()`
- File: `packages/agent-adapters/src/facade/orchestrator-facade.ts`
- Changes:
  1. Remove implicit defaults (`result=''`, `providerId='claude'`) as success path.
  2. Track terminal completion explicitly.
  3. Throw typed `ForgeError` (or return typed failure result if API is expanded) when no `adapter:completed` is observed.

### 1.3 Fix placeholder provider IDs (type-safe)
- Files:
  - `packages/agent-adapters/src/orchestration/supervisor.ts`
  - `packages/agent-adapters/src/orchestration/map-reduce.ts`
  - `packages/agent-adapters/src/types.ts`
- Changes:
  1. Update result types where provider may be unknown/skipped:
     - supervisor subtask result `providerId` -> `AdapterProviderId | null`
     - map-reduce per-chunk `providerId` -> `AdapterProviderId | null`
  2. Replace hardcoded `'claude'` placeholders with `null`.
  3. Ensure event payloads still use concrete provider IDs where required by event contracts.

### 1.4 MapReduce rejection accounting
- File: `packages/agent-adapters/src/orchestration/map-reduce.ts`
- Changes:
  1. Convert `Promise.allSettled` rejections into explicit failed chunk records.
  2. Include rejection failures in `failedChunks` and `perChunkStats`.
  3. Preserve deterministic ordering by chunk index.

### Phase 1 test additions
- New tests:
  - `packages/agent-adapters/src/__tests__/adapter-registry.test.ts`
  - extend `orchestrator-facade.test.ts`
  - extend `map-reduce.test.ts`
  - extend `supervisor.test.ts`
- Cases:
  1. adapter emits `adapter:failed`, does not throw -> fallback proceeds.
  2. adapter stream ends without completion -> treated as failure.
  3. `run()` without completion -> typed failure.
  4. map-reduce rejected task increments failure stats.
  5. skipped supervisor task returns `providerId: null`.

Phase 1 gate:
- `yarn workspace @dzipagent/agent-adapters test`
- `yarn typecheck`

## Phase 2 (Adapter Maturity + Reuse)

Goal: reduce duplication and raise Qwen/Crush maturity from stub to explicit capability-driven behavior.

### 2.1 Introduce `BaseCliAdapter`
- New file candidate: `packages/agent-adapters/src/base/base-cli-adapter.ts`
- Extract shared logic:
  1. spawn + stream loop
  2. abort composition
  3. started/completed/failed lifecycle handling
  4. fallback completion synthesis behavior (policy-driven, not implicit)
  5. error normalization

### 2.2 Migrate adapters
- Files:
  - `.../gemini/gemini-adapter.ts`
  - `.../qwen/qwen-adapter.ts`
  - `.../crush/crush-adapter.ts`
- Changes:
  1. Move shared execution skeleton into base class.
  2. Keep adapter-specific hooks:
     - args builder
     - env builder
     - provider event mapping
     - resume support behavior
  3. Explicit capability reporting (resume support, tool-call support).

### 2.3 Add direct adapter tests for Qwen/Crush
- Test approach: mock `isBinaryAvailable` and `spawnAndStreamJsonl` in unit tests.
- New tests:
  - `qwen-adapter.test.ts`
  - `crush-adapter.test.ts`
- Cases:
  1. binary missing -> `ADAPTER_SDK_NOT_INSTALLED`
  2. maps known events correctly
  3. non-Forge runtime errors produce failed event semantics
  4. resume behavior matches declared capability

Phase 2 gate:
- `yarn workspace @dzipagent/agent-adapters test`
- `yarn typecheck`

## Phase 3 (Cross-Package Convergence)

Goal: remove duplicated primitives and align contracts across `core`, `agent`, `agent-adapters`.

### 3.1 Semaphore consolidation
- Use `@dzipagent/core` semaphore as canonical primitive.
- Required enhancement in core:
  - add optional abort-aware acquire helper or wrapper utility for orchestration use-cases.
- Replace local semaphores in:
  - `agent` map-reduce
  - `agent-adapters` supervisor/map-reduce/ab-test-runner

### 3.2 Agent API convergence (non-breaking first)
- `packages/agent/src/agent/dzip-agent.ts`
- Extract shared pre-run setup between `generate()` and `stream()` into internal helper(s).
- Add structured-output fallback repair path (retry with repair prompt before failing JSON parse).

### 3.3 Core identity resolver completion (separate PR)
- `packages/core/src/identity/forge-uri.ts`
- Implement real registry resolver transport, timeout, and typed error behavior.

Phase 3 gate:
- `yarn build`
- `yarn typecheck`
- `yarn lint`
- `yarn test`

## 3) PR Breakdown (recommended)

1. PR-1: Reliability semantics (`registry`, `run`, placeholders, map-reduce accounting, tests).
2. PR-2: BaseCliAdapter + Gemini/Qwen/Crush migration + direct adapter tests.
3. PR-3: Semaphore consolidation + agent run-path refactor.
4. PR-4: Forge URI registry resolver completion.

## 4) Definition of Done

1. No adapter is marked successful without observing terminal completion semantics.
2. Fallback always proceeds on silent failure/non-completion.
3. Unknown/skipped provider states are represented explicitly in types (no fake provider IDs).
4. Qwen/Crush have direct unit tests for execution contract behavior.
5. Duplicated semaphores are removed or wrapped by a single core primitive.
6. Full monorepo quality gate passes:
   - `yarn build && yarn typecheck && yarn lint && yarn test`

