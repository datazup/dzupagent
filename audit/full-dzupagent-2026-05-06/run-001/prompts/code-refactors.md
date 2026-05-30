# Code Quality — Refactors (P2, 4–8h each)

Slices that need a non-trivial restructuring but should not change behaviour.

---

## R-001: Extract `runToolLoop` stages into per-stage helpers

**Finding:** CODE-002
**Files:**
- `packages/agent/src/agent/tool-loop.ts:490-851`
- New: `packages/agent/src/agent/tool-loop/stages/{stage-stuck-detection,stage-iteration-budget,stage-tool-dispatch,stage-final-assembly}.ts`
**Change:**
1. Identify the four logical stages currently inlined in `runToolLoop`. The stuck-detection block (lines ~700-740, depth 10) is the highest-priority extraction.
2. Each helper takes the loop-state struct and returns a typed result `{ action: 'continue' | 'break' | 'recover' | 'abort'; …}`.
3. The top-level `runToolLoop` becomes:
   ```ts
   while (...) {
     const budget = applyBudgetGate(state); if (budget === 'halt') break
     const dispatch = await dispatchToolCall(state); if (...) ...
     const stuck = await checkStuck(state, config); if (stuck === 'abort') break
   }
   return assembleFinalResult(state)
   ```
4. Preserve all event emissions and config callbacks exactly.

**Validation:**
```bash
yarn workspace @dzupagent/agent typecheck
yarn workspace @dzupagent/agent test    # must still pass all 196 tests, especially tool-loop-deep, tool-loop-canonical-audit, parallel-tool-loop
```

**Target agent:** dzupagent-agent-dev

---

## R-002: Dedup mtime-cache pattern across 3 dzupagent loaders

**Finding:** CODE-003
**Files:**
- `packages/agent-adapters/src/dzupagent/agent-loader.ts`
- `packages/agent-adapters/src/dzupagent/memory-loader.ts`
- `packages/agent-adapters/src/dzupagent/file-loader.ts`
- New: `packages/agent-adapters/src/dzupagent/_md-file-cache.ts`
**Change:**
1. Create `MdFileCache<T>` with constructor taking `parseFn: (filePath: string, content: string) => T | undefined`. Expose `loadDir(dir: string, opts?: { fileExt?: string }): Promise<T[]>`, `loadFile(filePath: string): Promise<T | undefined>`, `invalidate(): void`.
2. Each loader retains its own `parseAgent`/`parseMemory`/`parseSkill` function and delegates I/O+caching to the helper.
3. Public API of each loader stays identical.

**Validation:**
```bash
yarn workspace @dzupagent/agent-adapters typecheck
yarn workspace @dzupagent/agent-adapters test
# Each loader file should shrink by ~50 LOC.
```

**Target agent:** dzupagent-agent-dev

---

## R-003: Sweep remaining `console.*` to `defaultLogger`

