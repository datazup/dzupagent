# Code Review Module Architecture

## Scope

This document describes the architecture and behavior of `packages/codegen/src/review`:

- `review-rules.ts`
- `code-reviewer.ts`
- `index.ts`

It also includes usage patterns, integration references, and current test/coverage status.

## Purpose

The module provides a lightweight, regex-based static review engine for code and unified diffs.

Primary outputs:

- Structured issues (`ReviewComment[]`)
- Aggregated counts (`ReviewSummary`)
- Human-readable markdown (`formatReviewAsMarkdown`)

Primary design characteristics:

- Zero external runtime dependencies
- Stateless pure functions
- Fast line-by-line scanning
- Configurable rule set (built-in + custom)

## File-Level Architecture

### `review-rules.ts`

Defines the rule model and ships built-in rules.

- `ReviewSeverity`: `'critical' | 'warning' | 'suggestion'`
- `ReviewCategory`: `'security' | 'bug' | 'performance' | 'style' | 'best-practice'`
- `ReviewRule` interface (id, category, severity, regex pattern, description, optional suggestion)
- `BUILTIN_RULES`: 17 regex rules across 5 categories

### `code-reviewer.ts`

Implements scanning, filtering, severity thresholding, summarization, and markdown formatting.

Public API:

- `reviewFiles(files, config?) => ReviewResult`
- `reviewDiff(filePath, diffContent, config?) => ReviewComment[]`
- `formatReviewAsMarkdown(result) => string`

Key internal helpers:

- `simpleGlobMatch` and `matchesAny` for include/exclude filtering
- `resolveRules` for built-in/custom rule composition + disable list
- `applyRulesToLines` for core regex matching
- `buildSummary` for aggregate counts

### `index.ts`

Local barrel export for this folder:

- Re-exports all public types from `review-rules.ts` and `code-reviewer.ts`
- Re-exports `BUILTIN_RULES`, `reviewFiles`, `reviewDiff`, `formatReviewAsMarkdown`

## Feature Set

### 1) Built-In Rule Packs

Rule families and IDs:

- Security: `SEC-001..005`
- Bug: `BUG-001..004`
- Performance: `PERF-001..003`
- Style: `STY-001..003`
- Best practice: `BP-001..002`

Highlights:

- Critical checks for `eval`, hardcoded secrets, SQL template interpolation
- Warning checks for `innerHTML`, empty `catch`, deep nesting, `any` usage
- Suggestion checks for `console.log`, TODO markers, long lines, missing explicit return types

### 2) Configurable Policy

`CodeReviewConfig` supports:

- `customRules`: add project-specific patterns
- `disabledRules`: disable by rule ID (works for built-in and custom)
- `includePatterns`: allow-list files by simple glob pattern
- `excludePatterns`: block-list files by simple glob pattern
- `minSeverity`: threshold (`critical` only, `warning+critical`, or all)

### 3) File-Content Scanning (`reviewFiles`)

- Input is `Record<string, string>` (path -> full file content)
- Splits each file by newline
- Applies all active rules to every line
- Emits one comment per matching rule per line
- Sorts final comments by severity order: critical -> warning -> suggestion
- Builds global summary and category counts

### 4) Diff-Only Scanning (`reviewDiff`)

- Parses unified diff hunks (`@@ -old +new @@`)
- Only scans added lines (`+`)
- Tracks line numbers relative to target file using hunk headers
- Ignores diff filename headers (`---`, `+++`)
- Applies same rule and severity filtering as `reviewFiles`

### 5) Markdown Reporting

`formatReviewAsMarkdown`:

- Returns short "no issues" message for empty result
- Adds top-level summary counts
- Groups comments by file
- Sorts comments by line inside each file
- Includes:
  - severity token (`[CRITICAL]`, `[WARNING]`, `[SUGGESTION]`)
  - rule ID
  - message
  - offending code snippet (if present)
  - suggestion blockquote (if present)

## Processing Flow

### A) `reviewFiles` Flow

1. Resolve active rules: `BUILTIN_RULES + customRules - disabledRules`.
2. Resolve severity threshold numeric level.
3. For each `(filePath, content)`:
4. Apply include/exclude pattern checks.
5. Split into lines, generate line numbers.
6. Match every active rule against every line.
7. Collect comments with metadata.
8. Sort all comments by severity.
9. Build summary counts and return result.

### B) `reviewDiff` Flow

1. Apply include/exclude for the file path.
2. Resolve rules and severity threshold.
3. Parse diff line-by-line:
4. On hunk header, initialize `currentLine` from `+<startLine>`.
5. On `+` lines, increment line counter and collect text for scanning.
6. On context lines, increment line counter.
7. On removed lines (`-`), do not increment target line counter.
8. Apply rules to collected added lines and return comments.

### C) `formatReviewAsMarkdown` Flow

1. If no comments, return "No issues found".
2. Render summary line and severity count line.
3. Group comments by file.
4. Sort per-file comments by line.
5. Render markdown bullets, snippets, and suggestions.

## Usage Examples

### 1) Full-file review

```ts
import { reviewFiles, formatReviewAsMarkdown } from '@dzupagent/codegen'

const files = {
  'src/handler.ts': `
const password = "hardcoded"
const result = eval(input)
console.log('debug')
`,
}

const result = reviewFiles(files, {
  minSeverity: 'warning',
  excludePatterns: ['vendor/*'],
})

console.log(result.summary)
console.log(formatReviewAsMarkdown(result))
```

