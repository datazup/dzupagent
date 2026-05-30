# Code Quality Audit — dzupagent

Date: 2026-05-06
Auditor: code-quality domain (parallel run-001)
Scope: `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/**` (32 packages, ~256k non-test LOC, 1,481 src TS files, 1,151 test files)

## Summary

- Findings: **24** (P1: **6**, P2: **11**, P3: **7**)
- Highest-risk packages (by complexity × test gap):
  1. `agent` — 4 of the 5 largest run-engine helper files have **zero direct tests** (~2,300 LOC unwitnessed)
  2. `flow-ast` — 2,487 LOC across `parse.ts` + `validate.ts` with 3 test files; max nesting depth 7
  3. `agent-adapters` — `codex-adapter.ts` 1,126 LOC, depth 9; cross-loader duplication in `dzupagent/`
  4. `server` — `routes/runs.ts` 968 LOC depth 8, multiple route files >500 LOC with no per-route test
  5. `codegen` — repomap/tree-sitter-extractor 648 LOC zero-test

The codebase is in **good shape overall**: 0 TS errors, all `yarn lint` packages clean, 0 production `@ts-ignore`/`@ts-expect-error`, only ~7 actual production `as never` casts (down from the 15 noted in the 2026-05-05 audit), and no empty `catch {}` blocks. The remaining issues are mostly **size-and-coverage** not defect-density.

## Metrics snapshot

| Metric | Count | Notes |
|--------|-------|-------|
| `as any` (production, real) | **3** | All in `core/llm/tokenizer.ts`, justified by sync optional-require pattern, eslint-disabled with comment |
| `as any` raw match (incl. comments) | 13 | 10 are JSDoc/comments referencing the pattern, not actual casts |
| `as never` (production) | **7** | 4 actual casts: `app-tools/builtin.ts:301`, `connectors-browser/auth-handler.ts:128/132`, `express/sse-handler.ts:174`. Others are doc comments. |
| `as never` (tests) | ~340 | Acceptable mocking pattern |
| `@ts-expect-error` / `@ts-ignore` (production) | **0** | All matches are inside lint-rule definitions or doc comments |
| `console.*` outside CLI/test (real, non-comment) | **~50** | See CODE-009 |
| `TODO` / `FIXME` / `HACK` (production code body) | **0** | All hits are in lint-rule pattern strings |
| Files > 500 LOC | **72** | Out of 1,481 src files (4.9%) |
| Files > 800 LOC | **16** | Top 6 are >1,000 LOC |
| Max function size | **362 LOC** | `runToolLoop` in `agent/src/agent/tool-loop.ts:490` |
| Max nesting depth | **10** | `agent/src/agent/tool-loop.ts:722` |
| Production non-null `!.` assertions | **~118** | 28 in server, 25 in agent, 21 in memory, 20 in agent-adapters |
| Zero direct-test src files (filename heuristic) | **>200** | High false-positive rate; verified gaps reported in CODE-005..008 |
| `@deprecated` markers (production) | **60** | 40 are subpath-export deprecations in `agent/src/index.ts` |

### Per-package metrics (non-test only, real production usage)

| Package | LOC | Files | Tests | as never | as any | console (real) | nonnull `!` |
|---------|----:|------:|------:|---------:|-------:|---------------:|------------:|
| agent | 45,414 | 235 | 196 | 0 | 0 | 9 | 25 |
| agent-adapters | 37,208 | 166 | 148 | 0 | 0 | 14 | 22 |
| server | 34,682 | 215 | 194 | 1* | 0 | 21 | 28 |
| core | 33,036 | 223 | 109 | 2 | 3 | 1 | 7 |
| memory | 21,530 | 100 | 75 | 0 | 0 | 0 | 21 |
| codegen | 20,035 | 141 | 87 | 0 | 0 | 2 | 16 |
| evals | 10,614 | 55 | 33 | 0 | 0 | 7 | — |
| flow-ast | 2,998 | 7 | 3 | 0 | 0 | 0 | — |
| security | 464 | 9 | 3 | 0 | 0 | 0 | — |

\* The single server `as never` is in a doc-comment on `types.ts:5`; the live `c.set(... as never)` casts shown in earlier audits have all been removed in favour of `Context<AppEnv>`.

