# Wave 18 — Implementation Tracking

> **Start date**: 2026-04-17  
> **Target**: ≥200 new tests, close 5 critical gaps  
> **Theme**: Working Memory + Permission Tiers + Stuck Detector Hardening + Eval Depth

---

## Gap Assessment (pre-wave)

| Gap | Prior state | Wave 18 action |
|-----|------------|----------------|
| G-21 Working memory | Does not exist | Implement from scratch |
| G-25 Permission tiers | 68-LOC stub, no tests | Expand + full test suite |
| G-27 Stuck detector | 120 LOC impl, 3 test files (66+145+?) LOC | Harden with integration tests + integration into tool loop |
| G-29 Eval framework | Exists (85+151+60 LOC), 27+ test files | Deep coverage: regression runner, LLM judge edge cases, composite scorer |
| G-08 Connectors | GitHub (383 LOC) + HTTP (87 LOC) + tests exist | Expand Slack + Database connectors + conformance tests |

---

## Task Summary

| ID | Task | Package | Gap | Target Tests | Agent | Status |
|----|------|---------|-----|-------------|-------|--------|
| W18-A1 | Working memory — session-scoped typed state | `core` | G-21 | +50 | dzupagent-core-dev | ✅ DONE |
| W18-A2 | Stuck detector integration into tool loop + hardening | `agent` | G-27 | +40 | dzupagent-agent-dev | ✅ DONE (43) |
| W18-B1 | Permission tiers expansion: Docker flags + validation + tests | `codegen` | G-25 | +35 | dzupagent-codegen-dev | ✅ DONE |
| W18-B2 | Eval framework deep coverage: regression + judge edge cases | `evals` | G-29 | +45 | dzupagent-test-dev | ✅ DONE |
| W18-B3 | Connectors: Slack + Database expansion + conformance tests | `connectors` | G-08 | +35 | dzupagent-connectors-dev | pending |

---

## Detailed Task Specs

### W18-A1: Working Memory — Session-Scoped Typed State (G-21)

**Goal**: Implement a `WorkingMemory` class that persists typed state across steps within
a session — think of it as a typed, scoped key-value store that survives between agent
tool calls but not across session restarts (unless connected to a persistence adapter).

**Current state**: Does not exist anywhere in the codebase.

**Deliverables**:

1. `packages/core/src/persistence/working-memory.ts` — implement `WorkingMemory<T>`:
   ```ts
   class WorkingMemory<T extends Record<string, unknown>> {
     set<K extends keyof T>(key: K, value: T[K]): void
     get<K extends keyof T>(key: K): T[K] | undefined
     has(key: string): boolean
     delete(key: string): boolean
     clear(): void
     snapshot(): Readonly<T>
     restore(snapshot: T): void
     keys(): string[]
     size: number
   }
   ```
2. `packages/core/src/persistence/working-memory-types.ts` — `WorkingMemoryConfig`, `WorkingMemorySnapshot`
3. `createWorkingMemory<T>(config?: WorkingMemoryConfig): WorkingMemory<T>` factory
4. Export from `packages/core/src/persistence/index.ts` and `packages/core/src/index.ts`
5. `packages/core/src/__tests__/working-memory.test.ts` — 50+ tests

**Test coverage**:
- Basic get/set/delete/clear/has/keys/size
- TypeScript generic safety (different value types)
- Snapshot: produces deep copy, mutations don't affect original
- Restore: replaces state, emits change if watcher set
- Optional `onChange` callback triggered on mutations
- Optional `maxKeys` limit — throws or evicts LRU on overflow
- Optional `ttl` per key — expired keys return undefined
- Concurrent set operations (no race conditions)
- JSON serialization round-trip (snapshot → JSON → restore)

**Acceptance criteria**:
- `WorkingMemory` is generic, typed, and immutable-snapshot capable
- 50+ tests passing
- Exported from `@dzupagent/core`

---

### W18-A2: Stuck Detector Tool Loop Integration + Hardening (G-27)

**Goal**: The stuck detector exists (120 LOC) but is not wired into the main `DzupAgent`
tool loop. Wire it in and add integration tests that verify it fires during real agent
loops.

