# ADR-0009: Break Remaining 11 Circular Dependencies via Intermediate Contract Files

## Status

Accepted / implemented — 2026-05-08

**Verification snapshot (2026-05-08):**
- `node scripts/check-circular-deps.mjs` → 32 packages scanned, 0 cycles, 0
  unexpected cycles, 0 resolved baseline cycles.
- `config/circular-deps-baseline.json` → empty `packages` map (no remaining
  cycles to baseline).
- `madge --circular --extensions ts packages/*/src/index.ts` → "No circular
  dependency found!"
- `yarn verify` and `yarn verify:strict` both invoke `yarn check:circular-deps`
  as a pre-Turbo gate.

The ADR's Implementation Plan is therefore fully landed; this document is
retained as the canonical record of the recipe so any future reintroduced
cycle of the same shape ("facade owns both the runtime and the type, helper
needs the type") can be closed by re-applying the per-group pattern.

## Context

At the start of this ADR lane, `npx madge --circular --extensions ts packages`
reported **11 circular dependency cycles** across `@dzupagent/agent` and
`@dzupagent/server`. A narrower run scoped to `packages/agent/src/agent`
showed seven of them, and the remaining four lived in
`packages/agent/src/orchestration` and
`packages/server/src/{composition,scorecard,deploy,routes}`:

```
1) agent/src/agent/tool-loop.ts > tool-loop/loop-stages.ts
2) agent/src/agent/tool-loop.ts > tool-loop/model-turn-kernel.ts
3) agent/src/agent/tool-loop.ts > tool-loop/policy-enabled-tool-executor.ts
4) agent/src/agent/run-engine.ts > run-engine-generate-helpers.ts
5) agent/src/agent/run-engine.ts > run-engine-streaming-helpers.ts > stream-budget-gate.ts
6) agent/src/agent/run-engine.ts > run-engine-streaming-helpers.ts > stream-result-helpers.ts
7) agent/src/agent/run-engine.ts > run-engine-streaming-helpers.ts > stream-tool-phase.ts
8) agent/src/orchestration/delegating-supervisor.ts > planning-agent.ts
9) server/src/composition/types.ts > routes/deploy.ts > deploy/signal-checkers.ts > deploy/confidence-calculator.ts > scorecard/integration-scorecard.ts
10) server/src/scorecard/integration-scorecard.ts > scorecard/probe-collector.ts
11) server/src/composition/types.ts > routes/run-context.ts
```

Implementation update, 2026-05-08: the ADR lane is now closed. The current
package guard, `node scripts/check-circular-deps.mjs`, reports **0 cycles**
across all packages, and `config/circular-deps-baseline.json` has an empty
baseline.

### How we got here

Earlier sprints reduced cycles from **27 → 9 → 11** by extracting type-only
sibling files (for example `delegating-supervisor-types.ts`,
`tool-loop/contracts.ts`, `deploy/confidence-types.ts`) and by replacing
runtime cross-imports with dynamic `import()` calls where lifecycle ordering
already permitted lazy loading. The session ground-truth memos
(`project_audit_closure_2026_05_07.md`, `project_reeval_2026_05_07_v3.md`)
explicitly track the residual cycles as "9 architectural" — this ADR is the
record that closes the remaining group with a single repeatable pattern.

### Why these are harder than the 18 we already broke

Each remaining cycle has the same structural signature:

> A facade module (`tool-loop.ts`, `run-engine.ts`, `composition/types.ts`,
> `integration-scorecard.ts`, `delegating-supervisor.ts`) is the **public
> entry point** for a subsystem and exports both the runtime function and
> the configuration types that callers need. Its helper modules then need
> those same configuration types as `import type` references, which closes
> the loop.

In other words, the facade owns the public type and the helper owns the
implementation that consumes the type — and Node ESM's static import graph
records the back-reference even when it is purely `import type`. The previous
sprints' tactic of extracting *implementation* siblings does not help here
because the cycle is on the *type contract* itself.

The fix is therefore not "split bigger files" but "extract a third file that
both the facade and the helpers depend on, and that depends on neither".

Concrete back-import evidence from the pre-closure source tree:

| Helper | Imports from facade |
| --- | --- |
| `agent/src/agent/tool-loop/model-turn-kernel.ts:4` | `import type { ToolLoopConfig } from '../tool-loop.js'` |
| `agent/src/agent/tool-loop/loop-stages.ts:16` | `import type { StopReason, ToolLoopConfig } from '../tool-loop.js'` |
| `agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:22` | `import type { ToolLoopConfig, ToolRetryConfig } from '../tool-loop.js'` |
| `agent/src/agent/run-engine-generate-helpers.ts:42` | `import type { ExecuteGenerateRunParams } from './run-engine.js'` |
| `agent/src/agent/stream-budget-gate.ts:18` | `} from './run-engine.js'` |
| `agent/src/agent/stream-result-helpers.ts:18` | `} from './run-engine.js'` |
| `agent/src/agent/stream-tool-phase.ts:28` | `} from './run-engine.js'` |
| `agent/src/orchestration/planning-agent.ts:13` | `import type { DelegatingSupervisor, TaskAssignment } from './delegating-supervisor.js'` |
| `server/src/composition/types.ts:46` | `import type { TokenLifecycleRegistry } from '../routes/run-context.js'` |
| `server/src/composition/types.ts:48` | `import type { DeployRouteConfig } from '../routes/deploy.js'` |
| `server/src/scorecard/probe-collector.ts:3` | `import type { ScorecardProbeInput } from './integration-scorecard.js'` |
| `server/src/deploy/confidence-calculator.ts:17` | `import type { ScorecardReport } from '../scorecard/integration-scorecard.js'` |

(Note: `delegating-supervisor.ts` uses a dynamic `import('./planning-agent.js')`
at line 293, so cycle 8 closes only because `planning-agent.ts` makes a
**static** type import of `DelegatingSupervisor` from the supervisor file.)

## Decision

For every remaining cycle, introduce a **pure-type intermediate contract
file** that both the facade and the helpers import. The facade then becomes
the runtime composition root that *uses* the helpers; helpers stop importing
the facade entirely.

The pattern is uniform:

```
Before:                          After:
                                 ┌────────────────────┐
   facade.ts ──────────► helper.ts             contract.ts (types only)
        ▲                   │                  ▲          ▲
        └───────────────────┘                  │          │
        (cyclic type import)            facade.ts  helper.ts
                                             │          ▲
                                             └──────────┘
                                            (one-way runtime use)
```

The five groups below name the exact new file to create and the exact import
change.

### Group A — tool-loop cycles 1, 2, 3

**Cause.** `tool-loop.ts` exports `ToolLoopConfig`, `ToolRetryConfig`, and
`StopReason`. Each of `model-turn-kernel.ts`, `loop-stages.ts`, and
`policy-enabled-tool-executor.ts` `import type`-references one or more of
these from `'../tool-loop.js'`.

**Decision.** A `tool-loop/types.ts` already exists and is the natural home
for these contracts. Extend it to be the canonical source of all tool-loop
configuration and stop-reason types.

- **New / extended file:** `packages/agent/src/agent/tool-loop/types.ts`
- **Move from `tool-loop.ts` into `tool-loop/types.ts`:**
  - `export interface ToolLoopConfig`
  - `export interface ToolRetryConfig`
  - `export type StopReason`
  - any other `import type`-only symbols currently re-exported by `tool-loop.ts`
- **Keep in `tool-loop.ts`:** the `runToolLoop` runtime function, side-effecting
  imports (`StuckError`), and a re-export band:
  ```ts
  export type { ToolLoopConfig, ToolRetryConfig, StopReason } from './tool-loop/types.js'
  ```
  so that existing public API consumers (`packages/agent/src/index.ts`) continue
  to work unchanged.
- **Helper changes:**
  - `tool-loop/model-turn-kernel.ts:4` → `from './types.js'`
  - `tool-loop/loop-stages.ts:16` → `from './types.js'`
  - `tool-loop/policy-enabled-tool-executor.ts:22` → `from './types.js'`

### Group B — run-engine cycles 4, 5, 6, 7

**Cause.** `run-engine.ts` exports `ExecuteGenerateRunParams` and the streaming
parameter / result types that `run-engine-generate-helpers.ts`,
`run-engine-streaming-helpers.ts`, `stream-budget-gate.ts`,
`stream-result-helpers.ts`, and `stream-tool-phase.ts` need.

**Decision.** Create a new sibling `run-engine/types.ts` (introducing the
`run-engine/` directory; this is the first occupant). Move the run-engine
contract types out of `run-engine.ts`.

- **New file:** `packages/agent/src/agent/run-engine/types.ts`
- **Move from `run-engine.ts` into `run-engine/types.ts`:**
  - `export interface ExecuteGenerateRunParams`
  - all streaming parameter / result interfaces re-exported by
    `run-engine.ts` and consumed by the four streaming helpers (the actual
    set will be derived from the `} from './run-engine.js'` import lines in
    `stream-budget-gate.ts:18`, `stream-result-helpers.ts:18`,
    `stream-tool-phase.ts:28`, and the named import in
    `run-engine-generate-helpers.ts:42`)
- **Keep in `run-engine.ts`:** the `executeGenerateRun` / `executeStreamingRun`
  functions, runtime-only imports, and a re-export band for backwards
  compatibility.
- **Helper changes:**
  - `run-engine-generate-helpers.ts:42` → `from './run-engine/types.js'`
  - `stream-budget-gate.ts:18` → `from './run-engine/types.js'`
  - `stream-result-helpers.ts:18` → `from './run-engine/types.js'`
  - `stream-tool-phase.ts:28` → `from './run-engine/types.js'`
  - `run-engine-streaming-helpers.ts` → ensure it imports types only from
    `./run-engine/types.js`, not from `./run-engine.js`

This group is intentionally larger than Group A but uses the same recipe.

### Group C — delegating-supervisor ↔ planning-agent (cycle 8)

**Cause.** `planning-agent.ts:13` does
`import type { DelegatingSupervisor, TaskAssignment } from './delegating-supervisor.js'`,
while `delegating-supervisor.ts:293` dynamically imports `PlanningAgent`
back. Even though the runtime edge from supervisor → planner is dynamic, the
static type edge from planner → supervisor closes the cycle.

**Decision.** Extract a `SupervisorPlanningContract` type bundle into a new
file. `delegating-supervisor-types.ts` already exists, but it is the
implementation-detail type sibling of the supervisor; the planning contract
is a different concern and deserves its own file so the supervisor can keep
its private internal types separate from its public planning surface.

- **New file:** `packages/agent/src/orchestration/planning-contracts.ts`
- **Move into `planning-contracts.ts`:**
  - the parts of the `DelegatingSupervisor` interface that the planner needs
    (a narrower `SupervisorPlanningSurface` type — `decompose`, `assign`,
    `report`, plus whatever subset of methods `planning-agent.ts` actually
    calls today)
  - `TaskAssignment` (move from `delegating-supervisor.ts` if it lives
    there, or re-export from `delegating-supervisor-types.ts` to centralise
    the planning surface)
- **`delegating-supervisor.ts` changes:** declare that
  `class DelegatingSupervisor implements SupervisorPlanningSurface`. Continue
  to use the dynamic `import('./planning-agent.js')` for the planner — that
  edge is fine because the back-edge is now via `planning-contracts.ts`,
  which depends on neither.
- **`planning-agent.ts:13` changes:**
  ```ts
  import type { SupervisorPlanningSurface, TaskAssignment } from './planning-contracts.js'
  ```
- **Re-exports.** `delegating-supervisor.ts` may re-export the contract types
  for backwards compatibility, but new callers should import from
  `planning-contracts.ts`.

### Group D — server composition/types ↔ routes (cycles 9, 11)

**Cause.** `composition/types.ts` is named "types" but is **not** a pure-type
file — it imports from `../routes/run-context.js` (line 46) and
`../routes/deploy.js` (line 48). Those route files in turn import from
`composition/*` either directly or transitively. Both back-edges run through
`composition/types.ts`, so making it strictly pure-types breaks both cycles
at once.

**Decision.** Split `composition/types.ts` into:

1. **`composition/types.ts`** (kept) — pure type re-exports and configuration
   interfaces. **No imports from `../routes/**`**. **No imports from
   `../runtime/**`, `../middleware/**`, `../persistence/**` that themselves
   transitively reach back into composition.** Rule: this file may import
   only from `@dzupagent/*` packages, from `../security/**`, and from
   *peer-type files* (sibling `*-types.ts` modules). It must not import any
   file that performs runtime side effects.

2. **`composition/wiring.ts`** (new) — runtime composition, instances, and
   the `ForgeServerConfig` resolver that needs `TokenLifecycleRegistry`,
   `DeployRouteConfig`, `LearningRouteConfig`, `BenchmarkRouteConfig`,
   `EvalRouteConfig`, `CompileRouteConfig`, `A2ARoutesConfig`, etc. Move the
   route-config-shaped imports here. The wiring file is allowed to import
   from `../routes/*.ts` because nothing in `composition/types.ts` reaches
   back to it.

- **New file:** `packages/server/src/composition/wiring.ts`
- **`composition/types.ts` changes:**
  - Remove all imports of `../routes/run-context.js`, `../routes/deploy.js`,
    `../routes/learning.js`, `../routes/benchmarks.js`, `../routes/evals.js`,
    `../routes/compile.js`, `../routes/a2a.js`, `../routes/memory-health.js`.
  - For each route-config interface that `types.ts` currently re-exports,
    move the *interface itself* into a sibling type file under the route's
    own folder (for example `routes/deploy-types.ts`,
    `routes/run-context-types.ts`) so that *both* `composition/types.ts`
    and the route's runtime file can import the type from the same neutral
    home. This is the same recipe as Groups A and B, applied to the server
    package.
  - `composition/types.ts:46` becomes
    `import type { TokenLifecycleRegistry } from '../routes/run-context-types.js'`
  - `composition/types.ts:48` becomes
    `import type { DeployRouteConfig } from '../routes/deploy-types.js'`
  - Apply the same change for `LearningRouteConfig`,
    `BenchmarkRouteConfig`, `EvalRouteConfig`, `CompileRouteConfig`,
    `A2ARoutesConfig`, `MemoryHealthRouteConfig` — each route file gets a
    sibling `*-types.ts` peer.
- **Route file changes:** each `routes/<name>.ts` imports its own config
  type from `./<name>-types.js`. The route `createXRoutes()` factory keeps
  its existing signature.
- **Add a CI guardrail:** an architecture test for
  `packages/server/src/__tests__/composition-types-purity.test.ts` that
  reads `composition/types.ts` and asserts no `from '../routes/'` and no
  `from '../runtime/'` runtime imports — only `import type` to sibling
  `*-types.ts` files is allowed.

### Group E — server scorecard cycle 10

**Cause.** `integration-scorecard.ts:15` imports from
`./probe-collector.js`, and `probe-collector.ts:3` imports
`type { ScorecardProbeInput }` from `./integration-scorecard.js`.
Additionally `deploy/confidence-calculator.ts:17` imports
`type { ScorecardReport } from '../scorecard/integration-scorecard.js'`,
which is part of the longer cycle 9 chain.

**Decision.** Extract the scorecard contract types into a neutral file that
both `integration-scorecard.ts`, `probe-collector.ts`, and the deploy
package depend on.

- **New file:** `packages/server/src/scorecard/contracts.ts`
- **Move into `scorecard/contracts.ts`:**
  - `export type ScorecardProbeInput`
  - `export type ScorecardProbeOutput`
  - `export type ScorecardReport`
  - any other types that cross the integration-scorecard / probe-collector
    boundary
- **`scorecard/probe-collector.ts:3` changes:**
  ```ts
  import type { ScorecardProbeInput } from './contracts.js'
  ```
- **`scorecard/integration-scorecard.ts` changes:** keep the runtime import
  `from './probe-collector.js'` (one-way edge, no longer cyclic). Re-export
  the contract types for backwards compatibility.
- **`deploy/confidence-calculator.ts:17` changes:**
  ```ts
  import type { ScorecardReport } from '../scorecard/contracts.js'
  ```
  This single edit removes the deploy → scorecard arm of cycle 9. Combined
  with Group D, cycle 9 is fully broken.

## Consequences

### Positive

- All 11 cycles closed under one repeatable recipe. No code is rewritten —
  only type definitions move from facade files into neutral sibling files.
- `npx madge --circular --extensions ts packages` returns clean (zero cycles).
- The recipe is documented and reusable: any future cycle of the same shape
  ("facade owns both the runtime and the type, helper needs the type") has a
  prescribed fix.
- The pattern is consistent with the established convention in the codebase
  (`delegating-supervisor-types.ts`, `tool-loop/contracts.ts`,
  `deploy/confidence-types.ts`).
- Each new contract file is independently testable and may grow its own
  unit tests without dragging in runtime initialisation.

### Negative / Trade-offs

- File count grows by **6 new files** (`tool-loop/types.ts` is extended, not
  new): `run-engine/types.ts`, `planning-contracts.ts`, `composition/wiring.ts`,
  6× `routes/<name>-types.ts`, and `scorecard/contracts.ts`. Discoverability
  cost is mitigated by keeping the facade files as re-export bands.
- `composition/types.ts` becomes a stricter contract: any future PR that adds
  a runtime import to it must be rejected by the new architecture test.
  This is a feature, not a bug, but contributors must be aware.
- The Group D split (composition wiring) has the highest blast radius. The
  facade re-exports preserve binary compatibility, but every route file must
  be touched to add the sibling `*-types.ts`.

### Risks

- **Hidden static side-effect imports.** A pure `import type` should be
  erased by the TypeScript compiler, but if any helper currently uses a
  value-level identifier that we mistakenly classify as type-only, the
  refactor will break compilation. Mitigation: each per-group commit is
  guarded by `yarn typecheck --filter=@dzupagent/<package>` before the next
  group is started.
- **Test fixtures.** Some tests deep-import from facade files (for example
  `import { ToolLoopConfig } from '../tool-loop.js'`). The re-export bands
  preserve these, but a future "remove the band" cleanup must be sequenced
  after consumers migrate.
- **Circular re-exports.** If `tool-loop.ts` re-exports from
  `tool-loop/types.ts` AND `tool-loop/types.ts` ever imports back from
  `tool-loop.ts`, the cycle reappears. Mitigation: a lint rule (or the new
  `composition-types-purity` test, generalised) asserts that contract files
  only import from packages and from sibling `*-types.ts` files.

## Constraints

- Must not introduce a `core` → `agent` / `codegen` / `server` boundary
  violation. All changes are inside `@dzupagent/agent` and `@dzupagent/server`.
- Must compile under TypeScript strict mode with no `any`.
- Public API of each affected package (`@dzupagent/agent` index, `@dzupagent/server`
  index) must remain unchanged. Re-export bands in the facade files preserve
  the existing surface.
- Each new contract file must be importable by tests without instantiating
  any runtime (no top-level side effects).
- The `madge --circular` check must pass at the end of each group's commit.
- Existing test suites must continue to pass without modification:
  `yarn test --filter=@dzupagent/agent`,
  `yarn test --filter=@dzupagent/server`.

## Alternatives Considered

1. **Collapse helpers back into the facade.** Inlining the helper modules
   into `tool-loop.ts` and `run-engine.ts` would mechanically eliminate the
   cycles. Rejected: the helpers were extracted in earlier sprints precisely
   to keep the facades small and unit-testable. Re-merging would regress
   readability and undo testing work.

2. **Use `import type` only and rely on TS erasure.** Several helpers already
   use `import type` and the cycle persists because madge analyses the
   import graph statically without applying `verbatimModuleSyntax`. Even
   though Node ESM erases type-only imports at runtime, the static graph
   analysis (and the `madge` gate) still flags them. Rejected: the goal is
   to satisfy the static gate, not just runtime correctness.

3. **Convert all back-edges to dynamic `import()`.** This is what
   `delegating-supervisor.ts:293` already does for the planner. It works for
   one-off cases but it pessimises bundling and tree-shaking, and it forces
   every consumer to handle the async boundary. Rejected as a general
   pattern; reserved for cases where the dynamic boundary is semantically
   warranted (lazy load, optional dependency).

4. **Single shared `contracts.ts` per package.** Putting all extracted
   contracts in one large file per package would reduce file count.
   Rejected: it couples unrelated subsystems (tool-loop and run-engine)
   into one module and obscures ownership; subsystem-scoped contract files
   match the existing convention.

## Implementation checklist

Order chosen to minimise blast radius: Group E first (smallest), then D
(server composition split, isolated package), then B (run-engine, four
helpers), then A (tool-loop, three helpers), then C (orchestration). Each
group ends with `npx madge --circular --extensions ts packages` and a
package-scoped `yarn typecheck && yarn test`.

- [x] **Step 0 — Baseline.** The starting 11-cycle list is recorded in this
      ADR, and the enforced baseline is now empty in
      `config/circular-deps-baseline.json` after closure.
- [x] **Step 1 — Group E (scorecard cycle 10).**
  - [x] Create `packages/server/src/scorecard/contracts.ts` with
        scorecard report, check, recommendation, and probe input contracts.
  - [x] Edit `packages/server/src/scorecard/probe-collector.ts:3` →
        `from './contracts.js'`.
  - [x] Edit `packages/server/src/deploy/confidence-calculator.ts:17` →
        `from '../scorecard/contracts.js'`.
  - [x] In `integration-scorecard.ts`, add re-export band for scorecard
        contracts from `./contracts.js`.
  - [x] `yarn workspace @dzupagent/server typecheck` and focused scorecard tests passed.
  - [x] `node scripts/check-circular-deps.mjs --pkg server` — scorecard cycles gone.
- [x] **Step 2 — Group D (composition split, cycles 9 + 11).**
  - [x] For each route, create a sibling `routes/<name>-types.ts`:
        `deploy-types.ts`, `run-context-types.ts`, `learning-types.ts`,
        `benchmarks-types.ts`, `evals-types.ts`, `compile-types.ts`,
        `a2a-types.ts`, `memory-health-types.ts`. Move the `XxxRouteConfig`
        interface into each.
  - [x] Update `routes/<name>.ts` to import its config type from
        `./<name>-types.js` (one-line edit per route).
  - [x] Update `composition/types.ts` import lines 45–58 to import all
        route-config types from the new `*-types.js` siblings instead of
        the runtime route files.
  - [x] No `packages/server/src/composition/wiring.ts` was needed: current
        `composition/types.ts` contains interfaces/type aliases only, so there
        was no runtime / instance composition to move.
  - [x] Add architecture test
        `packages/server/src/__tests__/composition-types-purity.test.ts`
        that asserts `composition/types.ts` has no
        `from '../routes/<name>.js'` (only `from '../routes/<name>-types.js'`).
  - [x] `yarn workspace @dzupagent/server typecheck` and focused server tests passed.
  - [x] `node scripts/check-circular-deps.mjs --pkg server` — server cycles gone.
- [x] **Step 3 — Group B (run-engine cycles 4, 5, 6, 7).**
  - [x] Create directory `packages/agent/src/agent/run-engine/`.
  - [x] Create `packages/agent/src/agent/run-engine/types.ts`. Move
        `ExecuteGenerateRunParams` and the streaming parameter / result
        interfaces (derived from the `} from './run-engine.js'` import
        statements in `stream-budget-gate.ts`, `stream-result-helpers.ts`,
        `stream-tool-phase.ts`, plus `ExecuteGenerateRunParams` in
        `run-engine-generate-helpers.ts:42`) into it.
  - [x] Edit `run-engine-generate-helpers.ts:42` →
        `from './run-engine/types.js'`.
  - [x] Route streaming helper shared contracts through
        `packages/agent/src/agent/run-engine/types.ts` where they are part of
        the run-engine boundary:
    - [x] `stream-budget-gate.ts` imports `StreamingToolCall` from
          `./run-engine/types.js`.
    - [x] `stream-tool-phase.ts` imports `StreamingToolCall` and
          `StreamPhaseResult` from `./run-engine/types.js`, while re-exporting
          `StreamPhaseResult` for the existing barrel.
    - [x] `stream-result-helpers.ts` did not import `./run-engine.js`; its
          contracts remain in `streaming-tool-types.ts`.
  - [x] Inspect `run-engine-streaming-helpers.ts`; it imports only streaming
        helper modules and no longer imports `./run-engine.js`.
  - [x] Add re-export band in `run-engine.ts`:
        `export type * from './run-engine/types.js'`.
  - [x] `yarn workspace @dzupagent/agent typecheck` passed.
  - [x] Focused run-engine tests passed.
  - [x] `node scripts/check-circular-deps.mjs --pkg agent` reported 0 cycles
        after the run-engine and tool-loop type seams were both in place.
- [x] **Step 4 — Group A (tool-loop cycles 1, 2, 3).**
  - [x] Existing `packages/agent/src/agent/tool-loop/types.ts` already owns
        `ToolLoopConfig`, `ToolRetryConfig`, and `StopReason`.
  - [x] Edit three import sites:
    - [x] `tool-loop/model-turn-kernel.ts:4` → `from './types.js'`
    - [x] `tool-loop/loop-stages.ts:16` → `from './types.js'`
    - [x] `tool-loop/policy-enabled-tool-executor.ts:22` was already routed
          through `from './types.js'`.
  - [x] Re-export band in `tool-loop.ts` remains:
        `export type { ToolLoopConfig, ToolRetryConfig, StopReason } from './tool-loop/types.js'`.
  - [x] `yarn workspace @dzupagent/agent typecheck` passed.
  - [x] Focused tool-loop tests passed.
  - [x] `node scripts/check-circular-deps.mjs --pkg agent` reported 0 cycles;
        `config/circular-deps-baseline.json` now has an empty baseline.
- [x] **Step 5 — Group C (delegating-supervisor ↔ planning-agent, cycle 8).**
  - [x] Current `planning-agent.ts` depends on `planning-types.ts`, not
        `delegating-supervisor.ts`; the supervisor surface is already type-only
        through `PlanningSupervisor`.
  - [x] `delegating-supervisor.ts` imports shared contracts from
        `delegating-supervisor-types.ts` and keeps the planner edge as a
        dynamic `import('./planning-agent.js')`.
  - [x] `node scripts/check-circular-deps.mjs` reports 0 cycles total.
- [x] **Step 6 — Add a permanent madge gate.**
  - [x] Root already has `yarn check:circular-deps` backed by
        `scripts/check-circular-deps.mjs`.
  - [x] `yarn verify:strict` already ran `check:circular-deps`; `yarn verify`
        now runs it too.
  - [x] Update `CLAUDE.md` "Quality Gates" section to mention the circular
        dependency check.
- [x] **Step 7 — Update memos.**
  - [x] Memory note recorded in operator's session ground truth
        (`project_session_2026_05_07_v3.md`,
        `project_reeval_2026_05_07_v3.md`,
        `project_audit_closure_2026_05_07.md`): the post-close state is
        **0 cycles** with an empty `circular-deps-baseline.json`. The ADR
        itself (this file) carries the verification snapshot at the top so
        the doc is self-contained without an external memo dependency.

## Related

- Source files referenced in this ADR (absolute paths):
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop/types.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop/loop-stages.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop/model-turn-kernel.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/run-engine.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/run-engine-generate-helpers.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/run-engine-streaming-helpers.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/stream-budget-gate.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/stream-result-helpers.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/stream-tool-phase.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/orchestration/delegating-supervisor.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/orchestration/planning-agent.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/composition/types.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/scorecard/integration-scorecard.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/scorecard/probe-collector.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/deploy/signal-checkers.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/deploy/confidence-calculator.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/deploy.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/run-context.ts`
- Prior ADRs: ADR-0005, ADR-0007, ADR-0008.
- Prior cycle-reduction sprints: `project_audit_closure_2026_05_07.md`
  (27 → 9), `project_reeval_2026_05_07_v3.md` (status 9 cycles open).