### Sprint-state validation
- Confirmed: 0 prod `@ts-ignore`/`@ts-expect-error`, prompt-caching present, AppEnv replaces `c.set('apiKey' as never)` everywhere, no empty catches.
- The "15 `as never` remain" figure cited in the 2026-05-05 audit is now **4 real production casts**. Recommend marking that finding closed.

---

## Findings

### CODE-001: Top-5 oversized files exceed 1,000 LOC each
**Severity:** P2
**Effort:** 16h per file (not all in this sprint)
**Files:**
- `packages/flow-ast/src/validate.ts` — 1,410 LOC, 103 fns, depth 7
- `packages/agent/src/agent/run-engine.ts` — 1,186 LOC, depth 6, 270-LOC `executeGenerateRunInner`
- `packages/agent-adapters/src/codex/codex-adapter.ts` — 1,126 LOC, 52 fns, depth 9
- `packages/flow-ast/src/parse.ts` — 1,077 LOC, 85 fns
- `packages/agent/src/pipeline/pipeline-runtime.ts` — 1,071 LOC, depth 9
- `packages/flow-dsl/src/normalize.ts` — 1,018 LOC

**Why it matters:** Files of this size are difficult to navigate, defeat structured editor outline navigation, and increase the surface for merge conflicts. `validate.ts` and `parse.ts` already split per-node-type (ApprovalNode, BranchNode, etc.) but live in a single file. Each of these has independent tests today.

**Fix:** Split each by node-type or by lifecycle phase into a `validators/` or `parsers/` subdirectory with a single barrel. Concrete plan:
- `flow-ast/src/parse.ts` → `parsers/{action,approval,branch,classify,clarification,emit,foreach,memory,parallel,persona,route,sequence,spawn,checkpoint,restore,complete}.ts` plus a 100-LOC dispatcher.
- `flow-ast/src/validate.ts` → same split mirroring `parse.ts`.
- `pipeline-runtime.ts` — extract the `attemptRecovery` / stuck-handling / error-edge logic into helpers (currently inlined at depth 9).

**Acceptance:** Each split file ≤ 400 LOC, root file becomes a dispatcher; existing tests still pass; `yarn build --filter=@dzupagent/flow-ast && yarn typecheck && yarn test` green.

---

### CODE-002: `runToolLoop` is 362 LOC at nesting depth 10
**Severity:** P1
**Effort:** 6h
**Files:** `packages/agent/src/agent/tool-loop.ts:490-851`
**Why it matters:** Single function is ~10× the recommended size. Max nesting 10 (line 722) makes branch tracing very hard and is a magnet for `as never` mocking workarounds in tests (24 in `memory-write-back.test.ts` alone — see CODE-014). The existing `tool-loop/` subdirectory already houses `loop-stages.ts` and `policy-enabled-tool-executor.ts`, so the extraction pattern is established.

**Fix:** Extract per-stage handlers into `tool-loop/stages/`:
- `stage-stuck-detection.ts` (lines ~700-740, the 4-level nested checkpoint-recovery block)
- `stage-iteration-budget.ts`
- `stage-tool-dispatch.ts`
- `stage-final-assembly.ts`
The top-level `runToolLoop` should orchestrate via 4-5 helper calls inside a single while-loop body.

**Acceptance:** `runToolLoop` ≤ 100 LOC; no helper exceeds 80 LOC; max depth ≤ 5; all existing tool-loop tests still pass without changes; `yarn test --filter=@dzupagent/agent` green.

---

### CODE-003: Loader trio — 3 separate `mtime+readdir+Promise.all` caches
**Severity:** P2
**Effort:** 5h
**Files:**
- `packages/agent-adapters/src/dzupagent/agent-loader.ts:177-298` (DzupAgentAgentLoader)
- `packages/agent-adapters/src/dzupagent/memory-loader.ts:105-`
- `packages/agent-adapters/src/dzupagent/file-loader.ts:223-`
**Why it matters:** All three classes implement essentially the same algorithm: `private cache = new Map<string, CacheEntry>()`, `loadFromDir()` does `readdir → filter .md → Promise.all → loadFileCached`, and `loadFileCached` does `stat → mtime compare → readFile → parse → cache`. Cache invalidation logic is also duplicated (`invalidate()` calling `cache.clear()`). About 60 LOC of identical structure × 3 files = 180 LOC of replicated control flow.