**Current state**:
- `packages/agent/src/guardrails/stuck-detector.ts` — 120 LOC, full implementation
- `packages/agent/src/__tests__/stuck-detector.test.ts` — 66 LOC
- `packages/agent/src/__tests__/stuck-detector-deep.test.ts` — 145 LOC
- Missing: integration into `DzupAgent` tool loop + integration tests

**Deliverables**:

1. Wire `StuckDetector` into `packages/agent/src/agent/dzip-agent.ts`:
   - Create `StuckDetector` in constructor (configurable via `AgentConfig.stuckDetector`)
   - Call `recordToolCall()` in the tool dispatch path
   - Call `recordError()` on tool errors
   - Call `recordIteration()` at the end of each ReAct loop iteration
   - Throw `StuckError` (from `stuck-error.ts`) when `isStuck()` returns true
2. `packages/agent/src/__tests__/stuck-detector-integration.test.ts` — 40+ tests:
   - Agent with a tool that always returns the same thing → stuck after N calls
   - Agent with high error rate tool → stuck after error threshold
   - Agent that eventually succeeds → NOT flagged as stuck
   - Custom `maxRepeatCalls=2` → stuck faster
   - `StuckError` has correct `reason` field
   - Detector resets after `reset()` call

**Acceptance criteria**:
- `DzupAgent` stops when stuck (throws `StuckError`)
- 40+ new tests passing
- Existing agent tests still pass

---

### W18-B1: Permission Tiers Expansion (G-25)

**Goal**: The 68-LOC `permission-tiers.ts` stub needs: (1) `validateTierConfig()` for
custom overrides, (2) `mergeTierConfig()` for partial overrides, (3) `tierToE2bConfig()`
for E2B sandbox, and (4) a full test suite.

**Current state**:
- `packages/codegen/src/sandbox/permission-tiers.ts` — 68 LOC (types + Docker flags)
- No tests exist for this file

**Deliverables**:

1. Extend `packages/codegen/src/sandbox/permission-tiers.ts`:
   - `validateTierConfig(config: Partial<TierConfig>): ValidationResult` — checks ranges
   - `mergeTierConfig(tier: PermissionTier, overrides: Partial<TierConfig>): TierConfig`
   - `tierToE2bConfig(tier: PermissionTier): Record<string, unknown>` — E2B sandbox shape
   - `compareTiers(a: PermissionTier, b: PermissionTier): -1 | 0 | 1` — security ordering
