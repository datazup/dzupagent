# MC Split PR Readiness Review

Date: 2026-05-08
Repo: `dzupagent`
Branch: `main`
Comparison: `origin/main..HEAD`

## Current State

- `origin/main` points at `5490a3b`, the MC-047 through MC-057 split stack.
- `main` is ahead of `origin/main` with follow-on commits, including:
  - `d39d4e9 chore(github): build core before strict verify workflow`
  - `ab5b2fc docs(docs): add MC split PR readiness review report`
  - `019ad33 refactor(agent-adapters): split streaming handler into focused modules`
  - `86fa6fe test(packages): validate core consumer subpath exports`
  - `ae78416 refactor(core): split in-memory registry lifecycle`
  - `da38adb refactor(otel): split empty event metric map`
  - `411b7c4 test(testing): use explicit core subpath importers`
  - `c169bdd docs: refresh MC split readiness validation`
  - `c8c74e4 refactor(core): extract registry error helpers`
  - `e829bf7 docs: record committed MC follow-on slices`
- CI strict circular dependency sharding is already present in `.github/workflows/verify-strict.yml`.
- The full strict job runs `yarn -s verify:strict:no-circular`, so the expensive circular dependency scan is handled only by the separate 4-shard matrix job.
- Local worktree was clean after the follow-on commits above.

## MC Split Stack

1. `8ebf304 test(agent): prewarm timeout-sensitive imports`
2. `2db579c refactor(memory): MC-053 split skill-packs into focused modules`
3. `ae7d2ad refactor(memory): MC-047 split memory-service into focused modules`
4. `26854e2 refactor(agent): MC-054 split agent-templates into focused modules`
5. `b04955c refactor(memory): MC-048 split mcp-memory-server into focused modules`
6. `e0728b6 test(server): refresh workflow route boundaries`
7. `1654afd refactor(memory): MC-049 split memory-space-manager into focused modules`
8. `86e9e04 refactor(server): MC-056 split workflows routes into focused modules`
9. `2fc4042 refactor(core): MC-057 split a2a-sse-stream into focused modules`
10. `aca1606 refactor(agent-adapters): MC-050 split codex streamed thread into focused modules`
11. `e6e2713 refactor(agent-adapters): MC-051 split structured-output into focused modules`
12. `5490a3b refactor(agent-adapters): MC-052 split session-registry into focused modules`

## Package Grouping

### `packages/agent-adapters`

- MC-050 splits Codex streamed-thread behavior into approval, event, loop, and type helpers.
- MC-051 splits structured output into executor, parser, retry, and type helpers.
- MC-052 splits session registry behavior into core, provider, store, and type helpers.
- Supervisor orchestration helpers are also split into decomposition, executor, feedback, and type modules, with the boundary tracked by `config/architecture-boundaries.json`.

### `packages/memory`

- MC-047 splits memory service prompt/search/store/type behavior.
- MC-048 splits MCP memory server dispatcher/tool/type behavior.
- MC-049 splits memory-space lifecycle, retention, sharing, and type behavior.
- MC-053 splits skill-pack definitions, loader, and type behavior.

### `packages/agent`

- MC-054 splits agent template definitions by domain and refreshes timeout-sensitive tests.

### `packages/server`

- MC-056 splits workflow routes into handler, streaming, type, and validation helpers.
- Route-boundary tests were refreshed in the same stack.

### `packages/core`

- MC-057 splits A2A SSE stream behavior into client, parser, reconnect, and type helpers.

## Validation Evidence

Current-turn checks:

- `git diff --check`: passed.
- Duplicate subject check for the original MC split stack passed before follow-on commits were added.
- `yarn workspace @dzupagent/agent-adapters typecheck`: passed.
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/streaming-handler.test.ts`: passed, 22 tests.
- `yarn workspace @dzupagent/server build`: passed after the failed broad run, once `@dzupagent/core/identity` declarations were present in `packages/core/dist`.
- `yarn workspace @dzupagent/core typecheck`: passed.
- `yarn workspace @dzupagent/core test src/registry/__tests__/registry.test.ts src/__tests__/registry-idcounter.test.ts`: passed, 56 tests.
- `yarn workspace @dzupagent/core build`: passed.
- `yarn workspace @dzupagent/core lint`: passed.
- `yarn workspace @dzupagent/otel typecheck`: passed.
- `yarn workspace @dzupagent/otel test src/__tests__/event-metric-map-fragments.test.ts src/__tests__/event-metric-map-coverage.test.ts`: passed, 106 tests.
- `yarn workspace @dzupagent/otel build`: passed.
- `yarn workspace @dzupagent/otel lint`: passed.
- `yarn workspace @dzupagent/testing test src/__tests__/exports.test.ts`: passed, 16 tests.
- `yarn workspace @dzupagent/testing typecheck`: passed.
- `yarn workspace @dzupagent/testing build`: passed.
- `yarn workspace @dzupagent/testing lint`: passed.
- `yarn workspace @dzupagent/server test src/__tests__/cli-commands-smoke.test.ts src/__tests__/mcp-integration.test.ts src/__tests__/tool-resolver.test.ts`: passed, 125 tests.
- `yarn workspace @dzupagent/server test src/__tests__/cli-commands-smoke.test.ts src/__tests__/tool-resolver.test.ts`: passed, 93 tests.
- `yarn workspace @dzupagent/server typecheck`: passed.
- `yarn workspace @dzupagent/server lint`: passed.
- `node --test scripts/__tests__/check-package-export-artifacts.test.mjs`: passed.
- `yarn -s check:package-export-artifacts`: passed, 32 packages.
- `yarn build`: passed, 32 of 32 Turbo tasks successful after rebuilding `@dzupagent/core` declarations.
- `yarn -s verify:strict:no-circular`: passed after the export-artifact guard was wired into the command; 128 of 128 Turbo tasks successful, `@dzupagent/server#test` passed 195 files and 3,221 tests, and `package-export-artifacts` passed 32 packages.

Broad gate:

- Earlier `yarn -s verify:strict:no-circular` failed late in `@dzupagent/server#build` with TS7016 for `@dzupagent/core/identity`.
- The focused rerun of `@dzupagent/server build` passed without source changes, so that failure is consistent with stale/build-order DTS resolution rather than a server source defect.
- A package export artifact guard is now wired after `verify`, `verify:strict`, and `verify:strict:no-circular` so broad gates fail explicitly if a package export points at a missing runtime or declaration file such as `packages/core/dist/identity.d.ts`.
- A follow-up broad run exposed timing-sensitive server tests under full Turbo load; focused reruns passed and the smoke tests were hardened in `5569fa4`.
- Latest `yarn -s verify:strict:no-circular`: passed, 128 of 128 Turbo tasks successful.
- In the green broad run, `@dzupagent/server#test` passed 195 files and 3,221 tests, and the newly wired package-export artifact check passed 32 packages.

## Follow-On Work

The focused split of `packages/agent-adapters/src/streaming/streaming-handler.ts` is now committed as `019ad33`:

- `streaming-handler-types.ts`
- `streaming-event-mapper.ts`
- `streaming-progress.ts`
- `streaming-serialization.ts`
- reduced `streaming-handler.ts`

Focused validation for this split is green, but it is a follow-on commit after the MC split stack at `origin/main`.

Additional committed follow-on files:

- `packages/core/src/registry/in-memory-registry.ts`
- `packages/core/src/registry/in-memory-registry-core.ts`
- `packages/core/src/registry/in-memory-registry-errors.ts`
- `packages/otel/src/event-metric-map/empty-events.ts`
- `packages/otel/src/event-metric-map/empty-events-agent.ts`
- `packages/otel/src/event-metric-map/empty-events-runtime.ts`
- `packages/testing/src/__tests__/exports.test.ts`
- `packages/server/src/__tests__/cli-commands-smoke.test.ts`
- `packages/server/src/__tests__/mcp-integration.test.ts`
- `packages/server/src/__tests__/tool-resolver.test.ts`

Committed export-artifact stabilization guard:

- `scripts/check-package-export-artifacts.mjs`
- `scripts/__tests__/check-package-export-artifacts.test.mjs`
- `package.json` wires `check:package-export-artifacts` after broad verification gates.

These follow-on slices have package-focused validation, a green broad strict gate, and are committed locally.

## Plan Re-Evaluation

Implementation drift is low for the MC split stack at `origin/main`: it is mostly behavior-preserving module splitting with focused tests and strict-workflow sharding already in place.

The current drift risk is low. The stale-DTS and full-Turbo server timing failures were both rechecked, the focused reruns passed, and the latest strict gate is green with the package-export artifact guard included. The separate `apps/codev-app` worktree has unrelated local changes and should be reviewed separately before any cross-repo work. Remaining DzupAgent stabilization work should stay in guard/doc/test lanes unless a validation gate finds a concrete regression.

## Recommended Next Tasks

1. Treat the DzupAgent follow-on slices as ready for PR packaging; focused validation and the full strict gate are green.
2. Push/open the follow-on PR with the committed slices grouped by package.
3. Review the separate dirty `apps/codev-app` worktree before any cross-repo action.
4. Start another DzupAgent LOC split wave only after the PR package is sealed.