**Fix:** Extract a `MdFileCache<T>` generic helper exporting:
```ts
class MdFileCache<T> {
  constructor(private parse: (filePath: string, content: string) => T | undefined)
  loadDir(dir: string): Promise<T[]>
  invalidate(): void
}
```
Each loader retains its parse step but delegates I/O+caching. Optionally place under `packages/agent-adapters/src/dzupagent/_md-file-cache.ts`.

**Acceptance:** Each loader sheds ~50 LOC; all `dzupagent/` tests still pass; new helper has its own targeted test.

---

### CODE-004: `MemoryEntry` interface name collision across packages
**Severity:** P2
**Effort:** 2h
**Files:**
- `packages/memory/src/consolidation-types.ts:21` — store-side shape (text, decay, importance, raw…)
- `packages/agent-adapters/src/dzupagent/memory-loader.ts:30` — file-side shape (name, description, tags, content, tokenEstimate)
**Why it matters:** Two unrelated types share a name. A consumer importing the wrong one will silently get the wrong shape because field overlap is zero (no compile error if imported-from is wrong).

**Fix:** Rename `agent-adapters/.../memory-loader.ts:MemoryEntry` to `MdMemoryEntry` (or `MemoryFileEntry`). Update internal references; no external consumers need re-exports because `agent-adapters` re-exports it as `MemoryEntry` from a single barrel that this rename can also rebrand.

**Acceptance:** `grep -rn "export interface MemoryEntry" packages/*/src` returns at most one result; `yarn typecheck` green.

---

### CODE-005: 6 large agent files have no direct test (≥ 400 LOC each)
**Severity:** P1
**Effort:** 10h (4h per file initial coverage, can be sliced)
**Files (verified zero-test by direct-name grep + import-from grep):**
- `packages/agent/src/agent/run-engine-streaming-helpers.ts` — **717 LOC**, 7 exports including `runToolStreamingPhase`, `recordToolLatencyOutcome`, `buildSuccessResult`, `handleInvocationFailure`
- `packages/agent/src/agent/run-engine-generate-helpers.ts` — **426 LOC**
- `packages/agent/src/agent/tool-loop-types.ts` — **462 LOC** (mostly types, but has runtime helpers)
- `packages/agent/src/self-correction/root-cause-analyzer.ts` — **407 LOC**, LLM-driven heuristic-fallback module
- `packages/agent/src/agent/structured-generate.ts` — **327 LOC**
- `packages/agent/src/agent/tool-loop-learning.ts` — **289 LOC**

**Why it matters:** These are first-class engine helpers, not types-only files. `runToolStreamingPhase` is a public export consumed by streaming runs but no direct test exercises its budget gate / latency record / failure paths. Coverage is implicit through `tool-loop-deep.test.ts` etc., but bug regressions in these helpers can pass undetected.

**Fix:** Add focused unit tests for each — `run-engine-streaming-helpers.test.ts` covering at least `applyBudgetGate`, `runToolStreamingPhase` happy/error/cancellation, `recordToolLatencyOutcome` thresholds, `handleInvocationFailure` retry vs abort. `root-cause-analyzer.test.ts` covering heuristic fallback when LLM returns invalid JSON.

**Acceptance:** Each new test file ≥ 12 cases; per-file branch coverage ≥ 70% via `yarn test --coverage --filter=@dzupagent/agent`.

---

### CODE-006: Server zero-test for 5 production files (≥ 250 LOC)
**Severity:** P1
**Effort:** 8h
**Files:**
- `packages/server/src/deploy/confidence-calculator.ts` — **348 LOC** — no test references found
- `packages/server/src/scorecard/probe-collector.ts` — **340 LOC** — no test references found
- `packages/server/src/runtime/mcp-tool-instantiation.ts` — **285 LOC** — no test references found
- `packages/server/src/deploy/deployment-history-store.ts` — **255 LOC**
- `packages/server/src/deploy/signal-checkers.ts` — **180 LOC**

**Why it matters:** Deployment confidence calculation directly gates `deploy-gate.ts`. A bug here can authorize a bad release. Probe-collector feeds the scorecard. These are not types or DI wiring — they have business logic.