2. `packages/codegen/src/__tests__/sandbox/permission-tiers.test.ts` — 35+ tests:
   - All 3 tiers produce correct Docker flags
   - `validateTierConfig` rejects negative memory, zero cpus, etc.
   - `mergeTierConfig` applies overrides without mutating defaults
   - `compareTiers`: read-only < workspace-write < full-access
   - `tierToE2bConfig` returns correct shape
   - Tier defaults are frozen (mutations don't affect constants)

**Acceptance criteria**:
- 35+ tests passing
- No existing codegen tests broken

---

### W18-B2: Eval Framework Deep Coverage (G-29)

**Goal**: The eval framework has implementation but gaps in regression runner coverage,
LLM judge edge cases, and composite scorer boundary conditions. Add 45+ focused tests.

**Current state**:
- `packages/evals/src/llm-judge-scorer.ts` — 85 LOC
- `packages/evals/src/deterministic-scorer.ts` — 151 LOC
- `packages/evals/src/eval-runner.ts` — 60 LOC
- `packages/evals/src/composite-scorer.ts` — 72 LOC
- 27+ test files already exist — need gap analysis before writing

**Deliverables**:

1. Read existing test files to identify untested paths
2. Add 45+ new tests targeting gaps:
   - `eval-runner.ts`: empty suite (0 cases), all-fail suite, passThreshold boundary (exactly 0.7)
   - `llm-judge-scorer.ts`: LLM returns malformed JSON, LLM throws, score out of [0,1] clamped
   - `deterministic-scorer.ts`: exact match, contains, regex, case-sensitivity
   - `composite-scorer.ts`: weighted average, single scorer, all-zero weights
   - Regression: running same suite twice produces deterministic results
   - Concurrent eval runs don't interfere

**Acceptance criteria**:
- 45+ new tests
- All existing evals tests still pass

---

### W18-B3: Connectors Expansion — Slack + Database + Conformance (G-08)

**Goal**: Expand Slack connector (exists but likely sparse tests) and Database connector
with conformance tests against the `ConnectorContract`.

**Current state**:
- `packages/connectors/src/slack/` — check actual LOC
- `packages/connectors/src/database/` — check actual LOC
- `packages/connectors/src/__tests__/` — 21 test files, need gap analysis

**Deliverables**:

1. Gap-analyze Slack + Database connector tests
2. Add 35+ new tests:
   - Slack: send message, post to channel, error handling (rate limit, auth failure)
   - Database: query, insert, transaction rollback, connection error
   - Conformance: both connectors pass `ConnectorContract` validation
   - HTTP connector: retry on 5xx, timeout handling, auth header injection

**Acceptance criteria**:
- 35+ new tests
- All existing connector tests still pass

---

## Progress

| ID | Status | Tests Added | Notes |
|----|--------|-------------|-------|
| W18-A1 | ✅ DONE | 53 | `WorkingMemory<T>` with TTL + LRU + onChange + snapshot/restore + JSON round-trip; tests in `__tests__/working-memory.test.ts`. Existing Zod-based `WorkingMemory` from `@dzupagent/memory` re-exported as `SchemaWorkingMemory` to avoid name collision. |
| W18-A2 | ✅ DONE | 43 | StuckDetector already wired into the tool loop (run-engine.ts + tool-loop.ts + dzip-agent.ts stream). Added 43 end-to-end integration tests in `__tests__/stuck-detector-integration.test.ts` covering: (1) repeated tool calls including escalation through stages 1→2→3, (2) error-rate stuck via failing tools with varied args, (3) idle iteration handling, (4) custom config (maxRepeatCalls=2/10, errorWindowMs, false=disabled), (5) StuckError shape (reason/name/instanceof/escalationLevel), (6) recovery via varying inputs and alternating tools, (7) combined repeat+error triggers, (8) defaults with empty/no guardrails, (9) stream() path. All 2646 agent-package tests pass; lint clean on new file. |
| W18-B1 | ✅ DONE | 38 | validateTierConfig + mergeTierConfig + tierToE2bConfig + compareTiers + mostRestrictiveTier; 38 tests in `__tests__/sandbox/permission-tiers.test.ts` |
| W18-B2 | ✅ DONE | 53 | Gap-fill in `__tests__/eval-runner.test.ts` (+11) and `__tests__/scorers.test.ts` (+42): empty/all-fail suites, threshold boundaries (0.0/0.7/1.0), scorer/target throw propagation, parallel-run independence; LLMJudgeScorer JSON parsing + clamp + malformed; DeterministicScorer case sensitivity + regex + jsonSchema arrays/null/missing-schema + name property; CompositeScorer single/equal/weighted/zero-weight/empty + reasoning + metadata + name + arg passthrough |
| W18-B3 | ✅ DONE | 49 | Slack +19, Database +20, Conformance +10. Coverage in `slack-connector-extended.test.ts`, `database-connector-extended.test.ts`, `connector-contract-conformance.test.ts`: HTTP status codes (401/429/500), JSON parse failures, Slack URL routing, token formats (xoxp/xapp), non-existent/archived channels, transaction-like sequences (BEGIN/COMMIT/ROLLBACK), pool exhaustion + too-many-clients, concurrent queries, PG-specific errors (relation/column/syntax), SSL config variations, schema parse/safeParse presence, stable tool list across factory invocations, filtered toolkit invariants. 894/894 connectors tests pass. |
| **Total** | — | **236 / ≥200** | — |

---

## Wave 19 Candidates (preview)

- `G-08` GitHub connector tools expansion (create PR, review, merge)
- `G-22` Observation extractor — auto-extract facts from conversations
- `G-30` Frozen snapshot pattern — preserve prompt cache across session
- `G-32` Session search (FTS) — full-text search over conversation history
- Server `learning.ts` v2 — trend analysis with time-series aggregation