**Finding:** CODE-009
**Files:**
- `packages/server/src/routes/workflows.ts` (4)
- `packages/server/src/lifecycle/graceful-shutdown.ts` (4)
- `packages/server/src/composition/middleware.ts` (4)
- `packages/server/src/composition/utils.ts` (2)
- `packages/server/src/composition/route-plugins.ts` (1)
- `packages/server/src/security/incident-response.ts` (1)
- `packages/server/src/persistence/run-trace-store.ts` (1)
- `packages/server/src/notifications/channels/console-channel.ts` (1) — keep this one (it's a console *channel*; document the exception)
- `packages/agent-adapters/src/dzupagent/syncer.ts` (4)
- `packages/agent-adapters/src/middleware/memory-enrichment.ts` (2)
- `packages/agent-adapters/src/base/stream-runner.ts` (2)
- `packages/agent/src/orchestration/orchestration-telemetry.ts` (4)
- `packages/agent/src/orchestration/orchestrator.ts` (2)
- `packages/agent/src/replay/replay-controller.ts` (2)
- `packages/agent/src/self-correction/{root-cause-analyzer,reflection-loop,trajectory-calibrator,self-learning-hook}.ts` (1-2 each)
**Change:** Mechanical: replace every `console.error/warn/log/info/debug(...)` with `defaultLogger.<level>(...)`. Preserve the message format. Do NOT change `dry-run-reporter.ts`, `core/utils/logger.ts`, or `notifications/channels/console-channel.ts` — those are intentional.
Add to each file: `import { defaultLogger } from '@dzupagent/core'` (if not already there).

**Validation:**
```bash
yarn typecheck
yarn test
grep -rE "^\s*console\.(log|warn|error|info|debug)" packages/{server,agent,agent-adapters}/src --include="*.ts" \
  | grep -v "/__tests__/\|/cli/\|dry-run-reporter\|console-channel\|utils/logger.ts\|^\s*\*\| \* \| //\|^\s*//"
# Expect ≤ 5 lines.
```

**Target agent:** dzupagent-core-dev

---

## R-004: Split `flow-ast/parse.ts` per-node parsers

**Finding:** CODE-001 (slice)
**Files:**
- `packages/flow-ast/src/parse.ts` (1,077 LOC)
- New: `packages/flow-ast/src/parsers/{action,approval,branch,classify,clarification,emit,foreach,memory,parallel,persona,route,sequence,spawn,checkpoint,restore,complete}.ts`
**Change:**
1. Move each `parse<NodeType>(obj, pointer, ctx)` function into its own file.
2. Keep `parseFlow`, `parseNode` (dispatcher), and shared helpers (`parseCommonNodeFields`, `parseNodeArray`) in the root `parse.ts`.
3. Re-export per-node parsers from `parse.ts` if any external test depends on them.
4. Mirror the structure for `validate.ts` if scope allows (else leave for follow-up).

**Validation:**
```bash
yarn workspace @dzupagent/flow-ast build
yarn workspace @dzupagent/flow-ast test
# Resulting parse.ts ≤ 250 LOC; each per-node file ≤ 120 LOC.
```

**Target agent:** dzupagent-agent-dev

---

## R-005: Split `server/routes/runs.ts`

**Finding:** CODE-018
**Files:**
- `packages/server/src/routes/runs.ts` (968 LOC)
- New: `packages/server/src/routes/runs/{list,pause-resume,trace,log,event,index}.ts`
**Change:**
1. Move list handlers (GET /runs, GET /runs/:id) → `runs/list.ts`.
2. Move pause/resume/cancel handlers → `runs/pause-resume.ts`.
3. Move trace endpoint → `runs/trace.ts`.
4. Move log streaming → `runs/log.ts`.
5. New `runs/index.ts` mounts all sub-routers.
6. Keep request-validation helpers in `runs/_helpers.ts` (extract `apiKey` resolution helpers).

**Validation:**
```bash
yarn workspace @dzupagent/server typecheck
yarn workspace @dzupagent/server test --grep="runs-"
# All 4 runs-*.test.ts must pass unchanged.
```

**Target agent:** dzupagent-core-dev (server maintenance allowed for non-feature refactor)

---

## R-006: Add tests for security `prompt-injection/patterns.ts`

**Finding:** CODE-022
**Files:**
- New: `packages/security/src/__tests__/patterns.test.ts`
- SUT: `packages/security/src/prompt-injection/patterns.ts`
- Fixtures: `packages/security/src/prompt-injection/fixtures/{allow,warn-block}.fixtures.ts`
**Change:** For each entry in `INJECTION_PATTERNS`, write at least one positive case from `warn-block.fixtures.ts` and verify zero matches against every entry in `allow.fixtures.ts`. Use a per-pattern describe block so failures pinpoint which regex regressed.

**Validation:**
```bash
yarn workspace @dzupagent/security test
```

**Target agent:** dzupagent-test-dev

---

## R-007: Add tests for `hitl-kit` approval-state-store + postgres-approval-store

**Finding:** CODE-008
**Files:**
- New: `packages/hitl-kit/src/__tests__/approval-state-store.test.ts`
- New: `packages/hitl-kit/src/__tests__/postgres-approval-store.test.ts`
**Change:**
- `approval-state-store.test.ts`: enqueue → dequeue (FIFO), expiry (advance fake clock), recovery from stored state, idempotent ack.
- `postgres-approval-store.test.ts`: mock the Drizzle/pg query layer (use `vi.mock` to inject a fake adapter); assert the SQL command shape and recovery flow. If a docker-pg harness is feasible, prefer that.

**Validation:**
```bash
yarn workspace @dzupagent/hitl-kit test
```

**Target agent:** dzupagent-test-dev

---

## R-008: Extract `codex-adapter` interaction-resolution sub-loop

**Finding:** CODE-015
**Files:** `packages/agent-adapters/src/codex/codex-adapter.ts:680-740`
**Change:**
1. Create `private async *handleInteractionResolution(result, sessionId, input, codex, signal): AsyncIterable<AgentEvent>` housing the `if (result.answer === 'yes' || …) { resumeThread … } else { adapter:failed }` block + the inner for-of mapping.
2. Replace the inline block with `yield* this.handleInteractionResolution(...)`.
3. Verify max nesting depth in the file drops from 9 to ≤ 6 (re-run depth check).

**Validation:**
```bash
yarn workspace @dzupagent/agent-adapters test
awk 'BEGIN{m=0;d=0} { for(i=1;i<=length($0);i++){c=substr($0,i,1); if(c=="{")d++; if(c=="}")d--; if(d>m)m=d} } END{print m}' \
  packages/agent-adapters/src/codex/codex-adapter.ts
# Expect ≤ 6
```

**Target agent:** dzupagent-agent-dev

---

## R-009: Extract pipeline-runtime stuck-detection block

**Finding:** CODE-016
**Files:** `packages/agent/src/pipeline/pipeline-runtime.ts:460-510`
**Change:**
1. Pull stuck-handling into `private handleStuckStatus(stuckStatus, node, runId, context, nodeResults, startTime): { kind: 'continue' | 'fail' | 'switch'; failResult?: PipelineResult; reason?: string }`.
2. Replace the inline body with a call + switch.
3. Pull error-edge resolution + recovery attempt into `private async resolveErrorPath(...)`.
4. Aim for max nesting depth ≤ 5.

**Validation:**
```bash
yarn workspace @dzupagent/agent test pipeline
awk 'BEGIN{m=0;d=0} { for(i=1;i<=length($0);i++){c=substr($0,i,1); if(c=="{")d++; if(c=="}")d--; if(d>m)m=d} } END{print m}' \
  packages/agent/src/pipeline/pipeline-runtime.ts
# Expect ≤ 5
```

**Target agent:** dzupagent-agent-dev

---

## R-010: Add tests for run-engine streaming/generate helpers

**Finding:** CODE-005 (slice)
**Files:**
- New: `packages/agent/src/__tests__/run-engine-streaming-helpers.test.ts`
- New: `packages/agent/src/__tests__/run-engine-generate-helpers.test.ts`
- SUT: `packages/agent/src/agent/run-engine-streaming-helpers.ts` (717 LOC)
- SUT: `packages/agent/src/agent/run-engine-generate-helpers.ts` (426 LOC)
**Change:** Cover at minimum:
- `applyBudgetGate` — within-budget, exhausted, soft-warning thresholds
- `runToolStreamingPhase` — happy path, abort, retry, partial-stream
- `recordToolLatencyOutcome` — under threshold, over warning, over critical
- `buildSuccessResult` — assembles correct `GenerateResult` shape
- `handleInvocationFailure` — retry policy, abort path
- `run-engine-generate-helpers` — at least the exported helpers exercised by `dzip-agent.ts`

**Validation:**
```bash
yarn workspace @dzupagent/agent test run-engine-streaming-helpers
yarn workspace @dzupagent/agent test run-engine-generate-helpers
```

**Target agent:** dzupagent-test-dev

---

## R-011: Add tests for `root-cause-analyzer.ts`

**Finding:** CODE-005 (slice)
**Files:**
- New: `packages/agent/src/__tests__/self-correction/root-cause-analyzer.test.ts`
- SUT: `packages/agent/src/self-correction/root-cause-analyzer.ts`
**Change:** Cover:
1. Heuristic-only path (LLM unavailable) → returns a `RootCauseReport` with `confidence < 0.5`.
2. LLM returns valid JSON → high-confidence merged report.
3. LLM throws → falls back to heuristic without bubbling.
4. LLM returns malformed JSON → falls back to heuristic.
5. Past-context flag (`hasPastContext`) toggles correctly when memory is provided.

**Validation:**
```bash
yarn workspace @dzupagent/agent test root-cause-analyzer
```

**Target agent:** dzupagent-test-dev