**Fix:** Add one test per file. For `confidence-calculator.ts`, drive synthetic inputs (zero history, single recent failure, mixed signals) and assert the score ranks them correctly. For `probe-collector.ts`, mock the probe sources and assert aggregation.

**Acceptance:** ≥ 4 test files added under `packages/server/src/__tests__/deploy/` and `__tests__/scorecard/`; each module reaches ≥ 60% line coverage.

---

### CODE-007: `flow-ast/parse.ts` (1,077 LOC) has 3 test files but 16 untested per-node parsers
**Severity:** P2
**Effort:** 6h
**Files:** `packages/flow-ast/src/parse.ts` (parseAction, parseForEach, parseBranch, parseApproval, parseClarification, parsePersona, parseRoute, parseParallel, parseComplete, parseSpawn, parseClassify, parseEmit, parseMemory, parseCheckpoint, parseRestore — 16 functions)
**Why it matters:** Existing tests (`parse.test.ts`, `checkpoint-nodes.test.ts`, `validate.test.ts`) cover the happy paths and a couple of error cases. The granular per-parser branches (e.g., `parseClarification` 60+ LOC, `parseEmit` 35 LOC) have many uncovered error branches (issue accumulation, type guards). With 0 tests in 2998 LOC of contracts/parser, regression risk is high once new node types are added.

**Fix:** Add per-node test fixture files under `packages/flow-ast/test/parsers/<node>.test.ts` that drive 5+ malformed inputs each, asserting issue codes & paths.

**Acceptance:** Branch coverage of `parse.ts` ≥ 80% via `yarn workspace @dzupagent/flow-ast test --coverage`.

---

### CODE-008: `hitl-kit` has 1 test for 4 production files (531 LOC)
**Severity:** P2
**Effort:** 4h
**Files:**
- `packages/hitl-kit/src/approval-state-store.ts` — 201 LOC, no direct test
- `packages/hitl-kit/src/postgres-approval-store.ts` — 189 LOC, no direct test
- `packages/hitl-kit/src/approval-gate.ts` — 90 LOC, has `approval-gate.test.ts`
**Why it matters:** Both stores implement the durable-approval contract (per recent MC sprint). The state-store invariants (queue ordering, expiry, recovery from disk) are not exercised. `postgres-approval-store.ts` has no test ⇒ schema migrations could break silently.

**Fix:** Add `approval-state-store.test.ts` driving in-memory enqueue/dequeue/timeout/recovery. Add `postgres-approval-store.test.ts` using a docker-pg harness or mock query layer.

**Acceptance:** Both new test files exist; `yarn workspace @dzupagent/hitl-kit test` runs all 3 suites.

---

### CODE-009: ~50 real `console.*` calls in non-CLI, non-test code
**Severity:** P2
**Effort:** 3h
**Files (with real, non-comment counts):**
- `packages/agent-adapters/src/dzupagent/dry-run-reporter.ts` — 8 (acceptable: dry-run reporter prints to stdout)
- `packages/server/src/routes/mcp.ts` — 8 `console.error(`[mcp] ${internal}`)` (lines 171–430)
- `packages/server/src/routes/workflows.ts` — 4
- `packages/server/src/lifecycle/graceful-shutdown.ts` — 4
- `packages/server/src/composition/middleware.ts` — 4
- `packages/agent-adapters/src/dzupagent/syncer.ts` — 4
- `packages/core/src/utils/logger.ts` — 4 (acceptable: this *is* the default logger)
- `packages/agent-adapters/src/middleware/memory-enrichment.ts` — 2
- `packages/agent-adapters/src/base/stream-runner.ts` — 2
- `packages/server/src/composition/utils.ts` — 2
- 12 single-call files in server, agent-adapters, core
**Why it matters:** `defaultLogger` exists in `core/src/utils/logger.ts` exactly so call sites don't go directly to `console.*`. The framework cannot route operator output through OTEL or structured-log sinks when calls bypass the logger. `mcp.ts:[171…430]` repeats `console.error('[mcp] ${internal}')` 8 times in the same file — a clear pattern that should be a single helper.

