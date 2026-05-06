# Code Quality — Major Changes (P3, 16h+ each)

Larger restructurings that span multiple files or weeks. Plan a dedicated sprint per item.

---

## MC-001: Split top-5 oversized files (>1,000 LOC) per-domain

**Finding:** CODE-001
**Effort:** 16-24h per file, ~3 dev-days total per file (split + verify + downstream typecheck cascade)
**Files:**
- `packages/flow-ast/src/validate.ts` (1,410 LOC)
- `packages/agent/src/agent/run-engine.ts` (1,186 LOC)
- `packages/agent-adapters/src/codex/codex-adapter.ts` (1,126 LOC)
- `packages/flow-ast/src/parse.ts` (1,077 LOC) — see also R-004 (P2 slice)
- `packages/agent/src/pipeline/pipeline-runtime.ts` (1,071 LOC)
- `packages/flow-dsl/src/normalize.ts` (1,018 LOC)
**Change:**
1. For each file, identify natural split axes (per node-type, per stage, per concern).
2. Move chunks into `<file-stem>/<axis>.ts` files.
3. Keep the public API of the original file unchanged — it becomes a barrel.
4. Verify no consumer relies on internal symbols (run typecheck across full monorepo).
5. Each split file ≤ 400 LOC.

**Validation:**
```bash
yarn verify
# All package tests must remain green; downstream apps (codev-app, testman) typecheck must pass.
```

**Target agent:** dzupagent-agent-dev (architecture-aware refactor; coordinate with whoever owns that module).

---

## MC-002: Build `test-utils` factories and migrate `as never` test mocks

**Finding:** CODE-014, CODE-021
**Effort:** ~24h
**Files:**
- New under `packages/test-utils/src/factories/`:
  - `mock-event-bus.ts` — typed partial `DzupEventBus`
  - `mock-memory-client.ts` — typed partial `MemoryClient`
  - `mock-agent.ts` — typed partial `DzupAgent` (or its config)
  - `mock-tool.ts` — typed `StructuredTool`
  - `mock-llm.ts` — typed `BaseChatModel`
  - `mock-dom.ts` — for connectors-browser
  - `mock-codegen-context.ts` — for codegen lesson tests
- Then mass-migrate `as never` test casts in:
  - `packages/agent/src/__tests__/{memory-write-back,agent-factory,run-engine,dzip-agent-provider-fallback,dzip-agent}.test.ts` (72 casts)
  - `packages/codegen/src/__tests__/{lesson-extractor-and-reflection,skill-resolver}.test.ts` (32 casts)
  - `packages/connectors-browser/src/__tests__/{extraction,auth-handler,link-extractor}.test.ts` (38 casts)
**Change:**
1. Build factories with strong types (`DeepPartial<T> & { … overrides … }`) — no `as never`, only explicit defaults.
2. For each test file: replace `someValue as never` with `factories.createMockX({ ...override })`.
3. Some casts will reveal genuinely missing fields in test fixtures — fix the test, don't paper over it.
4. Document factory APIs in `test-utils/README.md`.

**Validation:**
```bash
yarn test
grep -rcE "\bas never\b" packages/agent/src/__tests__ packages/codegen/src/__tests__ packages/connectors-browser/src/__tests__ \
  --include="*.test.ts" | awk -F: '{s+=$NF} END{print s}'
# Expect total ≤ 30 (down from ~140)
```

**Target agent:** dzupagent-test-dev (lead) + dzupagent-agent-dev (review)

---

## MC-003: Resize barrel files (`core/index.ts`, `agent-adapters/index.ts`, `agent/index.ts`)

**Finding:** CODE-013, CODE-012
**Effort:** ~16h
**Files:**
- `packages/core/src/index.ts` (875 LOC)
- `packages/agent-adapters/src/index.ts` (587 LOC)
- `packages/agent/src/index.ts` (821 LOC, 40 deprecated re-exports)
**Change:**
1. **core**: Curate the public surface. Move detailed re-exports into `core/src/{events,llm,memory,security,plugins,…}/index.ts` (already exist). Root barrel only re-exports curated names.
2. **agent-adapters**: same approach.
3. **agent**: REMOVE the 40 `@deprecated` re-exports (consumers must import from subpath). Coordinate with codev-app maintainers on a single migration commit. If removal blocked, just enforce that subpath imports are required via an ESLint `no-restricted-imports` rule in consuming apps.
4. Run a full monorepo typecheck (`yarn verify` at root) to catch any consumer that breaks.

**Validation:**
```bash
yarn verify
wc -l packages/core/src/index.ts packages/agent-adapters/src/index.ts packages/agent/src/index.ts
# Expect each ≤ 250 LOC.
```

**Target agent:** dzupagent-core-dev + coordination with codev-app maintainer

---

## MC-004: Move event-types to family-split structure

