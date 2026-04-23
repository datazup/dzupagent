# Next Session Prompt

Date: 2026-04-23

## Copy-Paste Prompt

Continue focused work in `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`.

Stay strictly on the architecture/contracts stabilization lane. Do not widen to
general repo cleanup, package extraction, or broad `server` export pruning in
this slice.

Current validated state:

- config-backed architecture policy is in place
- `@dzupagent/server` API surface inventory and report are in place
- `@dzupagent/adapter-types` and `@dzupagent/runtime-contracts` are split into
  seam-owned internal modules with public facades preserved
- persisted adapter run contract families now have runtime-compatible golden
  fixture coverage for:
  - `RawAgentEvent`
  - `AgentArtifactEvent`
  - `RunSummary`
  - `ProviderRawStreamEvent`
- `runtime-contracts` tests are split by seam:
  - planning
  - execution
  - ledger
  - schedule

Your next task is to implement the first server wire-surface runtime
compatibility pilot in `packages/server/src/routes/openai-compat`.

Scope:

1. Add a narrow runtime-compatibility layer for the OpenAI-compatible request
   and/or response payloads in `packages/server/src/routes/openai-compat`.
2. Prefer golden-fixture validation if that is the least disruptive path in the
   current repo. Runtime schema validation is acceptable if it stays local and
   lightweight.
3. Keep the pilot local to `routes/openai-compat` and its tests.
4. Keep the persisted adapter run fixtures green; do not remove or weaken them.
5. Do not widen into root export restructuring or broader server package
   reorganization during the same pass.

Concrete deliverables:

- fixture files or schema-backed tests for the chosen OpenAI-compatible surface
- at least one backward-compatible payload example
- roadmap/docs updated to reflect the new status and remaining gap

Validation requirements:

- `yarn workspace @dzupagent/server test`
  If that is too broad or noisy, run the narrowest route-focused test command
  that proves the changed slice.
- `yarn workspace @dzupagent/server typecheck`
- `node scripts/server-api-surface-report.mjs --check`
- keep shared-contract verification green if those files are touched:
  - `yarn workspace @dzupagent/adapter-types test`
  - `yarn workspace @dzupagent/adapter-types typecheck`
  - `yarn workspace @dzupagent/agent-adapters typecheck`

Relevant files:

- `packages/server/src/routes/openai-compat/*`
- `packages/server/src/routes/openai-compat/__tests__/*`
- `docs/ARCHITECTURE_REFACTOR_ROADMAP_2026-04-23.md`
- `docs/CONTRACT_SEGMENTATION_PLAN_2026-04-23.md`

Guardrails:

- keep scope narrow
- separate current-slice verification from unrelated background worktree noise
- do not revert unrelated pre-existing changes
- prefer local compatibility checks over redesign

Definition of done:

- one OpenAI-compatible wire surface has runtime compatibility enforcement, not
  only route/unit constructability tests
- at least one backward-compatible payload example exists
- focused validation passes
- roadmap and continuation docs are updated with the next remaining slice