**Fix:**
- Replace all `console.*` in `server/routes/mcp.ts` with a single `logMcpError(internal: string)` helper that calls `defaultLogger.error('[mcp]', internal)`.
- Replace `console.*` in `agent-adapters/middleware/`, `agent-adapters/base/stream-runner.ts`, `agent-adapters/syncer.ts` with `defaultLogger`.
- Keep `dry-run-reporter.ts` (intentional stdout; documented behaviour) and `core/src/utils/logger.ts` (the logger itself).

**Acceptance:** `grep -rE "console\.(log|warn|error|info|debug)" packages/{server,agent-adapters,agent}/src --include="*.ts" | grep -v "/__tests__/\|/cli/\|dry-run-reporter\|utils/logger.ts"` returns ≤ 5 lines.

---

### CODE-010: 28 non-null `!.` assertions in server hot routes
**Severity:** P2
**Effort:** 4h
**Files:**
- `packages/server/src/routes/mcp.ts` — **14 occurrences** (lines 118, 167, 185, 267, 285, 301, 320, …) — all of form `config.mcpManager!.method()`. The route runs only when `config.mcpManager` exists, but that's enforced by an outer `if` 50 lines up; a refactor could break the invariant.
- `packages/server/src/routes/skills.ts` — 5 occurrences
- `packages/server/src/composition/middleware.ts` — 4 (`config.apiKeyStore!`, `config.shutdown!`, `config.metrics!` ×2)

**Why it matters:** Each `!` silently disables strict-null checking at that point. If config wiring changes, no compile error catches the regression — it's a runtime `Cannot read properties of undefined`.

**Fix:** Extract the precondition into a typed narrow helper at route registration time:
```ts
function requireMcp(config: ServerConfig): NonNullable<ServerConfig['mcpManager']> {
  if (!config.mcpManager) throw new ForgeError('MCP_NOT_CONFIGURED', 'route registered without mcpManager')
  return config.mcpManager
}
const mcp = requireMcp(config)  // do once; use `mcp.method()` thereafter
```
Or destructure with narrowing inside the route handler. Avoid `!.` entirely.

**Acceptance:** `grep -cE "config\.(mcpManager|apiKeyStore|shutdown|metrics)\!" packages/server/src` returns 0.

---

### CODE-011: Memory `void-filter.ts` and `adaptive-retriever.ts` use `!.` at boundary
**Severity:** P2
**Effort:** 2h
**Files:**
- `packages/memory/src/retrieval/void-filter.ts` — 6 occurrences
- `packages/memory/src/retrieval/adaptive-retriever.ts` — 3 occurrences
- `packages/memory/src/lesson-dedup.ts` — 2
**Why it matters:** Memory retrieval is a hot read path; a `!` here on an array element or map lookup will throw `TypeError: Cannot read properties of undefined` mid-query. The trade-off vs explicit guard is small (one line).

**Fix:** Replace `arr[i]!.field` with `const item = arr[i]; if (!item) continue;` Replace `map.get(key)!` with explicit `?? throwOrFallback`.

**Acceptance:** `grep -cE "[a-zA-Z_0-9\)\]]\![\.\[]" packages/memory/src/retrieval --include="*.ts"` ≤ 2 (allow exception for documented invariants).

---

### CODE-012: `agent/src/index.ts` has 40 `@deprecated` re-export shims (821 LOC)
**Severity:** P2
**Effort:** 3h
**Files:** `packages/agent/src/index.ts:495–584` (lines explicitly mark `@deprecated Import from '@dzupagent/agent/replay' instead.`, `'@dzupagent/agent/self-correction' instead.`)
**Why it matters:** The framework already publishes subpath exports for `agent/replay`, `agent/self-correction`, etc. The root barrel re-exports the same symbols with `@deprecated` JSDoc, but there's no enforcement (lint rule) and no removal date. Consumers don't get a build-time warning — only IDE hover tooltips. Dead-code scanners can't tell whether external apps still use these shims.

**Fix:** Either (a) remove the deprecated shims now (one breaking-change commit; consuming apps must update imports — `apps/codev-app` is the main consumer per project memory) or (b) mark them with a hard removal milestone in JSDoc (e.g., `@deprecated since 0.x — REMOVING in 0.y`) and add a `no-restricted-imports` lint rule in any consumer app.

**Acceptance:** EITHER the index.ts shrinks by ≥ 80 LOC (option a) OR every `@deprecated` line includes a removal version (option b).

---

