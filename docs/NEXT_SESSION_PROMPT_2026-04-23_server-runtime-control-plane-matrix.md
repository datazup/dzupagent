# Next Session Prompt

Date: 2026-04-23

## Copy-Paste Prompt

Continue focused work in `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`.

Stay strictly on the architecture/contracts stabilization lane. Do not widen to
general repo cleanup, package extraction, or broad `server` refactors in this
slice.

Current validated state:

- config-backed architecture policy is in place
- `@dzupagent/server` API tier inventory and generated surface report are green
- a phase-1 root allowlist and migration matrix exist in
  `docs/SERVER_ROOT_ALLOWLIST_2026-04-23.md`
- `@dzupagent/server/ops` now exists as an explicit non-root home for doctor
  and scorecard helpers, while root exports remain compatible
- `@dzupagent/adapter-types` and `@dzupagent/runtime-contracts` are split into
  seam-owned internal modules with public facades preserved
- persisted adapter run contract families have runtime-compatible golden
  fixtures and wrapper coverage
- the first server wire-surface compatibility pilot exists for
  `packages/server/src/routes/openai-compat`

Your next task is to document and prepare the next explicit non-root server
seam for the runtime/control-plane surface.

Scope:

1. Use `docs/SERVER_ROOT_ALLOWLIST_2026-04-23.md`,
   `docs/SERVER_API_SURFACE_INDEX.md`, and `config/server-api-tiers.json` as the
   source of truth.
2. Build a migration matrix for:
   - `./runtime/*` secondary exports
   - `./services/agent-control-plane-service.js`
   - `./services/executable-agent-resolver.js`
3. Decide whether these belong under:
   - `@dzupagent/server/runtime`
   - `@dzupagent/server/control-plane`
   - or a split between the two
4. Keep this slice plan-first unless one tiny supporting export-map adjustment
   is clearly justified and locally validated.
5. Do not remove root aliases in this pass.
6. Do not widen into cross-repo consumer migration in this pass.

Concrete deliverables:

- runtime/control-plane migration matrix
- recommendation for the next implemented subpath tranche
- roadmap/status update reflecting the new highest-value drift
- updated continuation prompt for the next implementation pass

Validation requirements:

- `node scripts/server-api-surface-report.mjs`
- `node scripts/server-api-surface-report.mjs --check`
- `yarn workspace @dzupagent/server typecheck`
- if `packages/server` exports change:
  - `yarn workspace @dzupagent/server build`
  - run the narrowest relevant `@dzupagent/server` tests for the changed seam

Relevant files:

- `docs/SERVER_ROOT_ALLOWLIST_2026-04-23.md`
- `docs/SERVER_API_SURFACE_INDEX.md`
- `docs/ARCHITECTURE_REFACTOR_ROADMAP_2026-04-23.md`
- `config/server-api-tiers.json`
- `packages/server/src/index.ts`
- `packages/server/src/ops.ts`
- `packages/server/package.json`

Guardrails:

- keep scope narrow
- separate current-slice validation from unrelated background worktree noise
- do not revert unrelated pre-existing changes
- do not start root alias removal before the next non-root seam is explicit
- do not widen runtime/control-plane work into generic runtime redesign

Definition of done:

- runtime/control-plane migration matrix is documented
- the next explicit non-root server seam is chosen
- surface-report guardrail is green
- roadmap and continuation docs are updated with the next remaining slice
