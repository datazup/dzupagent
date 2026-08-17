# Slice claims — concurrent sessions

Multiple agent sessions work this repo at the same time. Occupancy in the
test-typecheck debt program (GAP-2) is **per-package**, not per-lane, so this
file exists to make ownership visible before the first edit rather than
discovering it through a merge.

## How to use

1. Before your first edit, add or update your package's row and **commit this
   file by itself**. That commit is the claim.
2. Work only in the packages you have claimed.
3. Release by setting Status to `free` (or deleting the row) when you finish.
4. A claim older than a few hours with no commits touching that package is
   stale — verify with
   `git log -8 --name-only --format=%h | grep -oE '^packages/[^/]+' | sort -u`
   before taking it.

This file is advisory. It does not replace the liveness probe:

```bash
S1=$(git status --porcelain | md5sum); H1=$(git rev-parse HEAD); sleep 75
S2=$(git status --porcelain | md5sum); H2=$(git rev-parse HEAD)
[ "$S1" = "$S2" ] && [ "$H1" = "$H2" ] && echo QUIESCENT || echo SIBLING-LIVE
```

## Current claims

| Package | Status | Claimed by | Note |
|---|---|---|---|
| `codegen` | **in use** | other session (took it 2026-08-17 16:50, `e015b741`) | claim released — the other session entered first; do not take without re-probing |
| `core` | free | — | 384 → 126 shipped (`8b7bbe0c`, `0f401bdb`, `337c31fa`); baseline ratcheted to 126. Remainder needs two contract reads: renamed `RunJournalEntryInput`, `ProtocolAdapter` mock shape |
| `connectors` | **free — at ZERO** | closed 2026-08-17 17:05 (`594e8ac5`) | 85 -> 0, baseline entry removed. Suite 67 files / 2587 tests exit 0, `yarn tsc --noEmit` on src exit 0. Three were contract/production issues, not test defects: `textToBlocks` declared `SlackBlock[]` while every path returns `SlackSectionBlock`; the BigQuery `createQueryJob` fake declared `{query}` while the adapter passes four fields; `Priv` in `sql-adapters-deep` declared 3 of the members it pokes, leaving 25 calls typed `unknown`. Do not regress. |
| `server` | **claimed** | server-slice session (2026-08-17 17:15) | 664 errors, the largest remaining slice. Verified free before claiming: zero dirty paths under `packages/server/`, nothing under `packages/server/src` touched in 20 minutes, last server commit `90823517` at 16:47:49. The `RunExecutor` dead-arm note in `run-worker-types.ts` was landed by that commit, so the contract question it raised is resolved. |
| `agent` | free | — | **CLOSED at zero** (198 -> 0). Baseline ratcheted to 0; suite 359 files / 7544 tests green |
| `evals` | free | — | 188 errors |
| `agent-adapters` | **claimed** | agent-adapters-remainder session (2026-08-17 PM) | 125 errors re-derived at claim time (after `0ac23153`); driving to 0 |
| `memory` | **claimed** | connectors session, after closing connectors (2026-08-17 17:10) | 4 structural errors. The previous owner left them deliberately: 3x TS6059 (a deep import that drags `agent-types` under memory's rootDir — fix belongs in agent-types) and 1x TS2307 (`../../tsup.config`, outside flipcheck's `include`). Both fixes sit outside a tests-only slice, which is why they were deferred; taking them now that the repo is quiescent. `tsconfig.flipcheck.json` is per-package, so editing memory's own copy changes no sibling's measurement. |

Packages at zero (do not regress): `adapter-rules`, `cache`,
`connectors-browser`, `create-dzupagent`, `dialogue-core-replay`, `express`,
`otel`, `scraper`, `test-utils`, `testing`.