### CODE-013: `core/src/index.ts` is 875 LOC — barrel sprawl
**Severity:** P3
**Effort:** 4h
**Files:** `packages/core/src/index.ts` (875 LOC), `packages/agent-adapters/src/index.ts` (587 LOC)
**Why it matters:** Single barrel files of this size hurt tree-shaking and TS LSP responsiveness. They also signal that the package public surface is unmanaged.

**Fix:** Split barrels by subdomain (`core/src/index.ts` → `core/src/{events,llm,memory,security,plugins}/index.ts` already exist; only re-export the curated public surface from root). Same for `agent-adapters`.

**Acceptance:** Root `index.ts` ≤ 200 LOC per package; package consumers' typecheck still passes.

---

### CODE-014: 132 `as never` casts in agent test files concentrated in 5 files
**Severity:** P3
**Effort:** 5h
**Files:**
- `packages/agent/src/__tests__/memory-write-back.test.ts` — 24
- `packages/agent/src/__tests__/agent-factory.test.ts` — 15
- `packages/agent/src/__tests__/run-engine.test.ts` — 14
- `packages/agent/src/__tests__/dzip-agent-provider-fallback.test.ts` — 12
- `packages/agent/src/__tests__/dzip-agent.test.ts` — 7
- (Plus 22 in `codegen/.../lesson-extractor-and-reflection.test.ts` and 16 in `connectors-browser/.../extraction.test.ts`.)
**Why it matters:** While `as never` in tests is acceptable for partial mocking, 24 in a single file usually indicates the system-under-test wants a *test factory*. Each cast bypasses TS, so when a SUT field is renamed, the test silently passes a wrong-shaped mock. The 2026-05-05 sprint reduced production usage; tests are next.

**Fix:** Build per-area test factories — `createMockAgent`, `createMockEventBus`, `createMockMemoryClient` in `packages/test-utils/src` — that return `Partial<>` strongly-typed stand-ins. Replace `as never` casts with factory calls.

**Acceptance:** Aggregate `as never` count in `agent/__tests__/*` drops below 30 (from 132); `test-utils` exposes ≥ 4 new factories.

---

### CODE-015: `agent-adapters/src/codex/codex-adapter.ts` runStreamedThread depth-9 nesting
**Severity:** P2
**Effort:** 4h
**Files:** `packages/agent-adapters/src/codex/codex-adapter.ts:680–740` (the interaction-resolution block + nested for-of inside try)
**Why it matters:** Mirror of CODE-002 in a different adapter. The 5-deep nested `if (result.answer === 'yes' || …) { … } else { … }` inside the for-of inside `for (const rawProviderEvent…)` inside the try-catch is dense. Compare with the analogous `claude-adapter.ts` which is flatter (783 LOC, depth 8). The `codex` adapter's interaction resolver was bolted on after the base streaming pattern was established.

**Fix:** Extract `handleInteractionResolution(result, sessionId, input, codex, signal)` returning `AsyncIterable<AgentEvent>`, hoisting the inner for-of out of the depth-7 position.

**Acceptance:** Max nesting depth in `codex-adapter.ts` ≤ 6; `yarn test --filter=@dzupagent/agent-adapters` green.

---

### CODE-016: `pipeline-runtime.ts` recovery block at depth 9
**Severity:** P2
**Effort:** 3h
**Files:** `packages/agent/src/pipeline/pipeline-runtime.ts:460-500` (stuckDetector + suggestedAction handling)
**Why it matters:** 4 nested `if` blocks: `stuckDetector → stuckStatus.stuck → suggestedAction === 'abort' → return failure`, plus a sibling `suggestedAction === 'switch_strategy'` branch and the subsequent `getErrorTarget`/`attemptRecovery` cascade. Together this places the success-path body at depth 9.

**Fix:** Pull stuck-handling into `handleStuckStatus(stuckStatus, node, runId, …): { state: 'continue' | 'abort' | 'switch'; reason?: string }`. Pull error-edge resolution into `tryErrorEdge(node, error)`. Reduces the main loop body to ~30 LOC of dispatch.

**Acceptance:** Max depth in `pipeline-runtime.ts` ≤ 5.

---

