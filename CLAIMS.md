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
| `flow-ast` | **free — released 2026-08-17 19:15** | resolved-tool-handle session | **SHIPPED** (`09950362`): `ResolvedTool.handle` is now a discriminated union keyed on the existing `ResolvedToolKind`, replacing `unknown`. Net -49 lines as the re-declaring casts collapsed. Verified after the fact: flow-ast 0 errors + suite 33 files / 671 tests; `flow-compiler` (46 files consume `ResolvedTool`) typechecks 0. |
| `connectors` (2nd) | **free — released 2026-08-17 19:15** | resolved-tool-handle session | Consumer half of the above. Suite 67 files / 2587 tests exit 0, typecheck 0. **Do not regress.** |
| `agent` | **free — released 2026-08-17 19:10** | agent-contract session | **Step-output journal chain SHIPPED** (`fd2d1c9d` + `63df0ae0`): `WorkflowEvent.step:completed` now carries `output`/`stepName`, all THREE emit sites populate them (sequential, parallel, and the recovery-step loop in `applyErrorHandlers`), and `journal-recorder` mirrors them into `StepCompletedEntry`. No `@dzupagent/core` change was needed — the contract already declared `output?`/`toolName?`; only the agent-side producer was broken. Fixes TWO consumers that had never worked: `rehydrateMessagesFromJournal` rendered every resumed step as `[completed]`, and `getCheckpoints().stepName` was always undefined. `MemoryServicePort` doc-claim corrected + pinned (`9ba2d21f`). ⚠️ **`packages/agent` measures 44 test-typecheck errors right now — ALL in another session's live `pipeline-for-each-*` lane** (10 dirty + 1 untracked under `src/pipeline/`), zero in any file this lane touched. Do NOT ratchet the baseline against that number and do NOT 'fix' those files. |
| `evals` | **free — at ZERO** | closed 2026-08-17 17:26 (`cd3d1333`) | 188 -> 0. Suite 56 files / 2815 tests exit 0. One 2-line change cleared **94**: two fixed 3-element fixtures declared as open arrays, so under `noUncheckedIndexedAccess` every index read was `T | undefined` across 100+ call sites. One CONTRACT bug fixed in source: `RegressionGateOptions.baselineRun` was typed `BenchmarkRunRecord` while its own JSDoc points at `getBaseline()`, which returns `BenchmarkBaselineRecord` — the documented call path did not typecheck. Six under-asserted tests repaired, two mutation-verified. |
| `agent-adapters` | **free — at ZERO** | released 2026-08-17 19:05 | 166 -> 0 across two sessions (concurrently; both landed honest fixes). Baseline ratcheted to 0 in `42bb9b60`. Typecheck exit 0, suite 213 files / 3766 tests exit 0. One PRODUCTION contract bug fixed in `53dae40f`: `ParallelOptions` inherited `mergeStrategy` as REQUIRED via `Omit<ParallelExecutionOptions,'providers'>` while `orchestration-patterns.ts:114` defaults it (`?? 'all'`), so the default arm was unreachable through the public type. Do not regress. Both reported contract fixes are now landed and still at ZERO: `typedStep` no longer demands a `prompt` that `adapter-workflow-execution.ts:248` discards (`02ecefcb`), and `CodexAdapter` has the narrowed constructor its own `CodexAdapterConfig` requires, with both `as CodexAdapterConfig` casts removed and four constructor tests that never existed (landed inside sibling commit `6208e29c`; verified by content at HEAD, not by diff size). Suite 213 files / 3773 tests, `tsc --noEmit` 0, flipcheck 0. Do not regress. |
| `memory` | **free — superseded** | connectors session 2026-08-17 17:10, closed out 20:25 | This row is STALE: its 4 structural errors closed at `ae4e3722` (17:11) and the package was re-taken and released by the run-lifecycle-hooks session at 20:20 — see the `memory` + `agent-types` row below for what actually shipped. Kept only so the next reader does not re-derive that this row is dead.
| `core` (union sweep) | **released 2026-08-17 20:30** | union-return sweep | 🏁 **5/5 sites narrowed** (`857fed23`): `plugin-types.onRegister`+`eventHandlers`, `agent-bus.AgentMessageHandler`, `tool-governance.onToolCall`+`onToolResult`. Internals read the result through an `unknown` widening and still await it; `plugin-registry` and both audit sinks keep their awaits. 14-test pin; A/B restoring the union reproduces **8 TS2322**, all in the pin file. 🔑 The `(fn as (x) => unknown)(x)` form would have **silently unbound `this`** — all call sites stay in method position and two tests pin that. Emitted `.d.ts` verified narrowed; `@dzupagent/otel` (the one production `DzupPlugin`) typechecks 0. Doc drift fixed in `d4ae168e`. ⚠️ **This lane introduced 4 core LINT errors** (real `setTimeout` in the pin file, the same rule execution-contracts hit in `45a690de`) — repair in flight, tracked below. |
| `agent-adapters` (union sweep) | **released 2026-08-17 20:30** | union-return sweep | 🏁 **7/7 sites narrowed** (`cdb36e22`, `3edce035`). Duplicate declarations collapsed into named exported aliases (`AdapterPluginEventHandler`, `AgentExecutionEventListener`) so the pairs cannot drift. **No casts needed anywhere** — `void` is assignable to `unknown`. 🚨🚨 **The A/B caught a VACUOUS lock**: the first run produced 5 errors, not 6, because the probe-runner fixture carried its own `(capture: ProbeCapture) => void` annotation and so was decoupled from the port under test — it now takes `NonNullable<NodeProbeRunnerPorts['capture']>`. Without the A/B a lock that locked nothing would have shipped. 4 runtime await-drop mutants killed by disjoint subsets; one authored test survived its own mutant (cleanup settled in a microtask) and was gated until it died. 4 of `e8e2ddb4`'s 16 onAny workarounds retired as consumer-side proof core's fix propagates; the other 12 left deliberately (cosmetic, no signal, live siblings). Read the full `e8e2ddb4` diff: **no assertion was ever dropped**, so the suspected 'real prize' does not exist. Suite 215 files / 3787 tests exit 0. |
| `app-tools` (union sweep) | **released 2026-08-17 20:30** | union-return sweep | 🏁 **4/4 sites narrowed** (`4a515eeb`). 🚨🚨 **The real find is a coverage hole, not the types**: mutating `await result` → `void result` in the new `invokeCallback` **SURVIVED the entire pre-existing suite** — all three existing HITL tests supply *synchronous* block-bodied callbacks, so a dropped await on an approval gate was invisible. `human.approve` could report `{ sent: true }` before the delivery callback settled, letting an agent past an approval gate before the operator ever saw the request. Now killed by 3 of the 7 new tests. A/B reproduces exactly 5 TS2322. Zero casts. ⚠️ app-tools is **not enrolled** in `check-test-typecheck` and needs no flipcheck config: its `tsconfig.json` is `include: ["src"]` with no test exclusion, so `tsc --noEmit` already typechecks its tests — which is what makes the type lock real. |
| `execution-contracts` + `express` (union sweep) | **released 2026-08-17 20:30** | union-return sweep | 🏁 **5/5 narrowed** (`5e642387`, `45a690de`, `5cd79204`). 🔑🔑 **The 'leave `wait()` alone, the union documents awaitability' argument was FALSIFIED BY PROBE, not by preference**: (1) the union does not express awaitability — it admits only `Promise<void>` *exactly*, so `wait: () => once(proc, 'exit')`, the canonical Node idiom, is **rejected**; (2) the union gives **zero** protection against a dropped await — tsc reports nothing on an un-awaited call either way. It had a real cost and no compensating benefit; the cost had already been paid three times by this package's own test doubles. Awaitability is now guaranteed properly, by `isPromiseLike` settling plus 5 await-drop mutants each killed by a distinct test. Object *views* (not bare function types) keep `this` bound for class implementers. ⚠️ Shipped `5e642387` lint-RED (real `setTimeout`) and repaired it in `45a690de` — lint was not baselined; all 5 mutations were re-run after the rewrite. 🔑 express `tsconfig.json` **excludes** tests, so its type lock is enforced only by flipcheck, not by `yarn typecheck` — verified empirically. |
| `server` (union sweep) | **released 2026-08-17 20:30** | union-return sweep | 🏁 **Both sites fixed** (`c66b9ea6`) — but as `=> unknown`, **not** the `=> void` the sweep prescribes, and the deviation is load-bearing. `=> void` typechecked, then lint raised `@typescript-eslint/no-misused-promises` at the real production supplier (`composition/workers.ts:231`): `tick()` **awaits** this seam and `buildRunReEnqueuer` returns `Promise<void>`, so unlike an event-bus handler this promise is not fire-and-forget and `void` would be a lie about the contract. That is very likely why the union was written. `=> unknown` admits every supplier shape, states the true contract, and needed **no** internal widening (`await` on `unknown` is well-typed). ✅ **Answers the open question about the cut-off 664→0 lane: `packages/server` suite was GREEN at entry — 260 files / 3941 tests, exit 0.** The recovery-critical await was real but **untested**; the new mutant killed both new tests and none of the 8 pre-existing ones. |
| `core` (hooks/middleware contract) | **free — released 2026-08-17 20:20** | run-lifecycle-hooks session | **SHIPPED.** `49116710`: `runHooks` widened to `=> Promise<unknown>` so `mergeHooks` output composes without a cast — the JSDoc pairing them was previously untypecheckable and `mergeHooks` had zero usable non-test call sites. `a3d59cb8`: the hook specs no longer claim a dispatch they perform themselves. core flipcheck 0, suite 168 files / 4972 tests. ⚠️ core LINT has 4 errors, none from this lane — all `real-setTimeout` in `__tests__/union-return-callback-positions.test.ts`, created by `857fed23` (union sweep). Do not regress.
| `agent` (`src/agent/` run path only) | **free — released 2026-08-17 20:20** | run-lifecycle-hooks session | **SHIPPED** (`3708d561`). `onRunStart`/`onRunComplete`/`onRunError` now DISPATCH at the run boundary — new `agent/run-lifecycle-hooks.ts` delegating to core's `runHooks` and reusing `buildModelHookContext`, wired into `runGenerate` and `runStream` (6 call sites). `beforeAgent` state now flows BOTH ways: seeded from `prepareRunState`, threaded through the chain, merged onto the new `GenerateResult.middlewareState`. 6 mutants killed, M1/M2 disjoint kill sets, M5/M6 non-nested. agent flipcheck 0, suite 363 files / 7599 tests, workspace `turbo run typecheck` 90/90. `src/pipeline/**` never entered. ⚠️ Two findings left for an owner: (1) `PluginRegistry.getHooks()` has NO production consumer, so a *plugin's* run hooks are still unreachable — needs `plugin-types.ts`, another session's; (2) **`dzip-agent-run-coordinator.ts:158` is dead code** — it tests `stopReason !== 'failed'` through an `as string` cast, but `'failed'` is not a `StopReason` member, so the memory-write-back suppression never fires.
| `memory` + `agent-types` | **free — released 2026-08-17 20:20** | run-lifecycle-hooks session | **SHIPPED** (`811f4064`, `7a0895f8`, `15059fd0`, `5dbc485f`). The `agent-types/src/...` deep import is GONE; the contract ships vitest-free as `@dzupagent/agent-types/fleet-contract` (plain `KnowledgeStoreContractCase[]`, throw-based assertions, type-only imports). `tsconfig.flipcheck.json` `rootDir` narrowed `".."` → `"."` — NOT deleted outright: `tsup.config.ts` sits at the package root and a real test imports it, so `"."` is the tightest bound that still admits it, and it can no longer reach outside `packages/memory`. Separately `5dbc485f` cleared the `vacuous-every` ratchet red (rose 2→4 under `64e5ebcf`). memory flipcheck 0, lint exit 0, suite 155 files / 3710 tests. Two mutants killed with disjoint kill sets.
| repo-root **gate wiring** | **free — released 2026-08-17 20:10** | ci-gate-parity session | **SHIPPED** (`c7772966`, `0096cf9e`, `f4a88829`, `5aefa953`). The `strict-ci` profile CI runs had 21 gates; `verify:strict:ci:no-circular` chains 24. `check:memory-api-census`, `check:memory-conformance` and `check:flow-corpus-losslessness` were never transcribed into it (`164327f5`, 08-04) and had **never run in CI once**; two were red. Both memory artifacts re-pinned (semantically identical — no export, ownership or capability entry moved) and all three gates now exit 0 on a pristine checkout of `5aefa953`. The census was regenerated in a **detached worktree** because two of its pins were uncommitted in the agent lane and it hashes from disk. `compareProfileToChain` + `scripts/__tests__/run-gates.test.mjs` now assert profile==chain, enforced by `test:scripts` which is itself a gate in the profile. Do not regress. ⚠️ **Two more gates run NOWHERE and are red — reported, not taken:** `check:security-audit-status` (its required `docs/SECURITY-AUDIT.md` was deliberately retired by `4f2301b2`; the gate was not — restore or retire, do not make it pass vacuously) and `check:flow-conformance` (matrix last refreshed 07-11, flow packages changed through 08-17; **do not regenerate while flow-\* is dirty**). Neither is in any chain, so wiring them is a policy call, not drift repair. |