**Finding:** CODE-024
**Effort:** ~16h
**Files:**
- `packages/core/src/events/event-types.ts` (717 LOC, all types)
- New: `packages/core/src/events/types/{lifecycle,tool,memory,governance,orchestration,observability}.ts`
**Change:**
1. Group the existing event-type union by family (lifecycle/run, tool, memory/recall, governance/security, orchestration, observability/metrics).
2. Move each group into its own file under `events/types/`.
3. `event-types.ts` re-exports everything; consumers see no change.
4. Each new file should have a header comment listing its event names and a brief summary.

**Validation:**
```bash
yarn typecheck
yarn test
wc -l packages/core/src/events/event-types.ts   # expect ≤ 200
```

**Target agent:** dzupagent-core-dev

---

## MC-005: Centralize timeouts and retry constants

**Finding:** CODE-019
**Effort:** ~16h (audit + module + replacement + doc)
**Files:**
- New: `packages/core/src/config/timeouts.ts`
- Replace literals across:
  - `packages/agent-adapters/src/{claude/claude-adapter.ts,utils/process-helpers.ts,orchestration/contract-net.ts}`
  - `packages/server/src/routes/{spawn-compiler-bridge.ts,events.ts}`
  - `packages/create-dzupagent/src/utils.ts`
  - `packages/agent/src/pipeline/pipeline-runtime-types.ts`
**Change:**
1. Create `core/src/config/timeouts.ts` with named constants:
   ```ts
   export const TIMEOUTS = {
     SDK_HEALTH_CHECK_MS: 5_000,
     PROCESS_KILL_GRACE_MS: 5_000,
     COMPILE_BRIDGE_POLL_MS: 5_000,
     CONTRACT_NET_BID_MS: 5_000,
     SCAFFOLD_FETCH_MS: 5_000,
     EVENT_STREAM_HEARTBEAT_MS: 1_000,
     PIPELINE_BACKOFF_MAX_MS: 30_000,
     ERROR_CORRELATION_WINDOW_MS: 60_000,
     LATENCY_WARN_MS: 30_000,
     LATENCY_CRITICAL_MS: 60_000,
   } as const
   ```
2. Replace literal sites; verify behaviour identical.
3. Document each constant's tuning rationale.

**Validation:**
```bash
yarn typecheck
yarn test
grep -rE "(setTimeout|setInterval)\s*\(\s*[^,]+,\s*[0-9]{4,}" packages/*/src --include="*.ts" \
  | grep -v "__tests__\|fixtures\|TIMEOUTS\." | wc -l
# Expect significant drop from baseline (~10 sites).
```

**Target agent:** dzupagent-core-dev

---

## MC-006: Coverage uplift for top 10 zero-test src files (≥ 250 LOC each)

**Finding:** CODE-005, CODE-006, CODE-007
**Effort:** ~32h (one engineer-week)
**Files (priority order):**
1. `packages/agent/src/agent/run-engine-streaming-helpers.ts` (717)
2. `packages/agent/src/agent/run-engine-generate-helpers.ts` (426)
3. `packages/agent/src/agent/tool-loop-types.ts` (462) — type-mostly; verify
4. `packages/agent/src/self-correction/root-cause-analyzer.ts` (407)
5. `packages/server/src/deploy/confidence-calculator.ts` (348)
6. `packages/server/src/scorecard/probe-collector.ts` (340)
7. `packages/server/src/runtime/mcp-tool-instantiation.ts` (285)
8. `packages/agent/src/agent/structured-generate.ts` (327)
9. `packages/server/src/deploy/deployment-history-store.ts` (255)
10. `packages/agent/src/agent/tool-loop-learning.ts` (289)
**Change:** For each, add a focused unit test file with ≥ 12 cases targeting branch coverage ≥ 70%.

**Validation:**
```bash
yarn test --coverage
# Each module reaches ≥ 70% branch coverage; aggregate test count rises by ≥ 100.
```

**Target agent:** dzupagent-test-dev (lead, with module-owner consultation)

---

## MC-007: Per-node test fixtures for `flow-ast/parse.ts` (16 nodes)

**Finding:** CODE-007
**Effort:** ~24h
**Files:**
- New: `packages/flow-ast/test/parsers/{action,approval,branch,classify,clarification,emit,foreach,memory,parallel,persona,route,sequence,spawn,checkpoint,restore,complete}.test.ts`
**Change:** For each per-node parser, drive ≥ 5 inputs:
1. Valid happy-path
2. Missing required field → emits `MISSING_REQUIRED_FIELD` issue
3. Wrong-type required field → emits typed issue at correct path
4. Invalid optional field present → issue
5. Multiple issues collected (not short-circuited)
Use a shared fixture loader (`loadFixture('approval/missing-decision.json')`).

**Validation:**
```bash
yarn workspace @dzupagent/flow-ast test --coverage
# parse.ts branch coverage ≥ 80%, validate.ts ≥ 80%.
```

**Target agent:** dzupagent-test-dev
