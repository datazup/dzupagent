# Wave 19 — Implementation Tracking

> **Start date**: 2026-04-17  
> **Target**: ≥200 new tests, close 5 gaps  
> **Theme**: Observation Extractor + Frozen Snapshot + Session Search + GitHub Tools Expansion + Agent-Adapters Coverage

---

## Gap Assessment (pre-wave)

| Gap | Prior state | Wave 19 action |
|-----|------------|----------------|
| G-22 Observation extractor | 155 LOC impl in `@dzupagent/memory`, no dedicated tests | Write 50+ tests |
| G-30 Frozen snapshot | 106 LOC impl in `@dzupagent/memory`, no dedicated tests | Write 40+ tests |
| G-32 Session search (FTS) | Does not exist | Implement + 45+ tests |
| G-08 GitHub connector tools | 383 LOC impl, 4 test files (1665 LOC) — missing PR status checks, label tools, file review comments | Expand GitHub connector tools + 35+ tests |
| — Agent-adapters coverage | 111 test files, 1 failure in Claude/Codex/Gemini adapters | Fix failure + deep coverage of Claude/Codex/Gemini adapters |

---

## Task Summary

| ID | Task | Package | Gap | Target Tests | Agent | Status |
|----|------|---------|-----|-------------|-------|--------|
| W19-A1 | Observation extractor — 50+ tests | `memory` | G-22 | +50 | dzupagent-core-dev | DONE |
| W19-A2 | Frozen snapshot — 40+ tests | `memory` | G-30 | +40 | dzupagent-core-dev | DONE |
| W19-B1 | Session search FTS — implement + 45+ tests | `memory` | G-32 | +45 | dzupagent-core-dev | DONE |
| W19-B2 | GitHub connector: PR status, labels, file comments + 35+ tests | `connectors` | G-08 | +35 | dzupagent-connectors-dev | ✅ DONE |
| W19-B3 | Agent-adapters: fix failure + Claude/Codex/Gemini deep coverage + 40+ tests | `agent-adapters` | — | +40 | dzupagent-connectors-dev | ✅ DONE |

---

## Detailed Task Specs

### W19-A1: Observation Extractor — 50+ Tests (G-22)

**Goal**: `ObservationExtractor` in `packages/memory/src/observation-extractor.ts` (155 LOC)
exists but has zero dedicated tests. Write comprehensive test coverage.

**Current state**:
- `packages/memory/src/observation-extractor.ts` — 155 LOC, full implementation
- No test file exists for it. `observational-memory.test.ts` and `retrieval-observability.test.ts` are unrelated.

**Deliverables**:

1. `packages/memory/src/__tests__/observation-extractor.test.ts` — 50+ tests:
   - `shouldExtract()`: returns false below `minMessages`, false within debounce window, false when maxObservations reached, true otherwise
   - `extract()`: parses valid JSON array, handles malformed JSON (returns []), handles model throw (returns []), clamps confidence to [0,1]
   - category validation: filters out unknown categories
   - `count` getter: increments after successful extraction, not on empty/fail
   - `reset()`: resets lastExtractedAt and extractionCount to 0
   - debounce: two rapid extractions → second returns [] without calling model
   - maxObservations: stops extracting after limit reached
   - integration: mock model returns 5 observations → all parsed correctly
   - confidence: values outside [0,1] are clamped (e.g., 1.5 → 1.0, -0.2 → 0.0)
   - source field: always set to 'extracted'
   - createdAt: set to approximately Date.now()
   - multi-turn conversation formatting in prompt

**Acceptance criteria**:
- 50+ tests passing
- No existing memory tests broken

---

### W19-A2: Frozen Snapshot — 40+ Tests (G-30)

**Goal**: `FrozenMemorySnapshot` in `packages/memory/src/frozen-snapshot.ts` (106 LOC)
exists but has zero dedicated tests. Write comprehensive test coverage.

**Current state**:
- `packages/memory/src/frozen-snapshot.ts` — 106 LOC, full implementation
- No test file exists for it.

**Deliverables**:

1. `packages/memory/src/__tests__/frozen-snapshot.test.ts` — 40+ tests:
   - `freeze()`: calls `memoryService.get()` for each namespace, sets `isFrozen()` to true
   - `isFrozen()`: returns false before freeze, true after, false after unfreeze
   - `get()` while frozen: returns snapshot data (not calling service again)
   - `get()` while frozen with key filter: returns only matching records
   - `get()` while NOT frozen: delegates to memoryService
   - `put()` while frozen: buffers write, `pendingWrites` increments
   - `put()` while NOT frozen: calls memoryService.put immediately
   - `unfreeze()`: flushes all buffered writes in order, clears buffer, clears snapshots, sets isFrozen=false
   - `pendingWrites`: correctly tracks buffered count
   - multiple freeze/unfreeze cycles
   - `formatForPrompt()`: returns empty string if namespace not in snapshot, formats data via memoryService
   - freeze with empty namespace list: nothing frozen, writes go direct
   - concurrent buffered writes: all flushed in correct order

