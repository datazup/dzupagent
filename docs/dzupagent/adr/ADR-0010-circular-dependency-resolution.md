# ADR-0010: Circular Dependency Resolution — Closure & Regression Prevention

## Status

Accepted — 2026-05-08

Supersedes the operational tracking framing of "9 remaining cycles" used in
session memos `project_audit_closure_2026_05_07.md` and
`project_reeval_2026_05_07_v3.md`. Builds on and finalises ADR-0009.

## Context

A previous architecture audit reported a residue of "9 remaining circular
dependency cycles" after an 18-cycle reduction sprint. The audit pointed at
five suspected hotspots:

1. `composition/types.ts` in `@dzupagent/server` with mutual route imports.
2. A `provider-profile` ↔ adapters mutual-import in `@dzupagent/agent-adapters`.
3. Other arch cycles in `@dzupagent/agent`.
4. Other arch cycles in `@dzupagent/core`.
5. Other arch cycles in `@dzupagent/flow-ast`.

When this ADR was opened, the working assumption was that those cycles
remained unresolved and that a follow-up sprint was needed.

### Ground truth on 2026-05-08

Three independent sources of evidence agree that **the residue is zero**:

| Evidence source | Result |
| --- | --- |
| `node scripts/check-circular-deps.mjs` (whole monorepo, 32 packages) | `Packages with cycles: 0`, `Unexpected cycles: 0` |
| `dzupagent/config/circular-deps-baseline.json` | `"packages": {}` (empty baseline — nothing accepted) |
| `npx madge --circular --extensions ts dzupagent/packages/` (10,000+ files) | `No circular dependency found!` |
| Per-package madge runs against the five suspected hotspots: `packages/core/src`, `packages/agent/src`, `packages/agent-adapters/src`, `packages/server/src`, `packages/flow-ast/src` | All five report `No circular dependency found!` |
| `provider-profile` filename or directory in `packages/agent-adapters/src/` | Does not exist anywhere in the tree |

ADR-0009 (Accepted, 2026-05-08) closed the last 11 cycles using a
type-extraction recipe and wired `yarn check:circular-deps` into `yarn verify`.
The "9 cycles" framing in session memos was a transient checkpoint between the
27 → 18 → 11 → 0 trajectory; the lower numbers were never observed in
isolation because closure batches landed faster than memos updated.

### Why this ADR is still worth writing

Writing an ADR only when cycles exist creates an asymmetry: the project knows
how it broke cycles (ADR-0009) but has no normative statement of how it stays
at zero. ADR-0010 fills that gap by:

- recording that the residue is zero and how that was verified,
- consolidating the resolution patterns from ADR-0009 into a normative
  catalogue future contributors must apply,
- naming the gates that will reject regressions,
- listing the categories of cycle that are deferred-by-policy if they ever
  reappear, with the architectural rationale for each.

This ADR therefore does not introduce new code refactors. It is a closure
record and a regression-prevention contract.

## Decision

### D1. Confirm closure status

The `dzupagent` monorepo is at **zero circular dependencies** as of
2026-05-08, both intra-package (madge per `packages/<name>/src`) and
inter-package (Yarn workspace dependency graph). No further refactoring is
required by this ADR.

### D2. Codify the resolution recipes

Any future cycle introduced by a PR must be resolved using one of the four
recipes below, in the listed preference order. The recipes are derived from
the ADR-0009 closure work and are now the standard playbook.

#### Recipe 1 — Type-Extraction Sibling (preferred)

When the cycle is `facade.ts ⇄ helper.ts` and at least one edge is an
`import type`, extract the shared types into a sibling
`<facade-name>-types.ts` (or `<facade-name>/types.ts` when a folder already
exists). Both the facade and the helpers import from the new file; the new
file imports from neither.

This is the recipe that closed the eleven cycles in ADR-0009 (tool-loop
contracts, run-engine contracts, route configs, scorecard contracts).

The facade keeps a re-export band so that downstream consumers and tests
that deep-import from the facade continue to compile:

```ts
// facade.ts
export type { ToolLoopConfig, ToolRetryConfig, StopReason } from './tool-loop/types.js'
```

#### Recipe 2 — Contract File Per Subsystem

When two facades cross-import each other's *value-level* identifiers (not
just types), the type-extraction recipe is insufficient. Extract a neutral
`contracts.ts` for the smaller of the two subsystems. Both facades import
from `contracts.ts`. The contracts file may import from `@dzupagent/core` or
from sibling `*-types.ts` files only — never from a facade.

This is what `packages/server/src/scorecard/contracts.ts` does.

#### Recipe 3 — Inversion of Control via Interface

