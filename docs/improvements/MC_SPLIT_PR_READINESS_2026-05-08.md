# MC Split PR Readiness Review

Date: 2026-05-08
Repo: `dzupagent`
Branch: `main`
Comparison: `origin/main..HEAD`

## Current State

- `origin/main` points at `5490a3b`, the MC-047 through MC-057 split stack.
- `main` is ahead of `origin/main` by 4 follow-on commits:
  - `d39d4e9 chore(github): build core before strict verify workflow`
  - `ab5b2fc docs(docs): add MC split PR readiness review report`
  - `019ad33 refactor(agent-adapters): split streaming handler into focused modules`
  - `86fa6fe test(packages): validate core consumer subpath exports`
- CI strict circular dependency sharding is already present in `.github/workflows/verify-strict.yml`.
- The full strict job runs `yarn -s verify:strict:no-circular`, so the expensive circular dependency scan is handled only by the separate 4-shard matrix job.
- Local worktree is not clean. Remaining uncommitted source/test work is currently in `packages/core/src/registry/`, `packages/otel/src/event-metric-map/`, and `packages/testing/src/__tests__/exports.test.ts`.

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

Broad gate:

- `yarn -s verify:strict:no-circular`: failed late in `@dzupagent/server#build` with TS7016 for `@dzupagent/core/identity`.
- The focused rerun of `@dzupagent/server build` passed without source changes, so this failure is consistent with stale/build-order DTS resolution rather than a server source defect.

## Follow-On Work

The focused split of `packages/agent-adapters/src/streaming/streaming-handler.ts` is now committed as `019ad33`:

- `streaming-handler-types.ts`
- `streaming-event-mapper.ts`
- `streaming-progress.ts`
- `streaming-serialization.ts`
- reduced `streaming-handler.ts`

Focused validation for this split is green, but it is a follow-on commit after the MC split stack at `origin/main`.

Remaining dirty follow-on files currently present:

- `packages/core/src/registry/in-memory-registry.ts`
- `packages/core/src/registry/in-memory-registry-core.ts`
- `packages/otel/src/event-metric-map/empty-events.ts`
- `packages/otel/src/event-metric-map/empty-events-agent.ts`
- `packages/otel/src/event-metric-map/empty-events-runtime.ts`
- `packages/testing/src/__tests__/exports.test.ts`

These dirty follow-on slices have package-focused validation, but they are not committed yet.

## Plan Re-Evaluation

Implementation drift is low for the MC split stack at `origin/main`: it is mostly behavior-preserving module splitting with focused tests and strict-workflow sharding already in place.

The current drift risk is local commit/package grouping, not failed validation. The core registry split, OTel metric-map split, and testing export assertion change should be committed as separate follow-on slices or intentionally parked before presenting the checkout as PR-clean.

## Recommended Next Tasks

1. Commit the core registry split separately.
2. Commit the OTel metric-map split separately.
3. Commit or fold the testing export assertion and readiness-note refresh into the most relevant follow-on commit.
4. Rerun `yarn -s verify:strict:no-circular` after the worktree scope is settled; the focused server build already passed after the stale DTS failure.
5. Push/open the follow-on PR only after the worktree is intentionally clean.
