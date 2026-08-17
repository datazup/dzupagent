# Slice claims — concurrent sessions

Multiple agent sessions work this repo at the same time. Occupancy in the
test-typecheck debt program (GAP-2) is **per-package**, not per-lane, so this
file exists to make ownership visible before the first edit rather than
discovering it through a merge.

## How to use

1. Before your first edit, add or update your package's row and **commit this
   file by itself**. That commit is the claim.
2. Work only in the packages you have claimed.
3. Release by setting Status to `free` (or deleting the row) when you finish.
4. A claim older than a few hours with no commits touching that package is
   stale — verify with
   `git log -8 --name-only --format=%h | grep -oE '^packages/[^/]+' | sort -u`
   before taking it.

This file is advisory. It does not replace the liveness probe:

```bash
S1=$(git status --porcelain | md5sum); H1=$(git rev-parse HEAD); sleep 75
S2=$(git status --porcelain | md5sum); H2=$(git rev-parse HEAD)
[ "$S1" = "$S2" ] && [ "$H1" = "$H2" ] && echo QUIESCENT || echo SIBLING-LIVE
```

## Current claims

| Package | Status | Claimed by | Note |
|---|---|---|---|
| `codegen` | **free — at ZERO** | released 2026-08-17 19:05 (`c54ac57e`, `5ded35cd`) | `SkillResolverConfig` is now a pair of structural ports (`SkillInstructionSource`, `SkillContentLoader`) instead of core's `SkillRegistry`/`SkillLoader`, which hold private state and so could never be substituted — nine `as unknown as` casts deleted, and two tests resolve through live `new SkillRegistry()` / `new SkillLoader([])` instances to prove the narrowing still admits the real classes. Separately, the 27 permanently-skipped k8s-operator tests were deleted (that operator has never existed in any commit; it is a cluster-side component per `sandbox/ARCHITECTURE.md`). Suite is now 4752 passed / **0 skipped**. Do not regress. |
| `core` | **free — at ZERO** | released 2026-08-17 19:05 (`eb61b8d6`) | Event-bus handler returns are now plain `void`, not `void \| Promise<void>`. TypeScript's void-return leniency does not survive a union, so expression-bodied handlers (`bus.onAny((e) => seen.push(e))`) were rejected workspace-wide — agent-adapters had shipped `e8e2ddb4` rewriting 16 suites around it, and `LoopBudgetHost.settle` in `packages/agent` still carries the same union. Handlers are stored internally as `=> unknown` because `runHandlers` duck-types the result and a `void` expression cannot be tested for truthiness. Verified from a consumer package that the new signature propagates. Four tests pin the guard; reverting the union reproduces 5 TS2322 in the test file. Do not regress. |
| `connectors` | **free — at ZERO** | closed 2026-08-17 17:05 (`594e8ac5`) | 85 -> 0, baseline entry removed. Suite 67 files / 2587 tests exit 0, `yarn tsc --noEmit` on src exit 0. Three were contract/production issues, not test defects: `textToBlocks` declared `SlackBlock[]` while every path returns `SlackSectionBlock`; the BigQuery `createQueryJob` fake declared `{query}` while the adapter passes four fields; `Priv` in `sql-adapters-deep` declared 3 of the members it pokes, leaving 25 calls typed `unknown`. Do not regress. |
| `server` | **free — at ZERO** | closed 2026-08-17 17:55 | 664 -> 0 across four commits (`30fb8b0c`, `4b87e2fb`, `37e8fc8d`, `969693ec`), baseline ratcheted `2b06442d`. **With this the whole ratchet reads `totalErrors: 0` — all 18 packages clean.** The owning sub-session was cut off by a session limit after landing every commit with a clean tree, so its work is intact; the runtime suite proof it never got to run is being taken separately. Do not regress. | 664 errors, the largest remaining slice. Verified free before claiming: zero dirty paths under `packages/server/`, nothing under `packages/server/src` touched in 20 minutes, last server commit `90823517` at 16:47:49. The `RunExecutor` dead-arm note in `run-worker-types.ts` was landed by that commit, so the contract question it raised is resolved. |
| `flow-ast` | **claimed** | resolved-tool-handle session (2026-08-17 18:20) | At ZERO for debt. Claim is NOT debt — it is the **implementation-side** `ResolvedTool.handle: unknown` typing gap (`src/types/resolvers.ts:71-72,84`). The `ResolvedToolKind` discriminant already exists at `:60`; every producer builds a fully typed handle and then widens it. Verified free: clean under `packages/flow-ast`, unclaimed. |
| `connectors` (2nd) | **claimed** | resolved-tool-handle session (2026-08-17 18:20) | Consumer half of the `flow-ast` claim above: `src/agent-registry-resolver.ts:155-170` and the 19+ re-declaring casts in its tests. Package is at ZERO — **do not regress**. |
| `agent` | **claimed** | agent-contract session (2026-08-17 18:10) | At ZERO for debt (`9acd615f`). Claim is NOT debt — it is the **implementation-side** step-output journal chain: `WorkflowEvent` `step:completed` carries no `output`, so `journal-recorder.ts:76` writes `{stepId,durationMs}` only, and BOTH consumers of `StepCompletedEntry.data` are degraded (`resume-utils` renders every step `[completed]`; `run-handle.getCheckpoints()` `stepName` is always undefined). Plus `MemoryConfigSlice.memory` structural port (`agent-types-memory.ts:75`). Verified free first: 0 dirty under `packages/agent`, last agent commit 17:27:02, sibling activity confined to `packages/server` (`core`/`codegen` yielded to the contract-fix session, `memory` to the connectors session). |
| `evals` | **free — at ZERO** | closed 2026-08-17 17:26 (`cd3d1333`) | 188 -> 0. Suite 56 files / 2815 tests exit 0. One 2-line change cleared **94**: two fixed 3-element fixtures declared as open arrays, so under `noUncheckedIndexedAccess` every index read was `T | undefined` across 100+ call sites. One CONTRACT bug fixed in source: `RegressionGateOptions.baselineRun` was typed `BenchmarkRunRecord` while its own JSDoc points at `getBaseline()`, which returns `BenchmarkBaselineRecord` — the documented call path did not typecheck. Six under-asserted tests repaired, two mutation-verified. |
| `agent-adapters` | **free — at ZERO** | released 2026-08-17 19:05 | 166 -> 0 across two sessions (concurrently; both landed honest fixes). Baseline ratcheted to 0 in `42bb9b60`. Typecheck exit 0, suite 213 files / 3766 tests exit 0. One PRODUCTION contract bug fixed in `53dae40f`: `ParallelOptions` inherited `mergeStrategy` as REQUIRED via `Omit<ParallelExecutionOptions,'providers'>` while `orchestration-patterns.ts:114` defaults it (`?? 'all'`), so the default arm was unreachable through the public type. Do not regress. Both reported contract fixes are now landed and still at ZERO: `typedStep` no longer demands a `prompt` that `adapter-workflow-execution.ts:248` discards (`02ecefcb`), and `CodexAdapter` has the narrowed constructor its own `CodexAdapterConfig` requires, with both `as CodexAdapterConfig` casts removed and four constructor tests that never existed (landed inside sibling commit `6208e29c`; verified by content at HEAD, not by diff size). Suite 213 files / 3773 tests, `tsc --noEmit` 0, flipcheck 0. Do not regress. |
| `memory` | **claimed** | connectors session, after closing connectors (2026-08-17 17:10) | 4 structural errors. The previous owner left them deliberately: 3x TS6059 (a deep import that drags `agent-types` under memory's rootDir — fix belongs in agent-types) and 1x TS2307 (`../../tsup.config`, outside flipcheck's `include`). Both fixes sit outside a tests-only slice, which is why they were deferred; taking them now that the repo is quiescent. `tsconfig.flipcheck.json` is per-package, so editing memory's own copy changes no sibling's measurement. |

Packages at zero (do not regress): `adapter-rules`, `cache`,
`connectors-browser`, `create-dzupagent`, `dialogue-core-replay`, `express`,
`otel`, `scraper`, `test-utils`, `testing`.
