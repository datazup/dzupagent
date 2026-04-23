# Architecture Refactor Roadmap

Date: 2026-04-23

## Purpose

This roadmap turns the recent architecture assessment into a focused execution plan.
The immediate goal is to reduce drift between:

- declared package boundaries
- implementation dependency edges
- public contracts and wire shapes
- documentation and actual supported surfaces

The longer-term goal is to keep `dzupagent` feature-rich without letting that richness collapse package boundaries or contract discipline.

## Current Status

### Completed

- Added a machine-readable boundary policy at `config/architecture-boundaries.json`.
- Moved `packages/testing/src/__tests__/boundary/architecture.test.ts` to consume that config instead of hardcoded rule arrays.
- Added a machine-readable `@dzupagent/server` API tier inventory at `config/server-api-tiers.json`.
- Added a generated root-surface report at `docs/SERVER_API_SURFACE_INDEX.md`.
- Added `docs:server-api-surface` and `check:server-api-surface` scripts to keep the inventory aligned with `packages/server/src/index.ts`.
- Added a repo-grounded contract segmentation plan at `docs/CONTRACT_SEGMENTATION_PLAN_2026-04-23.md`.
- Implemented the first-pass internal source split for `@dzupagent/adapter-types` and `@dzupagent/runtime-contracts` while preserving public `index.ts` facades.

### In Progress

- Converting architecture policy from test-local convention into reusable repo configuration.
- Re-baselining the architecture refactor work around explicit drift classes and verifiable next steps.
- Converting `@dzupagent/server` surface review from narrative assessment into config-backed inventory and targeted validation.
- Expanding contract-correctness coverage after the internal source split in `@dzupagent/adapter-types` and `@dzupagent/runtime-contracts`.

### Not Started

- Runtime schema coverage for wire and persistence contracts.
- Backward-compatibility fixtures for external and persisted payloads.

## Drift Analysis

The main drift classes to control are:

1. Architecture-policy drift
- The repo previously kept boundary policy inside a single test file.
- Risk: policy weakens silently when a test is edited instead of when architecture is intentionally changed.
- Mitigation: keep boundary rules in `config/architecture-boundaries.json` and make tests load from it.

2. Contract-surface drift
- `@dzupagent/adapter-types` and `@dzupagent/runtime-contracts` both centralize many concepts in single entrypoints.
- Risk: unrelated changes widen shared contracts and make upgrades noisy.
- Mitigation: split internal modules by seam before splitting packages.

3. Feature-surface drift
- `@dzupagent/server` exposes a very broad mixed surface.
- Risk: optional feature planes become de facto stable public API.
- Mitigation: define stable, secondary, experimental, and internal exports before more features are added.

4. Wire-schema drift
- TypeScript types are stronger than runtime validation today.
- Risk: serialized payloads, route bodies, and event envelopes drift without compile-time protection.
- Mitigation: pair important TS contracts with runtime schemas and frozen fixtures.

5. Verification drift
- Broad `test` and `verify` coverage exists, but architecture and contract evolution steps are still partly convention-driven.
- Risk: “repo passes tests” is mistaken for “public interfaces remain coherent.”
- Mitigation: add targeted checks for API tiers, contract fixtures, and schema compatibility.

## Workstreams

### Workstream A: Architecture Policy

Status: `in_progress`

Goal:
- Make package and app dependency policy explicit, reviewable, and reusable.

Tasks:
- Keep `config/architecture-boundaries.json` as the source of truth.
- Extend the config later with:
  - allowed dependency directions
  - public API tiers
  - internal-only entrypoints
  - owner and rationale metadata

Verification:
- `yarn workspace @dzupagent/testing test src/__tests__/boundary/architecture.test.ts`

Exit criteria:
- Boundary policy is no longer duplicated in test code.
- Changes to architecture policy are diffable in a dedicated config file.

### Workstream B: Server Surface Reduction

Status: `in_progress`

Goal:
- Reduce drift pressure in `@dzupagent/server` by separating stable transport/runtime APIs from optional extensions.

Tasks:
- Inventory every export from `packages/server/src/index.ts`.
- Classify each export into:
  - `stable`
  - `secondary`
  - `experimental`
  - `internal`
- Propose subpath exports:
  - `@dzupagent/server`
  - `@dzupagent/server/ops`
  - `@dzupagent/server/extensions`
- Stop exporting persistence internals and feature-specific utilities through the root entrypoint unless explicitly intended.

Current findings:
- `packages/server/src/index.ts` currently exposes `124` unique export sources.
- Current tier split is:
  - `29` stable
  - `28` secondary
  - `49` experimental
  - `18` internal
- Root exposure recommendation is:
  - `29` keep in root
  - `77` candidate subpath exports
  - `18` root leaks to remove over time