**NOT claimed and not touched by this lane:** `packages/agent` (**11** union
declaration sites, 6 of them in `pipeline/loop-executor/types.ts`) is LIVE — that
file and `for-each-loop.ts` were written at 19:27, three minutes before the
claim, and the lane was still writing at 20:15. The `flow-ast` / `flow-compiler`
/ `flow-dsl` working trees are also dirty from a separate lane. Excluded on
occupancy, not on merit.

### Union-return sweep — closing state, 2026-08-17 20:30

**23 of 34 TypeScript declaration sites closed across 6 packages; the 11 that
remain are all in `packages/agent` and are the only ones left in the
workspace.** (Corrected: an earlier revision of this row said "26 of 38" — that
count included markdown prose and comment lines. Counting `.ts` declarations
only: agent 11, agent-adapters 7, app-tools 4, core 5, execution-contracts 3,
express 2, server 2 = 34 before; 11 after. Of the 11 left, **6 are under
`src/pipeline/`** — `loop-executor/types.ts` ×4 and `pipeline-runtime-types.ts`
×2 — and belong to the live for-each lane; the other **5 are outside pipeline**
(`approval/approval-types.ts:101`, `mailbox/types.ts:95`,
`mailbox/agent-mailbox.ts:126`, `observability/llm-call-audit.ts:83`,
`orchestration/team/team-workspace.ts:14`) and are takeable as soon as
`packages/agent` is free.) Verified
by content at `origin/main`, not from the lanes' reports: every claimed package
greps to **0** union declaration sites, and all seven pinning test files are
present (14/11/3/7/14/26/11 tests) with no probe or mutant debris anywhere.

