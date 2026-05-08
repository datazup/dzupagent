# MC Split PR Readiness Review

Date: 2026-05-08
Repo: `dzupagent`
Branch: `main`
Comparison: `origin/main..HEAD`

## Current State

- Branch is ahead of `origin/main` by 12 commits.
- The committed stack has no duplicate commit subjects in `origin/main..HEAD`.
- CI strict circular dependency sharding is already present in `.github/workflows/verify-strict.yml`.
- The full strict job runs `yarn -s verify:strict:no-circular`, so the expensive circular dependency scan is handled only by the separate 4-shard matrix job.
- Local worktree is not clean: there is a focused, uncommitted `packages/agent-adapters/src/streaming/` split after the 12-commit stack.

## Committed Stack

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
- Duplicate subject check for `origin/main..HEAD`: passed, no output.
- `yarn workspace @dzupagent/agent-adapters typecheck`: passed.
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/streaming-handler.test.ts`: passed, 22 tests.

Previously reported but not rerun in this turn:

- `yarn -s verify:strict`: reported green before the commit-message-only rebase.

## Uncommitted Follow-On Work

The current worktree contains a focused split of `packages/agent-adapters/src/streaming/streaming-handler.ts`:

- `streaming-handler-types.ts`
- `streaming-event-mapper.ts`
- `streaming-progress.ts`
- `streaming-serialization.ts`
- reduced `streaming-handler.ts`

Focused validation for this uncommitted split is green, but it is not part of the 12-commit PR stack yet. Treat it as a separate decision:

- include it as the next narrow MC cleanup commit after review, or
- move it out of the PR-readiness path and open the existing 12-commit stack first.

## Plan Re-Evaluation

Implementation drift is low for the committed stack: it is mostly behavior-preserving module splitting with focused tests and strict-workflow sharding already in place.

The only current drift risk is scope ambiguity from the uncommitted streaming split. Do not present the branch as clean until that local delta is either committed, intentionally parked, or removed by the owner.

## Recommended Next Tasks

1. Decide whether the uncommitted streaming split belongs in this PR.
2. If included, commit it separately with a subject such as `refactor(agent-adapters): MC-058 split streaming handler into focused modules`.
3. Rerun `yarn workspace @dzupagent/agent-adapters typecheck` and `yarn workspace @dzupagent/agent-adapters test src/__tests__/streaming-handler.test.ts` after that commit.
4. Run `yarn -s verify:strict:no-circular` once before pushing if time permits; let CI confirm the circular dependency matrix.
5. Push/open PR only after the worktree status is intentionally clean or the PR description explicitly excludes local follow-on work.
