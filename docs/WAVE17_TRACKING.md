# Wave 17 — Implementation Tracking

> **Start date**: 2026-04-16  
> **Target**: ≥180 new tests/benchmarks, close 5 critical gaps  
> **Theme**: Agent Intelligence + Coverage Expansion

---

## Task Summary

| ID | Task | Package | Gap | Target Tests | Agent | Status |
|----|------|---------|-----|-------------|-------|--------|
| W17-A1 | AGENTS.md hierarchical parser (G-10) | `core` + `agent` | G-10 | +40 | dzupagent-core-dev | ✅ DONE |
| W17-A2 | Workflow builder parallel/branch depth test suite | `agent` | G-11 | +50 | dzupagent-agent-dev | ✅ DONE |
| W17-B1 | Repo map via ts-morph AST (G-09) — integration + edge cases | `codegen` | G-09 | +45 | dzupagent-codegen-dev | ✅ DONE |
| W17-B2 | Drizzle reflection store integration tests (deferred W13-13) | `server` | G-04 | +25 | dzupagent-test-dev | ✅ DONE |
| W17-B3 | learning.ts route coverage (477-line test file expansion) | `server` | — | +30 | dzupagent-test-dev | ✅ DONE |

---

## Detailed Task Specs

### W17-A1: AGENTS.md Hierarchical Parser (G-10)

**Goal**: Harden the hierarchical AGENTS.md discovery and merge system so it correctly
handles global → project → directory precedence with full edge-case coverage.

**Current state**:
- `packages/agent/src/instructions/agents-md-parser.ts` — 181 LOC, basic parser
- `packages/agent/src/__tests__/agents-md-parser.test.ts` — 155 LOC, ~12 tests
- `packages/core/src/formats/agents-md-parser-v2.ts` — parallel impl, needs reconciliation
- `packages/core/src/skills/agents-md-parser.ts` — skills variant

**Deliverables**:
1. Extend parser to support hierarchical walker (global → cwd → file-dir merge)
2. Add `mergeAgentsMd(layers: AgentsMd[])` that applies precedence rules
3. Add 40+ tests covering: precedence, override, empty layers, circular detection, malformed input

**Acceptance criteria**:
- `mergeAgentsMd` composes 3+ layers with correct overrides
- Hierarchical walker discovers files in global/project/directory order
- 40 new tests passing

---

### W17-A2: Workflow Builder Parallel/Branch Depth Tests

**Goal**: Achieve full test coverage of the 704-LOC `workflow-builder.ts` for parallel
fan-out, conditional branching, suspend/resume, and error propagation.

**Current state**:
- `packages/agent/src/workflow/workflow-builder.ts` — 704 LOC, full implementation
- `packages/agent/src/workflow/workflow-types.ts` — type definitions
- Test coverage: minimal (builder is used but not directly tested at unit level)

**Deliverables**:
1. `packages/agent/src/__tests__/workflow-builder.test.ts` — full unit test suite
2. Cover: `.then()`, `.parallel()`, `.branch()`, `.suspend()`, `.build()`, error paths
3. Cover nested parallel within parallel, branch with 3+ arms, suspend in parallel

**Acceptance criteria**:
- 50+ new tests
- All public methods tested with success + error paths
- Suspend/resume round-trip tested

---

### W17-B1: Repo Map AST Integration Tests (G-09)

**Goal**: Expand the `repo-map-builder.ts` (221 LOC) with deep integration tests covering
real TypeScript parsing via `symbol-extractor.ts` and `import-graph.ts`.

**Current state**:
- `packages/codegen/src/repomap/repo-map-builder.ts` — 221 LOC
- `packages/codegen/src/repomap/symbol-extractor.ts` — extracts symbols
- `packages/codegen/src/repomap/import-graph.ts` — builds import graph
- `packages/codegen/src/repomap/tree-sitter-extractor.ts` — tree-sitter variant
- Test coverage: very light (index.ts only exports, minimal tests)

**Deliverables**:
1. `packages/codegen/src/__tests__/repomap/repo-map-builder.test.ts` — integration tests
2. `packages/codegen/src/__tests__/repomap/import-graph.test.ts` — graph tests
3. `packages/codegen/src/__tests__/repomap/symbol-extractor.test.ts` — extraction tests
4. Cover: token budget enforcement, focus files, exclude patterns, ranking, empty repo

**Acceptance criteria**:
- 45+ new tests
- Token budget respected within 10% of target
- Import graph correctly reflects cross-file dependencies

---

### W17-B2: Drizzle Reflection Store Integration Tests

**Goal**: Complete the deferred W13-13 task — expand `drizzle-reflection-store.test.ts`
(434 LOC, well started) with missing integration paths.

**Current state**:
- `packages/server/src/__tests__/drizzle-reflection-store.test.ts` — 434 LOC, good mock DB
- Missing: concurrent write safety, large dataset pagination, TTL/cleanup paths

**Deliverables**:
1. Expand existing test file with 25+ new tests
2. Cover: concurrent saves, limit/offset pagination, TTL expiry simulation, schema migration compat

**Acceptance criteria**:
- 25+ new tests passing
- All DrizzleReflectionStore public methods have ≥3 test cases each

---

### W17-B3: learning.ts Route Coverage Expansion

**Goal**: The `learning-routes.test.ts` (1807 LOC!) is the largest test file — but
`learning.ts` (477 LOC) has several untested paths. Bring to near-complete coverage.

**Current state**:
- `packages/server/src/routes/learning.ts` — 477 LOC, 14 route handlers
- `packages/server/src/__tests__/learning-routes.test.ts` — 1807 LOC (very thorough)
- Missing: edge cases in trends, node performance with no data, feedback validation errors

**Deliverables**:
1. Expand `learning-routes.test.ts` with 30+ additional edge-case tests
2. Cover: empty trend windows, malformed feedback payloads, concurrent requests, skill-pack reload

**Acceptance criteria**:
- 30+ new tests
- All route handlers covered for both happy-path and error cases
- No route handler left with <2 test cases

---

## Progress

| ID | Status | Tests Added | Notes |
|----|--------|-------------|-------|
| W17-A1 | ✅ DONE | 49 | mergeAgentsMd + discoverAgentsMdHierarchy + 49 new tests |
| W17-A2 | ✅ DONE | 78 | workflow-builder-full.test.ts — 17 describe blocks, 78 test cases |
| W17-B1 | ✅ DONE | 58 | 3 test files in __tests__/repomap/: symbol-extractor (20), import-graph (13), repo-map-builder (25) |
| W17-B2 | ✅ DONE | 27 | Concurrent saves, large dataset pagination, quality thresholds, pattern filtering, TTL simulation, empty store, idempotency, schema boundary, stats aggregation, zero-length patterns, rowToSummary edges, list ordering |
| W17-B3 | ✅ DONE | 35 | Trend empty data, limit parsing (0/-1/abc) across endpoints, node perf edges, feedback validation, feedback stats empty, skill-pack reload idempotency, nodeId/taskType filters, rules limit=3, partial dashboard, concurrent requests, tenantId from context |
| **Total** | — | **247 / ≥180** | — |

---

## Wave 18 Candidates (preview)

- `G-25` Permission tiers in sandbox (codegen)
- `G-27` Stuck detector implementation (agent)
- `G-21` Working memory (core) — session-scoped typed state
- `G-08` GitHub + HTTP connectors (connectors)
- `G-29` Eval framework: LLM-as-judge + deterministic scorers (evals)
