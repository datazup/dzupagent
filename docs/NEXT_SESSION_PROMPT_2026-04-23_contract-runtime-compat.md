# Next Session Prompt

Date: 2026-04-23

## Copy-Paste Prompt

Continue focused work in `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`.

Stay strictly on the architecture/contracts stabilization lane. Do not widen to
general repo cleanup, package extraction, or broad `server` export changes yet.

Current validated state:

- config-backed architecture policy is in place
- `@dzupagent/server` API surface inventory and report are in place
- `@dzupagent/adapter-types` has been split into seam-owned internal modules
- `@dzupagent/runtime-contracts` has been split into seam-owned internal modules
- persisted-plane fixture coverage now exists for:
  - `RawAgentEvent`
  - `AgentArtifactEvent`
  - `GovernanceEvent`
  - `RunSummary`
- `runtime-contracts` tests are now split by seam:
  - planning
  - execution
  - ledger
  - schedule

Your next task is to implement the first runtime-compatibility tranche for the
persisted adapter run contract family.

Scope:

1. Add a narrow runtime-compatibility layer for:
   - `RawAgentEvent`
   - `AgentArtifactEvent`
   - `RunSummary`
2. Prefer golden-fixture validation if that is the least disruptive path in the
   current repo. Runtime schema validation is also acceptable if it stays local
   and lightweight.
3. Add one explicit fixture for `ProviderRawStreamEvent` so the live raw wrapper
   is protected alongside the persisted raw-event plane.
4. Keep `src/index.ts` facades unchanged.
5. Do not change public import paths.
6. Do not widen into `packages/server` runtime-schema work unless the persisted
   adapter contract tranche is complete and validated first.

Concrete deliverables:

- fixture files or schema-backed tests for persisted run contracts
- at least one backward-compatibility payload example per persisted contract
  family
- roadmap/docs updated to reflect the new status and remaining gap

Validation requirements:

- `yarn workspace @dzupagent/adapter-types test`
- `yarn workspace @dzupagent/adapter-types typecheck`
- `yarn workspace @dzupagent/agent-adapters typecheck`
- if `runtime-contracts` files or shared docs are touched:
  - `yarn workspace @dzupagent/runtime-contracts test`
  - `yarn workspace @dzupagent/runtime-contracts typecheck`
  - `yarn workspace @dzupagent/core typecheck`

Relevant files:

- `packages/adapter-types/src/contracts/run-store.ts`
- `packages/adapter-types/src/contracts/events.ts`
- `packages/adapter-types/src/__tests__/adapter-run-store-contracts.test.ts`
- `docs/ARCHITECTURE_REFACTOR_ROADMAP_2026-04-23.md`
- `docs/CONTRACT_SEGMENTATION_PLAN_2026-04-23.md`

Guardrails:

- keep scope narrow
- separate current-slice verification from unrelated background worktree noise
- do not revert unrelated pre-existing changes
- prefer fixture/golden compatibility checks over speculative redesign

Definition of done:

- persisted run contract family has runtime-compatibility enforcement, not only
  constructability tests
- `ProviderRawStreamEvent` is covered
- focused validation passes
- roadmap and continuation docs are updated with the next remaining slice
