# Review Module Architecture

## Scope
This document describes the current implementation of `packages/codegen/src/review` in `@dzupagent/codegen`.

Covered files:
- `code-reviewer.ts`
- `review-rules.ts`
- `index.ts`

It also covers package-level exports, test coverage for this module, and practical integration boundaries inside `packages/codegen`.

## Responsibilities
The review module provides a lightweight, regex-driven static review pass over either full file content or unified diffs.

Primary responsibilities:
- Define review rule primitives and built-in rules (`ReviewRule`, `BUILTIN_RULES`).
- Scan file content maps (`Record<string, string>`) and emit structured findings.
- Scan diff additions (`+` lines) with hunk-aware line number tracking.
- Apply file-path include/exclude filters and severity threshold filtering.
- Summarize findings by severity and category.
- Format findings into markdown for human review surfaces.

Non-responsibilities:
- AST-aware semantic analysis.
- Repo I/O, git operations, or PR API calls.
- Automatic fixing/remediation.

## Structure
`src/review` is intentionally small (3 files):

- `review-rules.ts`
- Defines `ReviewSeverity` (`critical | warning | suggestion`).
- Defines `ReviewCategory` (`security | bug | performance | style | best-practice`).
- Defines `ReviewRule` contract (`id`, `name`, `category`, `severity`, `pattern`, `description`, optional `suggestion`).
- Exposes `BUILTIN_RULES` (17 regex rules across 5 categories).

- `code-reviewer.ts`
- Defines output types: `ReviewComment`, `ReviewSummary`, `ReviewResult`.
- Defines input config: `CodeReviewConfig`.
- Implements `reviewFiles`, `reviewDiff`, and `formatReviewAsMarkdown`.
- Contains internal helpers for rule resolution, simple glob filtering, rule application, and summary building.

- `index.ts`
- Local barrel that re-exports module types/constants/functions.

Package export surface:
- `packages/codegen/src/index.ts` re-exports this module under the package root API (`@dzupagent/codegen`).

## Runtime and Control Flow
`reviewFiles(files, config?)`:
1. Resolve active rules via `BUILTIN_RULES + customRules - disabledRules`.
2. Resolve minimum severity using internal numeric ranking (`critical=0`, `warning=1`, `suggestion=2`).
3. For each file entry:
4. Apply include/exclude pattern checks (simple `*` wildcard matching).
5. Split content into lines and generate 1-based line numbers.
6. For each line, test every active rule regex.
7. Emit `ReviewComment` for each match.
8. Sort all comments by severity.
9. Build `ReviewSummary` and return `{ comments, summary }`.

`reviewDiff(filePath, diffContent, config?)`:
1. Apply include/exclude checks for the target path.
2. Resolve active rules and minimum severity.
3. Parse unified diff text line-by-line.
4. Track target-file line counter from hunk headers (`@@ -x,y +n,m @@`).
5. Scan only added lines (`+...`), ignoring file headers (`---`, `+++`) and removed lines (`-...`).
6. Reuse the same line-level rule matcher as `reviewFiles`.
7. Return `ReviewComment[]`.

`formatReviewAsMarkdown(result)`:
1. Return a fixed "no issues" message for empty results.
2. Render summary counts.
3. Group findings by file.
4. Sort findings by line within each file group.
5. Render rule id, severity token, line number, snippet, and suggestion.

## Key APIs and Types
Core types:
- `ReviewRule`
- `ReviewSeverity`
- `ReviewCategory`
- `CodeReviewConfig`
- `ReviewComment`
- `ReviewSummary`
- `ReviewResult`

Core constants/functions:
- `BUILTIN_RULES`
- `reviewFiles(files: Record<string, string>, config?: CodeReviewConfig): ReviewResult`
- `reviewDiff(filePath: string, diffContent: string, config?: CodeReviewConfig): ReviewComment[]`
- `formatReviewAsMarkdown(result: ReviewResult): string`

`CodeReviewConfig` fields:
- `customRules?: ReviewRule[]`
- `disabledRules?: string[]`
- `includePatterns?: string[]`
- `excludePatterns?: string[]`
- `minSeverity?: ReviewSeverity`

Built-in rule inventory (current):
- Security: `SEC-001..SEC-005`
- Bug: `BUG-001..BUG-004`
- Performance: `PERF-001..PERF-003`
- Style: `STY-001..STY-003`
- Best-practice: `BP-001..BP-002`

## Dependencies
Runtime external dependencies:
- None in `src/review/*` (pure TypeScript + built-in `RegExp`, `Map`, arrays).

Internal package dependencies:
- `code-reviewer.ts` imports `BUILTIN_RULES` and rule types from `review-rules.ts`.
- `index.ts` re-exports from both local files.

Package-level context:
- `@dzupagent/codegen` depends on `@dzupagent/core` and `@dzupagent/adapter-types`, but this review module does not directly use those dependencies.

## Integration Points
Current verified integration points in `packages/codegen`:
- Package API export via `src/index.ts` (root-level consumer entrypoint).
- Unit tests via `src/__tests__/code-review.test.ts`.

Observed boundaries:
- No other runtime module in `packages/codegen/src/*` imports `src/review/*` directly besides exports/tests.
- `GenPipelineBuilder` supports a generic `review` phase type, but it is a configuration concept and does not invoke `reviewFiles`/`reviewDiff` directly.
- PR lifecycle utilities in `src/pr/*` are separate from this module (different `ReviewComment` type and purpose).

## Testing and Observability
Automated tests:
- `src/__tests__/code-review.test.ts` validates:
- rule coverage/category/id integrity
- `reviewFiles` behavior for detections, sorting, filtering, summaries, and custom rules
- `reviewDiff` behavior for hunk parsing, added-line-only scanning, and line-number mapping
- markdown output formatting

Focused local validation (current run):
- `yarn workspace @dzupagent/codegen test src/__tests__/code-review.test.ts`
- Result: 1 test file passed, 45 tests passed.

Coverage/quality harness:
- Package `vitest.config.ts` includes coverage thresholds and includes `src/**/*.ts` (excluding test/spec/index files).

Observability:
- No dedicated runtime logging, metrics, tracing, or counters inside `src/review/*`.
- Observability is currently test-driven and consumer-driven (via returned `ReviewResult`/`ReviewSummary`).

## Risks and TODOs
Current risks from implementation shape:
- Regex-only matching can produce false positives/false negatives versus AST-aware analysis.
- `simpleGlobMatch` supports only `*` wildcard semantics; it is not full minimatch/glob syntax.
- Diff parsing expects unified diff hunk headers; non-standard diff formats may degrade line mapping.
- Rules run per-line; multi-line code patterns are only partially supported (via regex tricks, not true structural parsing).

Practical TODO candidates (not yet implemented in this module):
- Consider optional AST-backed rule engines for higher-precision checks.
- Expand path-matching semantics if consumers need full glob compatibility.
- Add rule-level telemetry hooks if this module becomes part of larger automated review pipelines.
- Document versioned rule policy strategy if downstream systems depend on stable rule IDs/severities.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