### 2) Diff review in PR automation

```ts
import { reviewDiff } from '@dzupagent/codegen'

const diff = `@@ -1,2 +1,3 @@
+const result = eval(input)
+console.log('debug')`

const comments = reviewDiff('src/handler.ts', diff, {
  minSeverity: 'critical',
})
```

### 3) Project custom policy

```ts
import { reviewFiles, type CodeReviewConfig } from '@dzupagent/codegen'

const config: CodeReviewConfig = {
  disabledRules: ['BUG-003'], // allow console.log in this project
  customRules: [
    {
      id: 'CUSTOM-001',
      name: 'no-sleep',
      category: 'performance',
      severity: 'warning',
      pattern: /\bsleep\s*\(/,
      description: 'Avoid sleep() in production code.',
      suggestion: 'Use event-driven wait mechanisms.',
    },
  ],
}

const result = reviewFiles({ 'src/job.ts': 'await sleep(5000)' }, config)
```

## Use Cases

Typical high-value scenarios:

- Review generated code before writing to disk
- CI gate for critical or warning findings
- Diff-focused PR checks to reduce noise
- Automated reviewer comments for internal codegen pipelines
- Baseline quality signal in self-correction loops

## Cross-Package References and Current Usage

Current direct references in this monorepo:

- Public exports from `packages/codegen/src/index.ts` (root package API surface)
- Unit tests in `packages/codegen/src/__tests__/code-review.test.ts`

Reference map:

| Location | Reference Type | Current Usage |
| --- | --- | --- |
| `packages/codegen/src/index.ts` (lines 336-340) | Public API export | Re-exports review types/functions for package consumers |
| `packages/codegen/src/__tests__/code-review.test.ts` (lines 19-430) | Functional validation | Primary and currently only executable consumer path |
| `packages/agent/src/templates/agent-templates.ts` (lines 56-72) | Naming overlap (`code-reviewer`) | Agent persona metadata, not wired to this module |
| `packages/agent/src/pipeline/pipeline-templates.ts` (lines 16-45) | Pipeline metadata (`code-reviewer` node id) | Pipeline definition only, no direct call to `reviewFiles`/`reviewDiff` |
| `docs/FORGEAGENT_SELF_IMPROVEMENT.md` (lines 625, 1511) | Conceptual examples | Demonstrates intended usage but currently uses outdated input shape |

Observed integration status:

- No direct runtime imports from other workspace packages currently call `reviewFiles`, `reviewDiff`, or `formatReviewAsMarkdown`.
- `packages/agent` contains a `code-reviewer` agent template and code-review pipelines, but these are agent/pipeline metadata and do not directly invoke this module today.
- `docs/FORGEAGENT_SELF_IMPROVEMENT.md` references conceptual usage, but examples currently use an outdated input shape (`reviewFiles([{ path, content }])`). Real API expects `Record<string, string>`.

## Test Coverage

Primary test file:

- `packages/codegen/src/__tests__/code-review.test.ts`

Review module test scope includes:

- Rule taxonomy integrity (categories, unique IDs, minimum rule count)
- Security/bug/performance/best-practice detection
- Clean-code behavior (no critical/warning noise expectation)
- Severity ordering behavior
- Configuration behavior (`disabledRules`, `customRules`, include/exclude patterns, `minSeverity`)
- Summary correctness and category counts
- Diff parsing behavior:
  - added lines only
  - hunk line-number mapping
  - multiple hunks
  - skip `---`/`+++` headers
- Markdown rendering behavior:
  - no-issues message
  - file grouping
  - severity tokens
  - code snippets
  - suggestion rendering
  - summary counts

Validation run (focused):

- Command: `yarn workspace @dzupagent/codegen test -- src/__tests__/code-review.test.ts`
- Result: `1` test file passed, `45` tests passed.

Coverage run (focused on this test file):

- Command: `yarn workspace @dzupagent/codegen test:coverage -- src/__tests__/code-review.test.ts`
- Module-specific coverage from report:
  - `review/code-reviewer.ts`: 100% statements, 98.46% branches, 100% functions, 100% lines
  - `review/review-rules.ts`: 100% statements/branches/functions/lines
- Note:
  - The command exits non-zero because package-level global coverage thresholds apply to all `src/**/*.ts`, not only review files.
  - Report shows one uncovered branch location in `code-reviewer.ts` around severity resolution in `reviewDiff` (line 141).

## Known Constraints and Tradeoffs

- Regex-only, line-by-line engine:
  - Fast and simple, but can produce false positives/negatives.
  - Limited semantic/context understanding compared to AST/dataflow analyzers.
- Pattern matching is single-line:
  - Multi-line intent in regexes is constrained by per-line scanning.
  - Example: loop+DOM-query patterns are detected only when matching text appears on one line.
- Simple glob implementation:
  - Supports `*` wildcard expansion through regex conversion.
  - Does not implement full glob semantics (`**`, extglobs, brace expansion).
- Rule execution cost:
  - O(number of lines * number of active rules), acceptable for small/medium scans.
- Custom regex caution:
  - If custom rule regexes use mutable flags (for example `g`), repeated `.test()` behavior may be stateful.

## Extension Guidance

If you extend this module:

- Keep built-in rule IDs stable; tooling and reports depend on IDs.
- Add tests for each new rule plus at least one negative case.
- For new config knobs, add tests for precedence/interaction behavior.
- If moving beyond regex limitations, add AST-aware rule adapters while preserving `ReviewRule` compatibility where possible.
