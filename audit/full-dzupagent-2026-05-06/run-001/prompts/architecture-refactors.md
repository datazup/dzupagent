# Architecture Refactors

Multi-file refactors taking 4-24 hours each. Each task has a clear scope and is independently shippable. Sequence: do the cycle-breaking work (R-ARCH-001) before god-object splits (R-ARCH-004) so refactors don't introduce new cycles.

---

## R-ARCH-001: Break remaining intra-package cycles via shared types modules

**Files:** every file listed in cycles 4-18 plus 23-27 from the audit. Pattern is mechanical:

| Cycle | Refactor: extract shared types into … |
|-------|---------------------------------------|
| 4 | `agent-adapters/recovery/escalation-types.ts` |
| 5 | `agent-adapters/recovery/recovery-event-types.ts` (already partly there as `recovery-events.ts`) |
| 6, 7 | `agent-adapters/recovery/recovery-strategy-types.ts` |
| 8, 9, 10, 11 | `agent-adapters/workflow/workflow-types.ts` (consolidate adapter-workflow* + pipeline-assembler shared types) |
| 12 | `agent/agent/agent-shared-types.ts` (memory-profiles imports agent-types; agent-types should not import memory-profiles) |
| 13, 14 | `agent/agent/tool-loop/tool-loop-types.ts` |
| 15, 16 | `agent/agent/run-engine-types.ts` |
| 17 | `agent/self-correction/self-correction-types.ts` |
| 18 | `agent/orchestration/supervisor-types.ts` |
| 23, 25 | covered by R-ARCH-002 (server composition split) |
| 24, 26, 27 | `server/runtime/run-worker-types.ts` (extract RunWorkerState etc.) |
| 1 | `adapter-types/contracts/shared-events.ts` (events ↔ execution) |

**Change pattern (apply to each cycle):**
1. Identify the symbol(s) shared between the two cyclic files.
2. Create `<dir>/<feature>-types.ts` with no `@dzupagent/*` imports.
3. Move the shared symbol(s) there.
4. Update both files to import from the new types module.
5. Optionally re-export from the original file(s) for backward compatibility.

**Validation:**
- `npx madge --circular --extensions ts packages` reports 0 cycles.
- `yarn verify` passes.
- The `madge` CI gate added in QF-ARCH-002 passes without an allowlist.

**Target agent:** `dzupagent-core-dev` (with help from `dzupagent-agent-dev` for agent/agent-adapters cycles).
**Effort:** 24-40 hours total (1.5-3h per cycle × ~16 remaining cycles after quick fixes).

---

## R-ARCH-002: Extract `server/composition/types.ts` into route-scoped type modules

**Files:**
- `packages/server/src/composition/types.ts` (shrink)
- `packages/server/src/routes/run-context.ts` (edit)
- `packages/server/src/routes/run-context-types.ts` (new)
- `packages/server/src/routes/deploy.ts` (edit)
- `packages/server/src/deploy/deploy-types.ts` (new)
- `packages/server/src/deploy/{signal-checkers,confidence-calculator}.ts` (edit imports)
- `packages/server/src/scorecard/integration-scorecard.ts` (edit imports)

**Change:**
Currently `composition/types.ts` is imported by both `routes/deploy.ts` and `routes/run-context.ts`, and the deploy chain leads back to it via `scorecard/integration-scorecard.ts` (cycles 23 & 25).

1. Identify the symbols `composition/types.ts` exports that are *route-scoped* (not composition-root).
2. Move route-context types to `routes/run-context-types.ts`. Update `routes/run-context.ts` accordingly.
3. Move deploy-pipeline types to `deploy/deploy-types.ts`. Update `routes/deploy.ts`, `deploy/signal-checkers.ts`, `deploy/confidence-calculator.ts`, `scorecard/integration-scorecard.ts`.
4. Reduce `composition/types.ts` to ≤200 LOC, exposing only true composition-root contracts.