When the cycle is `parent.ts ⇄ child.ts` because the child imports the
parent's class type, replace the class type with a narrower interface owned
by a third file (`<parent>-surface.ts` or `<subsystem>-contracts.ts`). The
parent declares `class Parent implements ParentSurface`; the child imports
`ParentSurface` only. This is what ADR-0009 Group C prescribed for
`delegating-supervisor` ↔ `planning-agent` (closed by `planning-types.ts`
plus a dynamic `import()` for the runtime back-edge).

#### Recipe 4 — Dynamic `import()` (last resort)

When none of the above is possible because the runtime back-edge is
genuinely needed (lazy loading, optional dependency, plugin discovery),
replace the static `import` with a dynamic `await import('./peer.js')`. This
removes the static graph edge that madge analyses, but it pessimises
bundling and forces consumers across an async boundary. Use only when:

- the back-edge is rare (cold path, plugin init, fallback), and
- the dynamic boundary is semantically meaningful, and
- a sibling `*-types.ts` already exists for any types still crossing the
  boundary statically (otherwise the type edge keeps the cycle alive).

`delegating-supervisor.ts:293` is the only sanctioned use of this recipe in
the current codebase.

### D3. Forbidden patterns

Independent of cycle status, the following patterns are rejected at PR review
because they reintroduce cycles or mask them from the gate:

| Forbidden | Reason |
| --- | --- |
| Adding a runtime import from `composition/types.ts` to `routes/*.ts` | Recreates ADR-0009 cycles 9 and 11. The architecture test `packages/server/src/__tests__/composition-types-purity.test.ts` rejects this. |
| Adding a value-level import from any `@dzupagent/*` package src to a domain package (`@dzupagent/domain-nl2sql`, `@dzupagent/workflow-domain`, `@dzupagent/org-domain`, `@dzupagent/persona-registry`, `@dzupagent/scheduler`, `@dzupagent/execution-ledger`) | Universal-vs-domain boundary. `check:domain-boundaries` rejects this. |
| Adding `@dzupagent/agent`, `@dzupagent/codegen`, or `@dzupagent/server` to `@dzupagent/core/package.json` dependencies | Reverses the dependency root invariant from `dzupagent/CLAUDE.md`. |
| Re-exporting from a facade in a contract file | Reopens the cycle that the contract file was created to close. |
| Adding a static `import` (non-`type`) edge to a file that previously only had a dynamic `import()` back to its peer | Converts a sanctioned dynamic boundary into a static cycle. |

### D4. Permanent regression gates

The following gates are already wired and remain mandatory:

1. **`yarn check:circular-deps`** (root script, run by `yarn verify` and
   `yarn verify:strict`). Backed by `scripts/check-circular-deps.mjs`. Runs
   madge per package against `packages/<name>/src` and compares against
   `config/circular-deps-baseline.json`. The baseline is currently empty
   (`"packages": {}`); any new cycle fails the gate.
2. **`yarn check:domain-boundaries`** — universal-vs-domain boundary check
   (referenced by `dzupagent/CLAUDE.md`).
3. **`packages/server/src/__tests__/composition-types-purity.test.ts`** —
   architecture test asserting that `composition/types.ts` only imports from
   `*-types.js` siblings under `routes/**`, never from runtime route files.

No additional gate is added by this ADR; the existing gates are sufficient.
What this ADR adds is the normative reading of those gates: **the
circular-deps baseline must remain empty unless a future ADR explicitly
re-opens it**. A baseline entry is a temporary debt marker, not a permanent
exception.

### D5. Code changes performed by this ADR

None. The implementation work is owned by ADR-0009 and is already complete.
This ADR is a documentation and policy artifact.

The "implement straightforward fixes" clause in the prompt was evaluated and
returned no candidates: the current state is zero cycles, the empty
baseline, and madge clean across all five suspected hotspots. There is
nothing to fix.

## Consequences

### Positive

- The team has a single document to point at when asked "is the monorepo
  free of circular dependencies?" — the answer is yes, with three
  independent verifications recorded above.
- Future contributors have a normative recipe catalogue (D2) and a list of
  forbidden patterns (D3) to consult before opening a PR that touches
  module boundaries.
- The empty baseline is reframed from "current state" to "contract" — any
  PR that adds an entry to `circular-deps-baseline.json` must reference an
  ADR that justifies the temporary exception, with a removal milestone.
- The "9 cycles" framing from session memos is officially superseded; new
  contributors reading those memos can find the closure record here.

### Negative / Trade-offs

- This ADR adds documentation overhead with no immediate code change. The
  trade-off is acceptable because the cost of forgetting the closure (and
  redoing the audit) is higher than the cost of recording it.
- The recipe catalogue (D2) is a soft enforcement: PR reviewers must
  recognise which recipe applies. The hard gates (D4) only fire when a
  cycle is already present — they don't enforce "use the right recipe",
  they enforce "don't end with a cycle".

### Risks