Two results are worth more than the type cleanup, and both were found by
mutation rather than by reading:

1. **`app-tools`** — a dropped `await` on the human-approval callback survived
   the *entire* pre-existing suite, because every existing HITL test supplied a
   synchronous callback. `human.approve` could report `{ sent: true }` before
   the delivery callback settled.
2. **`server`** — the recovery-critical `reEnqueueRun` await was real but had no
   test at all; 8 pre-existing tests all survived the mutant.

And one methodological result: **`agent-adapters`' A/B caught a lock that locked
nothing** (a fixture with its own annotation, decoupled from the port under
test). The A/B revert is not ceremony — it is the only thing that distinguishes
a type lock from a comment.

✅ **The one regression from this lane is REPAIRED** (`40c9f3f1`): `857fed23`
introduced 4 `packages/core` lint errors (real `setTimeout` in the new pin
file), the same rule `execution-contracts` hit in `45a690de`. core lint is back
to **0 errors / 62 warnings**, suite unchanged at 168 files / 4972 tests,
flipcheck 0.

🔑 **The repair could not be the obvious one, and this generalises.** Swapping
the timers for a bare `await Promise.resolve()` would have made both await-drop
mutants **undetectable** — the callback's continuation still lands before the
test's own `await` resumes, so the ordering assertion holds identically with and
without the `await`. The express lane hit this first; it was confirmed here
rather than assumed. Both load-bearing tests now use an explicit **deferred
gate** — park the callback, assert the operation is *still pending*, then
release — which is immune to microtask-count luck and strictly stronger than the
ordering assertion it replaces. Re-verified by mutation: the two mutants kill
**different subsets** (2 tests vs 1), so the locks are non-redundant.

⚠️ Note for whoever runs core lint: the command still exits 1, entirely on a
**foreign** ratchet red (`event-bus-circuit-breaker-deep.test.ts`: `vacuous-every
fell 1 -> 0` while `eslint.baseline.js` still records 1). ESLint itself reports 0
errors. That check reported 2 problems before this repair and 1 after — clearing
the last one needs `lint:baseline:update`, which is its owner's call, not ours.

Packages at zero (do not regress): `adapter-rules`, `cache`,
`connectors-browser`, `create-dzupagent`, `dialogue-core-replay`, `express`,
`otel`, `scraper`, `test-utils`, `testing`.
