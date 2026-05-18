# Review Architecture

## Scope
This document describes the current implementation of `packages/codegen/src/review` in `@dzupagent/codegen`, based on local source and tests.

Primary files in scope:
- `src/review/review-rules.ts`
- `src/review/code-reviewer.ts`
- `src/review/index.ts`

Related package context used for this refresh:
- `src/index.ts` (root export surface)
- `src/__tests__/code-review.test.ts` (module behavior coverage)
- `package.json` and `README.md` in `packages/codegen`
- `docs/api-tiers.md` (current public-surface tiering)

## Responsibilities
The review subsystem provides deterministic, regex-based static checks over in-memory file content and unified diffs.

Current responsibilities:
- Define review rule contracts and built-in rule inventory.
- Scan file content (`Record<string, string>`) line-by-line and emit findings.
- Scan diff additions (`+` lines) with line mapping from unified diff hunk headers.
- Apply simple include/exclude file-path filtering.
- Apply minimum-severity filtering.
- Produce machine-readable summaries and markdown-formatted review output.

Explicit non-responsibilities in current code:
- AST-aware or semantic program analysis.
- File-system, git, network, or PR API operations.
- Automated code fixes or patch application.
- Runtime telemetry/log emission.

## Structure
`src/review` contains three modules:

1. `review-rules.ts`
- Declares `ReviewSeverity` as `critical | warning | suggestion`.
- Declares `ReviewCategory` as `security | bug | performance | style | best-practice`.
- Declares `ReviewRule` (`id`, `name`, `category`, `severity`, `pattern`, `description`, optional `suggestion`).
- Exposes `BUILTIN_RULES` with 17 regex rules:
- Security: `SEC-001` to `SEC-005`
- Bug: `BUG-001` to `BUG-004`
- Performance: `PERF-001` to `PERF-003`
- Style: `STY-001` to `STY-003`
- Best-practice: `BP-001` to `BP-002`

2. `code-reviewer.ts`
- Declares output types: `ReviewComment`, `ReviewSummary`, `ReviewResult`.
- Declares config input type: `CodeReviewConfig`.
- Implements helpers:
- `simpleGlobMatch` (`*` wildcard only)
- `matchesAny`
- `resolveRules`
- `shouldIncludeFile`
- `applyRulesToLines`
- `buildSummary`
- Implements public functions:
- `reviewFiles`
- `reviewDiff`
- `formatReviewAsMarkdown`

3. `index.ts`
- Local barrel for review types/constants/functions.

Package-level export wiring:
- `src/index.ts` re-exports review APIs directly from `review/*`.
- Root export aliases `ReviewComment` as `CodeReviewComment` to avoid naming collision with PR-review types in `src/pr`.

## Runtime and Control Flow
`reviewFiles(files, config?)` flow:
1. Resolve active rules from built-ins plus optional `customRules`, then remove any `disabledRules`.
2. Resolve severity threshold via `SEVERITY_ORDER` (`critical=0`, `warning=1`, `suggestion=2`).
3. Iterate each input file and apply include/exclude checks.
4. Split content by newline, assign 1-based line numbers, and evaluate each line against each active rule.
5. Emit `ReviewComment` entries for regex matches.
6. Sort comments by severity rank.
7. Build summary counts (`totalIssues`, severity totals, `categoryCounts`) and return `ReviewResult`.

`reviewDiff(filePath, diffContent, config?)` flow:
1. Apply include/exclude check to `filePath`.
2. Resolve rules and severity threshold with the same helpers as `reviewFiles`.
3. Parse diff line-by-line.
4. On hunk headers (`@@ -a,b +n,m`), set tracked target line to `n - 1`.
5. Skip `---` and `+++` header lines.
6. Evaluate only added lines (`+...`) against rules; removed lines are ignored.
7. Advance tracked line for context and added lines; keep mapped line numbers for findings.
8. Return `ReviewComment[]`.

`formatReviewAsMarkdown(result)` flow:
1. Return `"**Code Review:** No issues found."` when empty.
2. Render summary headline and severity totals.
3. Group comments by file (`Map<string, ReviewComment[]>`).
4. Sort each file group by line.
5. Render per-issue lines with severity tag (`[CRITICAL]`, `[WARNING]`, `[SUGGESTION]`), optional code snippet block, and optional suggestion.

