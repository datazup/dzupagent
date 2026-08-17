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
| `codegen` | **claimed** | core-slice session (2026-08-17 PM) | next slice; 154 errors at claim time |
| `core` | free | — | 384 → 126 shipped (`8b7bbe0c`, `0f401bdb`, `337c31fa`); baseline ratcheted to 126. Remainder needs two contract reads: renamed `RunJournalEntryInput`, `ProtocolAdapter` mock shape |
| `connectors` | **in use** | other session (observed editing 2026-08-17 PM) | do not take without re-probing |
| `server` | free | — | 575 errors. `3969e4df` repaired a committed regression here; the `RunExecutor` contract note lives in `run-worker-types.ts` |
| `agent` | free | — | 198 errors |
| `evals` | free | — | 188 errors |
| `agent-adapters` | free | — | 166 errors |
| `memory` | free | — | 4 errors |

Packages at zero (do not regress): `adapter-rules`, `cache`,
`connectors-browser`, `create-dzupagent`, `dialogue-core-replay`, `express`,
`otel`, `scraper`, `test-utils`, `testing`.
