# Contract Segmentation Plan

Date: 2026-04-23

## Purpose

This document turns the contract-surface drift assessment into a concrete,
repo-grounded refactor plan for:

- `@dzupagent/adapter-types`
- `@dzupagent/runtime-contracts`

The first pass is intentionally conservative:

- keep package names unchanged
- keep current top-level imports working
- split source by seam before introducing new public entrypoints
- verify high-value consumers after each move

## Status

Phase C1 structural split is complete:

- `@dzupagent/adapter-types` now uses `src/contracts/*` modules with
  `src/index.ts` preserved as the public facade
- `@dzupagent/runtime-contracts` now uses seam-owned source modules with
  `src/index.ts` preserved as the public facade
- package-local typecheck/test checks passed after the split
- focused consumer typechecks passed for `@dzupagent/agent-adapters`,
  `@dzupagent/agent`, `@dzupagent/core`, and `@dzupagent/codegen`

Phase C2 has started:

- `@dzupagent/adapter-types` now has direct persisted-plane fixture coverage for
  `RawAgentEvent`, `AgentArtifactEvent`, `GovernanceEvent`, and `RunSummary`
- `@dzupagent/runtime-contracts` tests are now separated by seam:
  planning, execution, ledger, and schedule
- focused validation remained green after both test-tranche changes
- persisted contract families now also have runtime-compatible golden payload
  coverage for:
  - minimal and rich `RawAgentEvent` fixtures
  - minimal and rich `AgentArtifactEvent` fixtures
  - minimal and rich `RunSummary` fixtures
  - `ProviderRawStreamEvent` fixture coverage for the live raw wrapper

## Current Findings

### `@dzupagent/adapter-types`

`packages/adapter-types/src/index.ts` currently exposes `38` exported
type/interface declarations across several different change domains:

1. Provider identity and interaction policy
2. Execution input, adapter interface, and normalized event plane
3. Routing contracts
4. Capability matrix contracts
5. DzupAgent config/path contracts
6. Raw-event and artifact persistence contracts
7. Governance side-channel contracts

This means one package entrypoint currently serves at least four different
consumer classes:

- provider/orchestrator consumers:
  `packages/agent/src/orchestration/provider-adapter/provider-execution-port.ts`
  uses `AgentInput`, `AgentEvent`, `TaskDescriptor`, and `AdapterProviderId`
- adapter/runtime consumers:
  `packages/agent-adapters/src/normalize.ts` uses `AdapterProviderId`,
  `AgentEvent`, and `TokenUsage`
- run-persistence consumers:
  `packages/agent-adapters/src/runs/run-event-store.ts` uses
  `RawAgentEvent`, `AgentArtifactEvent`, and `RunSummary`
- config/bridge consumers:
  `packages/agent-adapters/src/dzupagent/importer.ts` uses `DzupAgentPaths`
- low-level identity-only consumers:
  `packages/adapter-rules/*` and
  `shared-kit/dzupagent-kit/adapter-monitor/*` use `AdapterProviderId`

The dominant drift risk is coupling unrelated changes through one file and one
version boundary. For example, a change to raw run persistence shapes currently
shares the same contract surface as routing and capability-matrix types.

### `@dzupagent/runtime-contracts`

`packages/runtime-contracts/src/index.ts` currently exposes `14` exported
type/interface declarations, but they are not one neutral domain. They span:

1. planning/persona modeling
2. execution run records
3. prompt records
4. cost ledger entries
5. artifacts
6. workflow schedules

Current direct repo usage is much narrower than the published conceptual
surface:

- `packages/core/src/skills/skill-model-v2.ts` re-exports the planning/persona
  contracts for backward compatibility
- current package tests only assert that a few shapes are constructable

The dominant drift risk here is semantic ambiguity. The package is described as
"neutral runtime contracts" while part of the surface is planning and persona
domain modeling rather than runtime-only execution or ledger state.

## Proposed Internal Module Map

### `@dzupagent/adapter-types`

First-pass internal source layout:

- `src/contracts/provider.ts`
  - `AdapterProviderId`
- `src/contracts/interaction.ts`
  - `InteractionPolicyMode`
  - `InteractionPolicy`
- `src/contracts/execution.ts`
  - `AdapterCapabilityProfile`
  - `AgentInput`
  - `TokenUsage`
  - `HealthStatus`
  - `SessionInfo`
  - `EnvFilterConfig`
  - `AdapterConfig`
  - `AgentCLIAdapter`
- `src/contracts/events.ts`
  - `AgentEvent`
  - normalized event payload types
  - `AgentStreamEvent`
  - `ProviderRawStreamEvent`
- `src/contracts/routing.ts`
  - `TaskDescriptor`
  - `RoutingDecision`
  - `TaskRoutingStrategy`
- `src/contracts/capabilities.ts`
  - `CapabilityStatus`
  - `ProviderCapabilityRow`
  - `SkillCapabilityMatrix`