### CODE-017: `flow-ast/validate.ts:validateDefaults` triple-nested issue accumulator
**Severity:** P3
**Effort:** 2h
**Files:** `packages/flow-ast/src/validate.ts:1370–1410` (the `defaults.retry.delayMs` validation triple-conditional)
**Why it matters:** `joinPath(joinPath(joinPath(path, 'defaults'), 'retry'), 'delayMs')` repeated ~5 times. Helper exists; nesting comes from the structural `if isPlainObject → if attempts ok → if delayMs present → if delayMs ok` cascade. Hard to extend with new `defaults` fields.

**Fix:** Extract `validateRetry(retryNode, parentPath, issues)` function. Use a `joinPaths(path, 'defaults', 'retry', 'delayMs')` variadic helper. Replace nested ifs with early-return guards.

**Acceptance:** `validateFlowDocument` body shrinks by ~30 LOC; `validate.test.ts` adds 3 cases for retry edge-cases (negative delayMs, non-number attempts, missing object) and they pass.

---

### CODE-018: `server/routes/runs.ts` 968 LOC route file
**Severity:** P2
**Effort:** 6h
**Files:** `packages/server/src/routes/runs.ts`
**Why it matters:** Single route file holds list/get/pause/resume/cancel/log/event/trace handlers. While split tests exist (`runs-list-total`, `runs-pause-resume`, `runs-resume-semantics`, `runs-routes-branches`), the source file is monolithic. Maintainers have to navigate ~970 LOC every time. Per CLAUDE.md, server is in maintenance mode — but a low-risk split is acceptable maintenance.

**Fix:** Split by handler family — `routes/runs/list.ts`, `routes/runs/pause-resume.ts`, `routes/runs/trace.ts`, `routes/runs/log.ts` — leaving a thin `routes/runs/index.ts` mounting them. No semantic change.

**Acceptance:** Each split file ≤ 350 LOC; existing `runs-*.test.ts` suite passes unchanged; route mount is one line.

---

### CODE-019: Magic-number constants for timeouts
**Severity:** P3
**Effort:** 2h
**Files (selected):**
- `packages/agent-adapters/src/claude/claude-adapter.ts:560` — `timeout: 5000`
- `packages/agent-adapters/src/utils/process-helpers.ts:98,318` — `}, 5000)` ×2
- `packages/server/src/routes/spawn-compiler-bridge.ts:195,224` — `setTimeout(resolve, 5000)` ×2
- `packages/server/src/routes/events.ts:64` — `setTimeout(resolve, 1000)`
- `packages/create-dzupagent/src/utils.ts:124` — `setTimeout(() => abort(), 5000)`
**Why it matters:** Timeouts of 5s/30s/60s are scattered as bare integer literals. A platform tuning change requires a global hunt.

**Fix:** Add a constants module per package or `core/src/timeouts.ts`:
```ts
export const TIMEOUTS = {
  SDK_HEALTH_CHECK_MS: 5_000,
  PROCESS_KILL_GRACE_MS: 5_000,
  COMPILE_BRIDGE_POLL_MS: 5_000,
  ...
} as const
```
Replace literals with named constants where 3+ duplicates exist.

**Acceptance:** Defined ≥ 5 named constants; ≥ 8 literal sites replaced.

---

### CODE-020: 40 deprecated re-exports lack removal milestone
**Severity:** P3
**Effort:** 1h
**Files:** `packages/agent/src/index.ts` (40 `@deprecated` JSDoc lines)
**Why it matters:** Without an `@deprecated since x.y — REMOVING in z.0` clause, deprecation never triggers an action. Same point as CODE-012 but tracked as low-effort doc fix even if the broader split (CODE-012) isn't done.

**Fix:** Append removal targets to each `@deprecated` JSDoc.

**Acceptance:** 100% of `@deprecated` lines in `agent/src/index.ts` end with a "REMOVING in" clause.

---

### CODE-021: `connectors-browser` retains 41 `as never` casts (16+12+10 in tests)
**Severity:** P3
**Effort:** 3h
**Files:**
- `packages/connectors-browser/src/__tests__/extraction.test.ts` — 16
- `packages/connectors-browser/src/__tests__/auth-handler.test.ts` — 12
- `packages/connectors-browser/src/__tests__/link-extractor.test.ts` — 10
- Real production: `packages/connectors-browser/src/browser/auth-handler.ts:128,132` — `'__vue_app__' in (appEl as never)` (acceptable: probing untyped DOM property)
**Why it matters:** Heavy `as never` mocking in browser test suite duplicates DOM-fixture wiring across 3 files.