- **Stale framing leaks into future audits.** If a new audit re-discovers
  "9 cycles" by reading old memos rather than running the gate, this ADR
  must be cited to short-circuit the duplicate work. Mitigation: the
  ground-truth table in the Context section is the authoritative reference.
- **Baseline drift.** Future PRs may attempt to add entries to
  `circular-deps-baseline.json` to bypass a failing gate. Mitigation: any
  baseline addition requires an ADR that justifies the temporary exception
  and names the removal milestone. PR review must reject baseline additions
  that lack such an ADR.
- **Dynamic-import abuse.** Recipe 4 is a last-resort tool. If it becomes
  the default workaround for any new cycle, the import graph fragments into
  many lazy boundaries that are correct but harder to reason about.
  Mitigation: D2 ranks Recipe 4 last and requires the previous three to be
  ruled out first.

## Alternatives Considered

1. **Do not write an ADR — the cycles are already closed.**
   Rejected. Without a normative document, the closure is implicit and the
   "9 cycles" framing keeps reappearing in audits and onboarding. The cost
   of a closure ADR is small compared to the cost of repeated rediscovery.

2. **Write a single combined ADR replacing ADR-0009.**
   Rejected. ADR-0009 records the *implementation* (which files moved,
   which imports changed). ADR-0010 records the *policy* (recipes,
   forbidden patterns, regression gates). Keeping them separate respects
   the ADR convention of "one decision per record" and lets ADR-0009
   remain a stable reference for the closure work.

3. **Convert the empty baseline into a removed file.**
   Rejected. Keeping `config/circular-deps-baseline.json` present (with an
   empty `"packages": {}`) preserves the contract that any future cycle
   must be either fixed or explicitly listed. Deleting the file would
   require regenerating the gate's baseline-comparison logic.

4. **Add a new architecture test that asserts zero cycles directly (vs.
   comparing against the baseline).**
   Rejected. The current `scripts/check-circular-deps.mjs` already fails
   when actual cycles exceed the baseline, and the baseline is empty, so
   the effective behaviour is identical. Adding a second mechanism would
   create maintenance overhead without functional gain.

## Constraints

- Must not modify any source file in `dzupagent/packages/**`. Verified: no
  source edits were made.
- Must not modify `config/circular-deps-baseline.json`. Verified: the file
  remains at `{ "packages": {} }`.
- Must not introduce a `core` → `agent` / `codegen` / `server` boundary
  violation. Verified: no dependency-graph changes.
- Public API of every package remains unchanged. Verified: no source edits.
- All existing gates (`yarn check:circular-deps`,
  `yarn check:domain-boundaries`, `composition-types-purity.test.ts`)
  remain in force unchanged.

## Validation

The following validations were performed when this ADR was authored
(2026-05-08):

- [x] `node scripts/check-circular-deps.mjs` — 32 packages scanned, 0 cycles
      total, 0 unexpected cycles, 0 baseline cycles resolved.
- [x] `npx madge --circular --extensions ts dzupagent/packages/` — 3,165
      files processed, 0 cycles.
- [x] `npx madge --circular --extensions ts packages/core/src` — 48 files,
      0 cycles.
- [x] `npx madge --circular --extensions ts packages/agent/src` — 356 files,
      0 cycles.
- [x] `npx madge --circular --extensions ts packages/agent-adapters/src` —
      439 files, 0 cycles.
- [x] `npx madge --circular --extensions ts packages/flow-ast/src` — 558
      files, 0 cycles.
- [x] `npx madge --circular --extensions ts packages/server/src` — 568
      files, 0 cycles.
- [x] `find packages/agent-adapters/src -iname "*provider-profile*"` —
      empty (the audit's referenced file does not exist).
- [x] `cat config/circular-deps-baseline.json` —
      `{ "description": "...", "packages": {} }`.

No typecheck or test commands were executed because no source files were
modified. ADR-0009's checklist already records the typecheck/test runs that
verified the underlying closure.

## Related

- ADR-0009 — Break Remaining 11 Circular Dependencies via Intermediate
  Contract Files (Accepted 2026-05-08). The implementation record this ADR
  builds on.
- ADR-0008 — Request Scope Workspace Isolation.
- ADR-0007 — Flow Compiler Layer Ownership.
- ADR-0005 — Memory Client Interface.
- `dzupagent/CLAUDE.md` — Quality Gates section names
  `yarn check:circular-deps` as part of `yarn verify`.
- `dzupagent/scripts/check-circular-deps.mjs` — the per-package gate.
- `dzupagent/config/circular-deps-baseline.json` — the empty exception
  list (the contract that this ADR locks down).
- `dzupagent/packages/server/src/__tests__/composition-types-purity.test.ts`
  — the architecture test enforcing D3.
- Session ground-truth memos referenced by this ADR (project memory):
  `project_audit_closure_2026_05_07.md`,
  `project_reeval_2026_05_07_v3.md`,
  `project_reeval_2026_05_08.md`.