- Real direct workspace root-import usage is narrow relative to the exposed surface:
  - `ServerRoutePlugin` appears in `7` files
  - `ForgeServerConfig` appears in `2` files
  - `createForgeApp` appears in `1` direct code file in the scanned workspace code
  - doctor and scorecard helpers appear in `1` CI-health script
  - direct root-import tier usage is:
    - `3` stable symbols
    - `9` secondary symbols
    - `0` experimental symbols
    - `0` internal symbols

Implication:
- The root package surface is much broader than current direct code consumption requires.
- The next cleanup should shrink the root surface around the stable set first rather than splitting packages immediately.
- There is a clean migration path because current direct workspace code is not depending on experimental or internal root exports.

Verification:
- Root export inventory reviewed against current consumers.
- Focused tests for stable root exports still pass.
- Optional planes remain reachable only through explicit imports.
- `node scripts/server-api-surface-report.mjs --check`

Exit criteria:
- Root `@dzupagent/server` surface is intentionally small and stable.
- Optional feature planes no longer widen the default consumer dependency graph.

### Workstream C: Contract Segmentation

Status: `in_progress`

Goal:
- Split contract modules by change frequency and responsibility while preserving current package names initially.

Tasks:
- Refactor `@dzupagent/adapter-types` into internal source modules:
  - `contracts/events`
  - `contracts/execution`
  - `contracts/routing`
  - `contracts/capabilities`
  - `contracts/config`
- Refactor `@dzupagent/runtime-contracts` into internal source modules:
  - `planning`
  - `execution`
  - `ledger`
  - `schedule`
- Keep top-level exports stable during the first pass.

Current findings:
- `packages/adapter-types/src/index.ts` currently exposes `38` exported type/interface declarations spanning provider identity, interaction policy, execution input, normalized events, routing, capability matrix, DzupAgent config/path contracts, and run-store/governance contracts.
- Actual consumer pressure is clustered rather than uniform:
  - `AdapterProviderId` is used by `adapter-rules` and `shared-kit/dzupagent-kit/adapter-monitor`
  - `AgentInput`, `AgentEvent`, `TaskDescriptor`, and `AgentCLIAdapter` are used by `agent`, `agent-adapters`, and `codegen`
  - `RawAgentEvent`, `AgentArtifactEvent`, and `RunSummary` are used by `agent-adapters` run persistence
  - `DzupAgentPaths` is used by the DzupAgent importer bridge
- `packages/runtime-contracts/src/index.ts` currently exposes `14` exported type/interface declarations spanning planning, execution, ledger, artifact, and schedule concepts.
- Current direct repo usage of `runtime-contracts` is narrower than the conceptual surface:
  - `packages/core/src/skills/skill-model-v2.ts` re-exports the planning/persona shapes for backward compatibility
  - current package tests only verify constructable shapes, not domain separation or serialized compatibility

First-pass module map:
- `@dzupagent/adapter-types`
  - `src/contracts/provider.ts`
  - `src/contracts/interaction.ts`
  - `src/contracts/execution.ts`
  - `src/contracts/events.ts`
  - `src/contracts/routing.ts`
  - `src/contracts/capabilities.ts`
  - `src/contracts/dzupagent.ts`
  - `src/contracts/run-store.ts`
  - `src/index.ts` remains a re-export facade
- `@dzupagent/runtime-contracts`
  - `src/planning.ts`
  - `src/execution.ts`
  - `src/ledger.ts`
  - `src/schedule.ts`
  - `src/index.ts` remains a re-export facade

Reference:
- See `docs/CONTRACT_SEGMENTATION_PLAN_2026-04-23.md` for move order, guardrails, and verification.
- Phase C1 status:
  - internal source modules are now in place for both packages
  - public `index.ts` facades were preserved
  - package-local tests/typechecks passed
  - focused consumer typechecks passed for `agent-adapters`, `agent`, `core`, and `codegen`
- Phase C2 status:
  - direct persisted-plane fixture coverage now exists for `RawAgentEvent`, `AgentArtifactEvent`, `GovernanceEvent`, and `RunSummary`
  - `runtime-contracts` tests are now separated by planning, execution, ledger, and schedule seams
  - focused validation remained green after the coverage reorganization

Verification:
- Existing package tests still pass.
- No consumer import path changes in the first refactor pass.
- Review contract ownership and usage before any package extraction.

Exit criteria:
- Internal module boundaries align with real change seams.
- Future package extraction can be done without speculative churn.

### Workstream D: Runtime Contract Correctness

Status: `in_progress`

Goal:
- Add runtime validation and fixture coverage to important wire and persistence contracts.

Priority surfaces:
- adapter lifecycle events
- OpenAI-compatible route payloads
- run, trace, eval, and benchmark records
- event gateway envelopes

Tasks:
- Add runtime schemas beside TS contracts.
- Add golden fixture tests for serialized payloads.
- Add compatibility tests for additive changes and union evolution.

Current findings:
- The first fixture tranche is now in place for the highest-pressure persisted adapter run contracts:
  `RawAgentEvent`, `AgentArtifactEvent`, `GovernanceEvent`, and `RunSummary`.