**Validation:**
- `npx madge --circular packages/server/src` no longer reports cycles 23 and 25.
- `wc -l packages/server/src/composition/types.ts` < 200.
- Existing server route tests pass.

**Target agent:** `dzupagent-core-dev`
**Effort:** 4-6 hours.

---

## R-ARCH-003: Split `server/routes/runs.ts` into per-handler files

**Files:**
- `packages/server/src/routes/runs.ts` (becomes thin router)
- `packages/server/src/routes/runs/handlers/{trigger-run,list-runs,get-run,cancel-run,pause-run,resume-run,fork-run,list-checkpoints,get-logs,get-trace,stream-events}.ts` (12 new files)
- `packages/server/src/routes/runs/handlers/__tests__/*.test.ts` (relocate tests)

**Change:**
Per the file's existing docstring intent ("every endpoint is backed by a named handler function"):
1. Create the `routes/runs/` directory and the `routes/runs/handlers/` subdirectory.
2. Extract each endpoint's handler function and its dependencies into a dedicated handler file.
3. `routes/runs.ts` becomes only the Hono `Router` setup that imports handlers and wires them to method+path.
4. Move tests adjacent to handlers, or keep co-located in `__tests__/runs/`.

**Validation:**
- `wc -l packages/server/src/routes/runs.ts` < 200.
- Each handler file ≤ 150 LOC.
- All run-route integration tests pass: `yarn workspace @dzupagent/server test --filter=runs`.

**Target agent:** `dzupagent-core-dev`
**Effort:** 8-10 hours.

---

## R-ARCH-004: Split per-node-kind dispatch in `flow-ast` and `flow-dsl`

**Files:**
- `packages/flow-ast/src/parse.ts` (1,077 LOC) → split into `parse/<node-kind>.ts` for 17 node kinds + `parse/index.ts` dispatcher.
- `packages/flow-ast/src/validate.ts` (1,410 LOC) → split into `validate/<node-kind>.ts` + `validate/index.ts`.
- `packages/flow-dsl/src/normalize.ts` (1,018 LOC) → split into `normalize/<node-kind>.ts` + `normalize/index.ts`.

**Change:**
Each of the three files has a long switch over `FLOW_NODE_KINDS`. Refactor:

```ts
// parse/index.ts
import { parseSequenceNode } from './sequence.js'
import { parseActionNode } from './action.js'
// ... 15 more
const PARSERS: Record<FlowNodeKind, NodeParser> = {
  sequence: parseSequenceNode,
  action: parseActionNode,
  // ...
}
export function parseNode(input, ctx): FlowNode { return PARSERS[input.kind](input, ctx) }
```

Each `parse/<kind>.ts` owns:
- The node-kind's parser function
- Validation helpers specific to that kind
- ~50-80 LOC

**Validation:**
- `wc -l packages/flow-ast/src/parse.ts` (the dispatcher) < 200.
- All 17 node-kind files exist with similar structure.
- `yarn workspace @dzupagent/flow-ast test` passes.

**Target agent:** `dzupagent-codegen-dev`
**Effort:** 16-24 hours (≈3 files × 5-8h each).

---

## R-ARCH-005: Split `agent/pipeline/pipeline-runtime.ts` into executor modules

**Files:**
- `packages/agent/src/pipeline/pipeline-runtime.ts` (1,043 LOC, shrink to ≤350 LOC)
- `packages/agent/src/pipeline/fork-executor.ts` (new)
- `packages/agent/src/pipeline/join-executor.ts` (new)
- `packages/agent/src/pipeline/gate-executor.ts` (new)
- `packages/agent/src/pipeline/checkpoint-handler.ts` (new)