- `src/contracts/dzupagent.ts`
  - `CodexMemoryStrategy`
  - `DzupAgentConfig`
  - `DzupAgentPaths`
- `src/contracts/run-store.ts`
  - `RawAgentEvent`
  - `AgentArtifactEvent`
  - `GovernanceEventKind`
  - `GovernanceEvent`
  - `RunStatus`
  - `RunSummary`
- `src/index.ts`
  - re-export facade only

Seam rationale:

- `provider` and `interaction` change when adapter orchestration semantics
  change
- `execution` and `events` change with adapter runtime behavior
- `routing` changes with task-selection policy
- `capabilities` changes with skill/provider support reporting
- `dzupagent` changes with project bootstrap/import/config concerns
- `run-store` changes with persistence and replay tooling

Recommended move order:

1. extract `provider.ts`
2. extract `execution.ts`
3. extract `events.ts`
4. extract `routing.ts`
5. extract `capabilities.ts`
6. extract `dzupagent.ts`
7. extract `run-store.ts`
8. reduce `src/index.ts` to pure re-exports

Reason for the order:

- it isolates the most reused low-risk types first
- it leaves persistence/governance shapes until late, where change coupling is
  still higher
- it preserves current external imports throughout the pass

### `@dzupagent/runtime-contracts`

First-pass internal source layout:

- `src/planning.ts`
  - `PersonaRoleType`
  - `FeatureBrief`
  - `WorkItem`
  - `PersonaProfile`
- `src/execution.ts`
  - `ExecutionRunStatus`
  - `ExecutionRun`
  - `PromptType`
  - `PromptRecord`
- `src/ledger.ts`
  - `BudgetBucket`
  - `CostLedgerEntry`
  - `ArtifactType`
  - `Artifact`
- `src/schedule.ts`
  - `ScheduleType`
  - `WorkflowSchedule`
- `src/index.ts`
  - re-export facade only

Seam rationale:

- `planning` is a product/domain layer and should stop masquerading as generic
  execution state
- `execution` represents run lifecycle and prompt history
- `ledger` represents cost/accounting/artifact persistence
- `schedule` changes with orchestration cadence rather than execution records

Recommended move order:

1. extract `planning.ts`
2. extract `execution.ts`
3. extract `ledger.ts`
4. extract `schedule.ts`
5. reduce `src/index.ts` to pure re-exports

## Drift-Minimizing Guardrails

During the split, keep these rules explicit:

1. No public import-path changes in pass one.
2. No new exports are introduced just because files are being moved.
3. No runtime utilities are added to these packages during the structural pass.
4. Every moved symbol must live in exactly one seam-owned module.
5. If a symbol seems to belong to two seams, that is a design smell and should
   be resolved before the move.
6. `runtime-contracts` planning types remain re-exportable from
   `packages/core/src/skills/skill-model-v2.ts` until a separate deprecation
   plan exists.
7. `adapter-types` run-store and governance contracts should not be merged back
   into execution/event modules during convenience edits.

## Verification Plan

### Phase C1: module extraction without public changes

Required checks:

- `yarn workspace @dzupagent/adapter-types typecheck`
- `yarn workspace @dzupagent/adapter-types test`
- `yarn workspace @dzupagent/runtime-contracts typecheck`
- `yarn workspace @dzupagent/runtime-contracts test`

Consumer checks:

- `yarn workspace @dzupagent/agent-adapters typecheck`
- `yarn workspace @dzupagent/agent typecheck`
- `yarn workspace @dzupagent/codegen test --runInBand`
- `yarn workspace @dzupagent/core typecheck`

Expected outcome:

- no consumer import changes
- no contract symbol removals
- package-local tests remain green

### Phase C2: stronger contract-correctness coverage

After the structural split, add targeted coverage where drift pressure is
highest:

- adapter event fixture tests for normalized, raw, artifact, and governance
  planes
- runtime-contract fixtures separated by planning, execution, ledger, and
  schedule domains
- at least one serialized fixture per persisted/wire-facing contract family

Required checks:

- package-local tests
- any new fixture-validation command added in this phase
- focused consumer tests for `agent-adapters`, `codegen`, and `core`

## Immediate Next Tasks

1. Start the first wire-surface runtime-compatibility pilot in
   `packages/server/src/routes/openai-compat`.
2. Keep the persisted run contract fixtures green while the server pilot is
   introduced.
3. Revisit the `@dzupagent/server` root allowlist only after the OpenAI-compat
   pilot has local runtime validation or golden-fixture coverage.
4. If the OpenAI-compat pilot is stable, extend the same pattern to the next
   externally serialized server surface.

## Exit Criteria

This planning tranche is complete when:

- the module map is documented
- move order is fixed
- validation commands are fixed
- the next implementation tranche can be executed without re-deciding package
  boundaries
