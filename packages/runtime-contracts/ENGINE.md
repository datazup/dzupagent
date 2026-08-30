# The engine tier of `@dzupagent/runtime-contracts` (ARCH27-T-15)

## Decision

Executed algorithms stay **inside this package**, under `src/engine/`, instead of
moving to `@dzupagent/agent`. External consumers (the vendored worker closure,
codev-app services) execute the same algorithms against the published package
surface; relocating them to `agent` would force those consumers to depend on the
full agent runtime to replay a commit merge. The public import paths do not
change: engine symbols keep being exported through their existing domain
subpaths (`@dzupagent/runtime-contracts/recursive-scope`), never through a new
root-barrel export.

## The two tiers

- **Contract tier** (`src/` outside `engine/`): passive by definition — type
  declarations, schema constants, structural validators, digest/binding
  projections. A contract-tier module may compute a digest to _check_ a value;
  it must not own an algorithm the runtime _runs_ to produce new state.
- **Engine tier** (`src/engine/`): algorithms the agent runtime (or an external
  worker) executes — state merges, materializers that mint identities,
  resolution logic that decides an outcome. Engine modules may depend on
  contract-tier modules; contract-tier modules must never import from
  `src/engine/`. The domain subpath barrels are the one exception: they re-export
  engine symbols so the public surface stays where consumers already import it.

The repo-wide 500-LOC per-file ceiling applies to engine files with **no debt
pins**: the tier starts clean and stays clean — an engine module that outgrows
the ceiling is split, not pinned.

## Current engine inventory

- `engine/recursive-scope-commit.ts` — the recursive-scope commit engine carved
  out of `recursive-scope/commit.ts` (1002 LOC, ARCH27-N-16):
  `materializeRecursiveScopedCommitV1`, `mergeRecursiveScopedCommitsV1`,
  `resolveRecursiveAcknowledgementLossV1`, `RecursiveScopedCommitConflictError`.
  The structural validators it calls stayed in the contract tier
  (`recursive-scope/commit-validation.ts`, `recursive-scope/evidence-validation.ts`).

## Known migration candidates (not yet moved)

- `reserveAiBudget` (`ai-budget-reservation.ts`) — a reservation decision
  procedure executed by external consumers only; its file is under the ceiling,
  so the move is deferred until that surface is next touched.
- `selectTariffRates` (`ai-economics.ts`) — tier-selection logic, same status.

Moving either is consumer-neutral (subpath re-export keeps the import path) but
must be its own reviewed change: both feed persisted economics evidence.