**Change:**
`loop-executor.ts` already exists as a sibling. Apply the same pattern to the other special node kinds:
- Extract fork-handling logic to `fork-executor.ts`.
- Extract join-handling logic to `join-executor.ts`.
- Extract gate (suspend/approval) handling to `gate-executor.ts`.
- Extract checkpoint save/restore logic to `checkpoint-handler.ts`.
- `pipeline-runtime.ts` becomes the orchestrator that walks the graph and dispatches to executors.

**Validation:**
- `wc -l packages/agent/src/pipeline/pipeline-runtime.ts` < 400.
- `yarn workspace @dzupagent/agent test --filter=pipeline` passes.
- `yarn verify` passes.

**Target agent:** `dzupagent-agent-dev`
**Effort:** 12-16 hours.

---

## R-ARCH-006: Apply codegen layering rule to the framework itself

**Files:**
- `scripts/check-framework-layering.ts` (new)
- `package.json` (root) — add `check:layering` script
- `.github/workflows/*.yml` — wire into CI

**Change:**
Build a small Node script that:
1. Loads `createLayeringRule` from `@dzupagent/codegen`.
2. Walks `packages/*/src/**/*.ts`.
3. Runs the rule with the corrected `DEFAULT_LAYERS` (from QF-ARCH-001).
4. Reports violations with file:line.
5. Exits non-zero if any violation is reported.

Pseudocode:
```ts
import { createLayeringRule } from '@dzupagent/codegen/guardrails'
import { glob } from 'glob'
import { readFile } from 'node:fs/promises'

const rule = createLayeringRule()
const files = await glob('packages/*/src/**/*.ts', { ignore: ['**/*.test.ts','**/*.spec.ts','**/__tests__/**'] })
const result = rule.check({
  files: await Promise.all(files.map(async (f) => ({ path: f, content: await readFile(f, 'utf8') }))),
  projectStructure: { packages: buildPackageMap() },
})
if (!result.passed) {
  for (const v of result.violations) console.error(`${v.file}:${v.line} ${v.message}`)
  process.exit(1)
}
```

**Validation:**
- Script runs locally and reports the `agent-adapters → agent` violation from ARCH-001 if not yet fixed (and zero violations once R-ARCH-007 lands).
- CI step added.

**Target agent:** `dzupagent-codegen-dev`
**Effort:** 6-8 hours.

---

## R-ARCH-007: Resolve `agent-adapters → agent` layer violation by introducing a pipeline port

**Files:**
- `packages/core/src/pipeline/pipeline-runtime-port.ts` (new) — interface only
- `packages/agent/src/pipeline/pipeline-runtime.ts` — implements the port
- `packages/agent-adapters/src/workflow/{default-pipeline-executor,adapter-workflow,pipeline-assembler}.ts` — depend on the port, not on `@dzupagent/agent`
- `packages/codegen/src/guardrails/rules/layering-rule.ts` — add `agent-adapters` to the rule (rolled in from QF-ARCH-001)

**Change:**
1. Define a minimal `PipelineRuntimePort` interface in core (or in a new `@dzupagent/pipeline-port` contract package). Include the `PipelineRuntimeEvent` type and the methods `agent-adapters/workflow` actually calls.
2. Have `PipelineRuntime` (in `agent`) implement the port.
3. `agent-adapters/workflow/*` imports `PipelineRuntimePort` from core, never from `@dzupagent/agent`.
4. The factory that *constructs* a runtime instance moves to where adapters and runtime are wired together (likely in `server` or in `agent` itself, exported via `@dzupagent/agent/runtime`).

**Validation:**
- `grep -rn "from '@dzupagent/agent'" packages/agent-adapters/src --include="*.ts" | grep -v ".test.ts"` returns 0 matches.
- Layering rule (R-ARCH-006) passes.
- `yarn verify` passes.

**Target agent:** `dzupagent-agent-dev` (with `dzupagent-core-dev` for the port definition).
**Effort:** 8-14 hours.

---

## R-ARCH-008: Implement `scripts/check-architecture.ts` master gate