**Acceptance criteria**:
- 40+ tests passing
- No existing memory tests broken

---

### W19-B1: Session Search FTS — Implement + 45+ Tests (G-32)

**Goal**: Full-text search over conversation history does not exist. Implement a
`SessionSearch` class in `packages/memory/src/` and add 45+ tests.

**Current state**: Does not exist anywhere in the codebase.

**Deliverables**:

1. `packages/memory/src/session-search.ts` — implement `SessionSearch`:
   ```ts
   interface SearchQuery {
     text: string
     namespaces?: string[]
     limit?: number
     minScore?: number
   }
   interface SearchResult {
     key: string
     namespace: string
     scope: Record<string, string>
     value: Record<string, unknown>
     score: number // TF-IDF or simple relevance
     matchedTerms: string[]
   }
   class SessionSearch {
     constructor(store: MemoryService, config?: SessionSearchConfig)
     async search(query: SearchQuery): Promise<SearchResult[]>
     async index(namespace: string, scope: Record<string, string>): Promise<void>
     invalidate(namespace?: string): void
     get indexedCount(): number
   }
   ```
2. Export from `packages/memory/src/index.ts`
3. `packages/memory/src/__tests__/session-search.test.ts` — 45+ tests:
   - Basic search: finds records containing query term
   - Case-insensitive search
   - Multi-term search: AND semantics (all terms must match)
   - Namespace filter: restricts search to specified namespaces
   - limit: returns at most N results
   - minScore: filters out low-relevance results
   - `index()`: loads records from store into index
   - `invalidate()`: clears cached index (forces re-index on next search)
   - `indexedCount`: tracks how many records are indexed
   - Empty query: returns [] or throws
   - No matches: returns []
   - Score ordering: higher-relevance results come first
   - Special characters in query: sanitized safely
   - Re-search after invalidate: hits store again

**Acceptance criteria**:
- `SessionSearch` exported from `@dzupagent/memory`
- 45+ tests passing
- No existing memory tests broken

---

### W19-B2: GitHub Connector Tools Expansion + Tests (G-08)

**Goal**: The GitHub connector has 18 tools. Expand with: PR status checks, label management,
file-level review comments, and workflow run status. Add 35+ targeted tests covering gaps
in the existing 4 test files.

**Current state**:
- `packages/connectors/src/github/github-connector.ts` — 383 LOC, 18 tools
- `packages/connectors/src/github/github-client.ts` — existing client
- 4 test files totaling 1665 LOC — gap-analyze before writing

**Deliverables**:

1. Extend `github-client.ts` with missing API methods:
   - `getPRChecks(owner, repo, ref)` — get status checks for a commit/PR
   - `addLabel(owner, repo, issue_number, labels)` — add labels to issue/PR
   - `removeLabel(owner, repo, issue_number, label)` — remove a label
   - `createReviewComment(owner, repo, pr_number, body, path, line)` — file-level review comment
   - `getWorkflowRuns(owner, repo, workflow_id?)` — list CI workflow runs

2. Add 5 new tools to `github-connector.ts`:
   - `github_get_pr_checks` — get status checks for a PR
   - `github_add_labels` — add labels to an issue or PR
   - `github_remove_label` — remove a label from an issue or PR
   - `github_create_review_comment` — post a file-level review comment
   - `github_get_workflow_runs` — list CI workflow runs

3. `packages/connectors/src/__tests__/github-connector-w19.test.ts` — 35+ tests:
   - Gap-fill from existing test files (create_pr, merge_pr, list_pr_reviews edge cases)
   - New tools: each tool with success + error path
   - Rate limit handling for new tools
   - Auth failure for new tools
   - Tool name enumeration includes new tools
   - `filterTools` with new tool names

**Acceptance criteria**:
- 5 new tools added to GitHub connector
- 35+ new tests passing
- All 894 connector tests still pass

---

### W19-B3: Agent-Adapters — Fix Failure + Claude/Codex/Gemini Deep Coverage (—)

**Goal**: 1 test is currently failing in the 111-file agent-adapters test suite. Fix it
and add 40+ tests for Claude, Codex, and Gemini adapter-specific behavior.

**Current state**:
- `packages/agent-adapters/src/__tests__/` — 111 test files, 1913 passing, 1 failing
- Need to identify failing test and root-cause fix
- Claude/Codex/Gemini adapters likely have shallow coverage

**Deliverables**:

1. Run `yarn workspace @dzupagent/agent-adapters test 2>&1 | grep FAIL` to identify failing test
2. Fix the root cause (do NOT skip or remove the test)
3. `packages/agent-adapters/src/__tests__/claude-adapter-deep.test.ts` — 15+ tests:
   - Claude-specific `thinking` block handling
   - Claude `cacheControl` metadata in messages
   - Prompt caching behavior (cache_creation_input_tokens tracking)
   - Extended context with large system prompts
4. `packages/agent-adapters/src/__tests__/codex-adapter-deep.test.ts` — 15+ tests:
   - Codex thread management (create, continue, abandon)
   - Streaming output handling
   - Tool approval flow
   - Timeout handling
5. `packages/agent-adapters/src/__tests__/gemini-adapter-deep.test.ts` — 10+ tests:
   - Gemini-specific function calling format
   - Safety filter response handling
   - Multi-turn context management

**Acceptance criteria**:
- 0 test failures in agent-adapters
- 40+ new tests passing

---

## Progress

| ID | Status | Tests Added | Notes |
|----|--------|-------------|-------|
| W19-A1 | DONE | 63 | `__tests__/observation-extractor.test.ts` covers shouldExtract (minMessages, debounce, maxObservations cap), extract (JSON parsing, error handling, category validation, confidence clamping, metadata fields, count management, debounce side-effects), reset, multi-call debounce, prompt construction, integration. Mock model + `vi.useFakeTimers` for deterministic debounce tests. |
| W19-A2 | DONE | 50 | `__tests__/frozen-snapshot.test.ts` covers isFrozen toggling, freeze (calls memoryService.get per ns, resets writeBuffer, empty namespace list), get (frozen returns snapshot, key filter, delegates when ns missing or unfrozen), put (buffers when frozen, immediate when not), unfreeze (flushes in order, clears state), pendingWrites getter, multi-cycle freeze/unfreeze, formatForPrompt (empty string fallbacks), full session integration. |
| W19-B1 | DONE | 63 | Implemented `session-search.ts` (~135 LOC): `SessionSearch` class with token-presence scoring (matchedTerms/totalTerms), namespace filter, limit, minScore, invalidate, indexedCount. Exported from `index.ts`. Tests cover constructor + config, index, basic + multi-term + case-insensitive matching, empty/whitespace/single-char queries, namespace filter, limit, minScore (override per-query), score ordering, matchedTerms, no-match cases, key extraction (incl. coercion for non-string keys), text extraction (string-only fields), invalidate (single + all + unknown ns), indexedCount, multi-namespace integration, scope handling. |
| W19-B2 | DONE | 61 | `__tests__/github-connector-w19.test.ts` covers the 5 new tools (`github_get_pr_checks`, `github_add_labels`, `github_remove_label`, `github_create_review_comment`, `github_get_workflow_runs`) with success, error, auth-failure, 429 rate-limit, and URL-encoding cases; gap-fills existing `create_pr` / `merge_pr` / `list_pr_reviews` edge cases; full tool enumeration (22 total, 5 new); filterTools with new names; toolkit invariants. Extended `GitHubClient` with matching methods (`getPRChecks`, `addLabels`, `removeLabel`, `createReviewComment`, `getWorkflowRuns`). Updated `connectors.test.ts` baseline from 17 to 22 tools. All 955 connector tests pass. |
| W19-B3 | DONE | 80 | Fixed the unhandled-rejection leak in `ClaudeAgentAdapter.interrupt()` by installing a short-lived `process.once('unhandledRejection')` filter that swallows the SDK's "Claude Code process aborted by user" message (preserves real rejection semantics for anything else) and wrapping SDK `interrupt()` + `abort()` calls in try/catch. Also drains the stream in the conformance test's cleanup block. Added 3 deep test files: `claude-adapter-deep.test.ts` (23 tests — cache token propagation, mixed content blocks, stream-delta accumulation, large system prompts, failed subtypes, correlationId propagation, full conversation); `codex-adapter-deep.test.ts` (30 tests — thread lifecycle, item types, timeout handling, caller abort, sandbox mapping, cached usage, provider config preservation); `gemini-adapter-deep.test.ts` (27 tests — function-call/response variants, stream-delta payload shapes, CLI arg shaping, sandbox mappings, lifecycle, error handling). Full suite: 1994 passed / 0 failures / 0 unhandled rejections (up from 1914 with 1 unhandled rejection). |
| **Total** | — | **317 / ≥200** | All 5 tasks complete (3 memory + 2 connectors/agent-adapters). Target exceeded. |

---

## Wave 20 Candidates (preview)

- `G-31` Security sidecar — secrets scanning, PII detection for agent outputs
- `G-23` System reminder injector — context-window budget awareness
- `G-06` Git worktree manager — parallel agent isolation
- `G-34` Import validator — prevent circular deps and domain boundary violations
- Server package: Postgres run store + Drizzle schema (P3 from roadmap)