**Fix:** Add `connectors-browser/test-utils.ts` with `makeFakeDom(...)` and `makeFakeAuthEl(...)` factories.

**Acceptance:** Test-file `as never` count drops below 10 across the three files.

---

### CODE-022: `security/prompt-injection/patterns.ts` has 0 dedicated coverage
**Severity:** P2
**Effort:** 2h
**Files:**
- `packages/security/src/prompt-injection/patterns.ts` (54 LOC of regex array)
- `packages/security/src/prompt-injection/fixtures/{allow,warn-block}.fixtures.ts`
**Why it matters:** The patterns file IS the security boundary, and the fixtures exist explicitly to fence false-positive vs true-positive examples. `prompt-injection.test.ts` (83 LOC) exercises the detector but the patterns array itself is not asserted as a unit (no test that says "this pattern matches these inputs and not those"). A regex change can silently drop a pattern.

**Fix:** Add `patterns.test.ts` that iterates `INJECTION_PATTERNS` × `(allow.fixtures, warn-block.fixtures)` asserting each pattern's expected hits. Confirms catastrophic-backtracking risk only after benchmarking; that's a separate (security-domain) finding.

**Acceptance:** Test file exists and asserts a stable mapping of pattern index → fixture matches; `yarn test --filter=@dzupagent/security` green.

---

### CODE-023: `eval-contracts` and `agent-types` ratio of 1 test : 5+ src files
**Severity:** P3
**Effort:** 2h
**Files:**
- `packages/agent-types/src/{approval,guardrails,memory-client,orchestration-contracts,tool-permission}.ts` — 5 files type-only or with helper functions; only `retry.ts` has a test.
- `packages/eval-contracts/src/{benchmark-types,eval-types,orchestrator-contracts,store-contracts}.ts` — 4 files; 1 contracts.test.ts covers them combined.
**Why it matters:** Mostly types; runtime behaviour is small. But `tool-permission.ts` and `approval.ts` carry validators or factories worth covering.

**Fix:** Inspect each file. If purely types, document in CONTRIBUTING that a single contracts.test.ts is the convention. If runtime helpers exist, add focused tests.

**Acceptance:** Either file has tests OR file is annotated `// types-only — covered by consumer tests`.

---

### CODE-024: Static-data heavy `core/src/events/event-types.ts` (717 LOC, 0 fns, 0 tests)
**Severity:** P3
**Effort:** 1h
**Files:** `packages/core/src/events/event-types.ts` (717 LOC, 0 functions per heuristic — pure type/event-shape definitions)
**Why it matters:** A 717-LOC file with no functions is unusual; suggests the event union has grown organically. Splitting by event family (lifecycle, tool, memory, governance) would help consumers locate the relevant variant. No correctness issue, but a navigation cost.

**Fix:** Split into `core/src/events/types/{lifecycle,tool,memory,governance,…}.ts` and re-export from `event-types.ts`.

**Acceptance:** `event-types.ts` ≤ 200 LOC (re-exports only); consumer typecheck unchanged.

---

## Risk-prioritized rollout

**Quick-fix sprint (P1, ≤2h each):**
- CODE-002 — split `runToolLoop` into stages (6h, but slice-able)
- CODE-005 — add tests for run-engine helpers (10h, slice-able)
- CODE-006 — add tests for deploy/scorecard files (8h, slice-able)

**Medium-effort refactors (P2):**
- CODE-001 large file splits (16h each, pick 2)
- CODE-003 loader trio dedup
- CODE-004 MemoryEntry rename
- CODE-009 console → defaultLogger sweep
- CODE-010, CODE-011 non-null hardening
- CODE-015, CODE-016 nested-block extraction
- CODE-018 split runs.ts
- CODE-022 security pattern coverage

**Major changes (P3, 16h+):**
- CODE-013 barrel splits
- CODE-014 test-factory migration
- CODE-017 flow-ast helper extraction
- CODE-019 timeouts module
- CODE-020 deprecated removal milestones
- CODE-021 connectors-browser test factories
- CODE-023 type-only test convention
- CODE-024 event-types split