- The remaining drift is runtime-level compatibility, not structural organization.
- `runtime-contracts` test coverage is now seam-owned, which makes the next schema/fixture tranche narrower and easier to review.

Verification:
- Schema tests pass for valid fixtures.
- Invalid fixtures fail in expected ways.
- Compatibility fixtures cover at least one previous payload shape for each high-value surface.

Exit criteria:
- Important contracts are protected at compile time and runtime.

## Focused Task Queue

### Now

1. Keep architecture policy config-driven.
2. Keep `@dzupagent/server` export inventory and tiering config-backed.
3. Add runtime-compatibility enforcement for the persisted run contract family and the next highest-value wire surfaces.

Focused stabilization order for the next slice:
- first: persisted adapter run contracts
  - `RawAgentEvent`
  - `AgentArtifactEvent`
  - `RunSummary`
- second: live raw wrapper
  - `ProviderRawStreamEvent`
- third: only after the above is green, move to the pilot wire surface in
  `packages/server/src/routes/openai-compat`

### Next

1. Propose the first reduced root export allowlist for `@dzupagent/server` based on the current stable set.
2. Split current direct root imports into:
  - keep on root
  - move to `@dzupagent/server/ops`
  - move to `@dzupagent/server/runtime`
3. Identify every current workspace consumer touching `secondary`, `experimental`, or `internal` root exports and map migration paths.
4. Introduce runtime schemas for one pilot surface:
   `packages/server/src/routes/openai-compat`
5. Add contract fixtures for adapter event payloads.

Detailed next tasks:
- `server` root allowlist draft:
  - derive from current `stable` entries in `config/server-api-tiers.json`
  - review each `secondary` module with real usage before moving it
- `server` migration matrix:
  - `ServerRoutePlugin` stays on root
  - `ForgeServerConfig` stays on root
  - doctor/scorecard helpers become first candidates for `ops` subpath exports
- contract split design:
  - keep `src/index.ts` as a pure facade in both packages after future edits
  - keep direct fixture coverage green for:
    - `adapter-types`: `RawAgentEvent`, `AgentArtifactEvent`, `GovernanceEvent`, `RunSummary`
    - `runtime-contracts`: planning, execution, ledger, and schedule seams
  - confirm the known consumer clusters stay green after each coverage change:
    - `agent` provider execution port
    - `agent-adapters` normalization and run-store
    - `codegen` run engine
    - `core` skill-model re-exports
  - implement the first runtime-schema or golden-fixture tranche for persisted run contracts:
    `RawAgentEvent`, `AgentArtifactEvent`, and `RunSummary`
  - add one fixture for `ProviderRawStreamEvent` to protect the live raw-event wrapper alongside the persisted plane
  - only after persisted run contracts are covered, start the first `server` runtime-schema pilot in `routes/openai-compat`

### Later

1. Introduce subpath exports for `server`.
2. Consider package extraction only after internal seams prove stable.
3. Add consumer-facing compatibility gates for the highest-value external surfaces.

## Verification Ladder

Run these after each focused tranche instead of only relying on a full monorepo sweep:

1. Architecture policy
- `yarn workspace @dzupagent/testing test src/__tests__/boundary/architecture.test.ts`

2. Server surface inventory
- `node scripts/server-api-surface-report.mjs`
- `node scripts/server-api-surface-report.mjs --check`

3. Governance and package shape
- `yarn check:package-tiers`
- `yarn check:domain-boundaries`
- `yarn workspace @dzupagent/testing test src/__tests__/boundary/architecture.test.ts`

4. Contract-sensitive changes
- `yarn workspace @dzupagent/adapter-types typecheck`
- `yarn workspace @dzupagent/adapter-types test`
- `yarn workspace @dzupagent/runtime-contracts typecheck`
- `yarn workspace @dzupagent/runtime-contracts test`
- `yarn workspace @dzupagent/agent-adapters typecheck`
- `yarn workspace @dzupagent/agent typecheck`
- `yarn workspace @dzupagent/core typecheck`
- fixture/schema tests for changed interfaces

6. Session handoff
- use `docs/NEXT_SESSION_PROMPT_2026-04-23_contract-runtime-compat.md` as the default continuation prompt for the next focused tranche

5. Broader validation when public API changes
- `yarn verify`

## What Should Not Happen Next

- Do not split packages before internal seams are cleaned up.
- Do not widen `@dzupagent/server` root exports further until an API tier inventory exists.
- Do not rely on TS-only contracts for new wire formats.
- Do not add new architecture rules directly in tests when they belong in `config/`.
- Do not move `@dzupagent/server` exports blindly; use the generated inventory plus current-consumer evidence first.

## Success Criteria

This roadmap is working if:

- boundary policy changes are explicit and reviewable
- `@dzupagent/server` root-surface growth is visible and auditable
- package contracts get narrower rather than broader
- root public surfaces become smaller and more intentional
- verification speaks directly to drift-prone seams instead of only broad test counts
- feature growth stops forcing unrelated contract churn