## Key APIs and Types
Rule contracts (`review-rules.ts`):
- `type ReviewSeverity = 'critical' | 'warning' | 'suggestion'`
- `type ReviewCategory = 'security' | 'bug' | 'performance' | 'style' | 'best-practice'`
- `interface ReviewRule`
- `const BUILTIN_RULES: ReviewRule[]`

Review execution (`code-reviewer.ts`):
- `interface CodeReviewConfig`
- `interface ReviewComment`
- `interface ReviewSummary`
- `interface ReviewResult`
- `reviewFiles(files: Record<string, string>, config?: CodeReviewConfig): ReviewResult`
- `reviewDiff(filePath: string, diffContent: string, config?: CodeReviewConfig): ReviewComment[]`
- `formatReviewAsMarkdown(result: ReviewResult): string`

`CodeReviewConfig` fields:
- `customRules?: ReviewRule[]`
- `disabledRules?: string[]`
- `includePatterns?: string[]`
- `excludePatterns?: string[]`
- `minSeverity?: ReviewSeverity`

## Dependencies
Direct runtime dependencies inside `src/review/*`:
- No external package imports.
- Uses built-in JS/TS primitives (`RegExp`, arrays, objects, `Map`, `Set`).

Internal dependencies:
- `code-reviewer.ts` imports types and `BUILTIN_RULES` from `review-rules.ts`.
- `index.ts` re-exports both rule and reviewer surfaces.

Package context:
- `@dzupagent/codegen` depends on `@dzupagent/core` and `@dzupagent/adapter-types`, but the review module does not call either.
- Package peers (`@langchain/core`, `@langchain/langgraph`, `zod`, optional tree-sitter peers) are unrelated to `src/review` runtime code.

## Integration Points
Verified integrations in `packages/codegen`:
- Root facade exports from `src/index.ts`:
- `ReviewSeverity`, `ReviewCategory`, `ReviewRule`
- `BUILTIN_RULES`
- `CodeReviewComment` (alias), `ReviewSummary`, `ReviewResult`, `CodeReviewConfig`
- `reviewFiles`, `reviewDiff`, `formatReviewAsMarkdown`
- Tests in `src/__tests__/code-review.test.ts` import and exercise this module directly.

Adjacent subsystem boundary:
- `src/pr/review-handler.ts` is a separate review-consolidation utility using PR provider comments (`pr-manager` type), not `src/review/ReviewComment`.
- `pipeline` includes a `review` phase type contract, but no direct invocation of `reviewFiles` or `reviewDiff` is wired in the codegen runtime.

Public-surface status:
- `docs/api-tiers.md` currently places review exports under the experimental "PR lifecycle / CI / review" group.

## Testing and Observability
Current automated test coverage in `src/__tests__/code-review.test.ts`:
- Built-in rule invariants (category presence, unique IDs, minimum rule count).
- `reviewFiles` detections for security/bug/performance/best-practice/style patterns.
- Config behavior (`disabledRules`, `customRules`, `includePatterns`, `excludePatterns`, `minSeverity`).
- Summary consistency checks.
- `reviewDiff` behavior for added-line-only scanning, multi-hunk parsing, header skipping, and line mapping.
- Markdown formatting output from `formatReviewAsMarkdown`.

Current local validation run for this refresh:
- Command: `yarn workspace @dzupagent/codegen test src/__tests__/code-review.test.ts`
- Result: 1 file passed, 45 tests passed.

Observability characteristics:
- No built-in logger/metrics/tracing hooks in `src/review`.
- Operability is output-driven (`ReviewResult` and markdown text) and test-driven.

## Risks and TODOs
Current implementation risks:
- Regex-only checks can over-report or miss issues compared with AST/data-flow analysis.
- `simpleGlobMatch` supports only `*`, not full glob syntax (`**`, character classes, extglobs).
- `reviewDiff` assumes unified-diff hunk format; degraded accuracy on non-standard diff text.
- Line-by-line scanning limits multiline-pattern reliability (for example, loop + call patterns split across lines).
- `RegExp.test` is stateful for `g`/`y` patterns; custom rules using those flags could produce inconsistent matches across lines.

Practical TODOs inferred from current code shape:
- Add optional AST-backed rule evaluators for high-signal categories (security/bug).
- Replace or augment `simpleGlobMatch` with a full glob matcher if consumer needs expand.
- Define deterministic guidance for custom rule regex flags (`g`/`y`) to avoid stateful behavior surprises.
- Add optional structured telemetry hooks if review results are used in automated governance loops.
- Evaluate whether rule ordering and duplicate findings need stabilization guarantees for downstream automation.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js