**Files:**
- `scripts/check-architecture.ts` (new)
- `package.json` (root) — `check:architecture` script
- CI workflow

**Change:**
A single Node script that runs four checks:

1. **Cycles** — `madge --circular --json packages` and fail if any.
2. **Layering** — invoke the framework-layering check from R-ARCH-006.
3. **Declared deps match imports** — for each package, parse `package.json` `dependencies` and grep its `src/**/*.ts` for `from '@dzupagent/*'`. Fail if any imported package is not declared, or any declared dep is not actually imported.
4. **Barrel discipline** — verify each `index.ts` only re-exports from its own `src/`. Fail if it re-exports from another package.

Each check is its own function; the script aggregates and reports.

**Validation:**
- All four checks pass after R-ARCH-001 + R-ARCH-007 land.
- CI gates on `yarn check:architecture`.
- Synthetic violations (in a feature branch) cause the gate to fire.

**Target agent:** `dzupagent-codegen-dev`
**Effort:** 16-24 hours.

---

## R-ARCH-009: Split `core/events/event-types.ts` by domain

**Files:**
- `packages/core/src/events/event-types.ts` (shrink to <200 LOC)
- `packages/core/src/events/event-types-{lifecycle,adapter,workflow,tool,budget,mapreduce,observability,security}.ts` (new, split by domain)

**Change:**
1. Group event union members in `event-types.ts` by domain (lifecycle vs adapter vs workflow vs tool vs budget vs map-reduce …).
2. Move each group to its own file.
3. `event-types.ts` re-exports the union and continues to provide `DzupEvent` and `DzupEventOf`.

**Validation:**
- `wc -l packages/core/src/events/event-types.ts` < 200.
- All consumers import unchanged surface (`DzupEvent`, `DzupEventOf`, etc.) without modification.

**Target agent:** `dzupagent-core-dev`
**Effort:** 8-12 hours.

---

## R-ARCH-010: Split `agent-adapters` provider subpaths

**Files:**
- `packages/agent-adapters/package.json` — split `./providers` into `./providers/claude`, `./providers/codex`.
- `packages/agent-adapters/src/providers/claude.ts` and `.../codex.ts` (new entry barrels)
- `packages/agent-adapters/tsup.config.ts` — multi-entry build

**Change:**
Today both Claude and Codex adapters are exported via a single `./providers` subpath, defeating tree-shaking when only one provider is needed. Split into provider-scoped subpaths.

**Validation:**
- `import { ClaudeAdapter } from '@dzupagent/agent-adapters/providers/claude'` resolves.
- A consumer that imports only `claude` does not pull `codex-adapter.ts` (verify via bundler analyze).

**Target agent:** `dzupagent-agent-dev`
**Effort:** 4-8 hours.

---

## R-ARCH-011: Shrink `core/index.ts` and `agent/index.ts` barrels (cap at ≤30 root exports)

**Files:**
- `packages/core/src/index.ts` (877 LOC → < 250)
- `packages/agent/src/index.ts` (821 LOC → < 250)
- New subpath barrels for any subdomain that's currently dumped into root

**Change:**
1. List the 225 root exports of `core/index.ts`. Categorize each:
   - **High-traffic** (used by ≥3 external packages): keep in root.
   - **Subdomain-scoped**: move to its existing subpath barrel (e.g., MCP types → `./mcp`, identity → `./identity`).
   - **Internal**: remove from public surface.
2. Same for `agent/index.ts` 210 exports.
3. Provide a deprecation cycle via `@deprecated` JSDoc and a CHANGELOG entry naming the migration paths.

**Validation:**
- `grep -c "^export" packages/core/src/index.ts` < 50.
- `grep -c "^export" packages/agent/src/index.ts` < 60.
- `yarn verify` passes (consumers updated to subpaths).

**Target agent:** `dzupagent-core-dev` + `dzupagent-agent-dev`
**Effort:** 16-24 hours per package.
