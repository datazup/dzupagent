# Architecture Stabilization Memory

Date: 2026-04-23

## Purpose

This file is a repo-local memory artifact for unfinished architecture and
stabilization work in `dzupagent`.

It exists because the active work spans multiple focused slices and the highest
value next step depends on:

- what has already been implemented
- what drift remains
- what was intentionally deferred
- what validation has already been proven

Use this document as the first read when continuing the current stabilization
lane in a new session.

## Current Objective

Keep `dzupagent` feature-rich while reducing drift between:

- public package surfaces
- internal ownership seams
- runtime and persisted contract correctness
- generated inventory/docs versus actual exports

The current lane is deliberately narrow:

1. make drift visible
2. add guardrails
3. reduce oversized public surfaces in small tranches
4. keep compatibility while migration paths are prepared

## What Is Done

### Architecture Policy

- `config/architecture-boundaries.json` exists and is the source of truth for
  the architecture boundary test
- `packages/testing/src/__tests__/boundary/architecture.test.ts` consumes that
  config instead of hardcoded policy arrays

### Server Surface Inventory

- `config/server-api-tiers.json` exists and classifies the root `server`
  surface
- `docs/SERVER_API_SURFACE_INDEX.md` is generated from the server root export
  map and the tier config
- `node scripts/server-api-surface-report.mjs`
- `node scripts/server-api-surface-report.mjs --check`
  are the active guardrails

Current known server surface baseline:

- unique root export sources: `126`
- stable: `29`
- secondary: `30`
- experimental: `49`
- internal: `18`
- recommended root exposure:
  - `29` keep-root
  - `79` candidate-subpath
  - `18` remove-root

### Contract Segmentation

`@dzupagent/adapter-types`

- internal source seams now exist:
  - `src/contracts/provider.ts`
  - `src/contracts/interaction.ts`
  - `src/contracts/execution.ts`
  - `src/contracts/events.ts`
  - `src/contracts/routing.ts`
  - `src/contracts/capabilities.ts`
  - `src/contracts/dzupagent.ts`
  - `src/contracts/run-store.ts`
- `src/index.ts` remains a stable facade

`@dzupagent/runtime-contracts`

- internal source seams now exist:
  - `src/planning.ts`
  - `src/execution.ts`
  - `src/ledger.ts`
  - `src/schedule.ts`
- `src/index.ts` remains a stable facade

### Runtime Compatibility Coverage

Persisted adapter contract coverage exists for:

- `RawAgentEvent`
- `AgentArtifactEvent`
- `GovernanceEvent`
- `RunSummary`
- `ProviderRawStreamEvent`

Server wire-surface pilot exists for:

- `packages/server/src/routes/openai-compat`

That pilot is fixture-based and already protects a meaningful request/response
path.

### Implemented Server Surface Reduction

The first actual non-root server tranche is implemented:

- `@dzupagent/server/ops` exists
- it re-exports doctor helpers and scorecard helpers
- root exports remain compatible for now

Implementation files:

- `packages/server/src/ops.ts`
- `packages/server/package.json`
- `packages/server/tsup.config.ts`
- `packages/server/src/__tests__/ops-exports.test.ts`

## What Is Not Finished

These are the unfinished features or architecture tasks that still matter.

### 1. Runtime And Control-Plane Subpath Decision

This is now the highest-value unfinished server surface task.

Still unresolved:

- should runtime helpers and control-plane helpers live under one subpath
  (`@dzupagent/server/runtime`)
- or should control-plane get its own subpath
  (`@dzupagent/server/control-plane`)

Affected modules:

- `./runtime/*` secondary exports
- `./services/agent-control-plane-service.js`
- `./services/executable-agent-resolver.js`

Why unfinished:

- the `ops` tranche proved the subpath approach
- the next tranche should not be implemented until the migration matrix is
  explicit

### 2. Root Alias Removal Strategy

Current state:

- `server/ops` exists
- root exports still re-export ops helpers

Still unresolved:

- when root aliases should be deprecated
- how long compatibility should be kept
- whether any internal repo consumers should be migrated first

This should remain deferred until the next non-root seam is explicit.

### 3. Next Wire-Surface Compatibility Extension

The runtime-compatibility lane is no longer blocked, but it is intentionally not
the first next step.

Still unresolved:

- whether the next compatibility target should be:
  - another `server` wire surface
  - event gateway envelopes
  - a future `@dzupagent/server/compat` seam

This decision should be made after the runtime/control-plane migration matrix
exists, so compatibility work follows export-reduction priorities instead of
drifting into disconnected coverage.

### 4. Broader Runtime Schema Adoption

The repo has fixture-based compatibility protection in key places, but broader
runtime schema coverage is still not implemented for:

- event gateway envelopes
- more server transport surfaces
- trace/eval/benchmark persisted records

That remains a real gap, but it is lower priority than choosing the next
explicit server seam.

## Residual Drift Analysis

### Drift Already Reduced

- architecture-policy drift:
  reduced by moving policy into config
- contract concentration drift:
  reduced by splitting shared contract packages into seam-owned source modules
- persisted contract drift:
  reduced by fixture-based compatibility coverage
- server ops-surface drift:
  reduced by giving doctor/scorecard helpers a non-root home

### Drift Still Present

#### A. Root-Surface Drift

The root surface is still much broader than real direct consumer usage.

Even after the `ops` tranche, root breadth is still structurally high because:

- compatibility aliases remain
- runtime/control-plane exports still live on root
- compat and other secondary/experimental exports are still root-reachable

#### B. Runtime/Control-Plane Boundary Drift

The server package still mixes:

- minimal host bootstrap APIs
- runtime execution helpers
- control-plane resolver/service helpers

That is now the highest-value unresolved server architecture seam.

#### C. Runtime-Compatibility Drift

The repo has good pilot coverage but not yet broad runtime schema discipline.

The main risk is not “no coverage exists”; it is “coverage exists selectively
and needs to be extended along the highest-pressure seams.”

## Recommended Next Slice

The best next slice is:

1. document the runtime/control-plane migration matrix
2. decide between:
   - `@dzupagent/server/runtime`
   - `@dzupagent/server/control-plane`
   - or a split between the two
3. only then implement the next explicit non-root server entrypoint

Why this is the best next slice:

- it minimizes the biggest remaining server drift
- it avoids premature alias removal
- it keeps the work documentation-first and reversible
- it prevents the next export change from being ad hoc

## Detailed Next Tasks

### Task A: Runtime/Control-Plane Migration Matrix

Deliverable:

- one doc that lists each current secondary runtime/control-plane export and
  assigns it to:
  - keep-root for now
  - `server/runtime`
  - `server/control-plane`
  - future `server/compat`

Include:

- current source module
- sample exports
- current known direct consumers if any
- proposed destination
- reason
- compatibility note

### Task B: Subpath Decision

Decide whether:

- `AgentControlPlaneService`
- `ControlPlaneExecutableAgentResolver`
- `AgentStoreExecutableAgentResolver`
- `ExecutableAgentResolver`

should:

- stay grouped with runtime
- or become their own control-plane seam

Decision criteria:

- shared change frequency
- likely consumer shape
- whether the symbols are composition helpers or public host-runtime APIs

### Task C: Implementation Tranche Planning

Once the matrix exists:

- define the exact next export entrypoint
- define whether root aliases stay for that tranche
- define the narrow validation set before any edits

### Task D: Compatibility Follow-On

After the next server seam is explicit:

- decide if the next runtime-compatibility extension should target:
  - `server/compat`
  - event gateway envelopes
  - another high-pressure serialized surface

## Verification That Has Already Been Proven

These checks were already proven on the current lane and should be treated as
the baseline verification pattern.

### Server Ops Tranche

- `yarn workspace @dzupagent/server build`
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/server test src/__tests__/ops-exports.test.ts src/__tests__/doctor.test.ts src/__tests__/integration-scorecard.test.ts`
- `node scripts/server-api-surface-report.mjs`
- `node scripts/server-api-surface-report.mjs --check`

### Additional Architecture/Governance Checks Previously Used

- `node scripts/check-package-tiers.mjs`
- `node scripts/check-domain-boundaries.mjs`

Note:

- `yarn workspace @dzupagent/testing test src/__tests__/boundary/architecture.test.ts`
  has been used as a target guardrail, but one rerun in this lane did not return
  a completion signal in time. Treat that specific attempt as inconclusive
  rather than as a known failure.

## Guardrails For Continuation

- keep scope narrow
- do not revert unrelated worktree changes
- do not remove root aliases before the next non-root seam is explicit
- do not widen into package extraction
- do not start cross-repo consumer migration in the same slice as seam planning
- keep docs and generated inventories synchronized after each export-map change

## Best Starting Files For The Next Session

- `docs/SERVER_ROOT_ALLOWLIST_2026-04-23.md`
- `docs/SERVER_API_SURFACE_INDEX.md`
- `docs/ARCHITECTURE_REFACTOR_ROADMAP_2026-04-23.md`
- `docs/NEXT_SESSION_PROMPT_2026-04-23_server-runtime-control-plane-matrix.md`
- `config/server-api-tiers.json`
- `packages/server/src/index.ts`
- `packages/server/src/ops.ts`

## If You Need One Sentence

The unfinished high-value work is to choose and document the next explicit
server non-root seam for runtime/control-plane exports before any more root
pruning or unrelated compatibility widening happens.
