# Next Session Prompt

Date: 2026-04-23

## Copy-Paste Prompt

Continue focused work in `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`.

Stay strictly on the architecture/contracts stabilization lane. Do not widen to
general repo cleanup, package extraction, or broad `server` implementation
refactors in this slice.

Current validated state:

- config-backed architecture policy is in place
- `@dzupagent/server` API tier inventory and generated surface report are in
  place and passing again
- `@dzupagent/adapter-types` and `@dzupagent/runtime-contracts` are split into
  seam-owned internal modules with public facades preserved
- persisted adapter run contract families have runtime-compatible golden
  fixtures and wrapper coverage
- the first server wire-surface compatibility pilot exists for
  `packages/server/src/routes/openai-compat`

Your next task is to prepare the first reduced `@dzupagent/server` root
allowlist and migration matrix from the current surface report.

Scope:

1. Use `docs/SERVER_API_SURFACE_INDEX.md` and `config/server-api-tiers.json` as
   the source of truth.
2. Draft the first reduced root allowlist from the current `stable` set.
3. Classify current direct root imports into:
   - keep on root
   - move to `@dzupagent/server/ops`
   - move to `@dzupagent/server/runtime`
4. Map current `secondary` direct imports to a migration path.
5. Keep this slice documentation-first and migration-plan-first. Do not change
   broad server exports yet unless a tiny supporting code adjustment is required
   for validation.

Concrete deliverables:

- updated roadmap with an explicit root allowlist proposal
- migration matrix for currently imported `secondary` root symbols
- recommendation for the first actual root-pruning tranche

Validation requirements:

- `node scripts/server-api-surface-report.mjs`
- `node scripts/server-api-surface-report.mjs --check`
- `yarn workspace @dzupagent/testing test src/__tests__/boundary/architecture.test.ts`
- if any `server` code is touched:
  - `yarn workspace @dzupagent/server typecheck`
  - run the narrowest relevant `@dzupagent/server` tests

Relevant files:

- `config/server-api-tiers.json`
- `docs/SERVER_API_SURFACE_INDEX.md`
- `docs/ARCHITECTURE_REFACTOR_ROADMAP_2026-04-23.md`
- `packages/server/src/index.ts`

Guardrails:

- keep scope narrow
- separate current-slice validation from unrelated background worktree noise
- do not revert unrelated pre-existing changes
- do not start broad root export pruning in the same pass unless the migration
  plan is explicit and locally validated

Definition of done:

- first reduced root allowlist is documented
- current root-import migration matrix is documented
- surface-report guardrail is green
- roadmap and continuation docs are updated with the next remaining slice
