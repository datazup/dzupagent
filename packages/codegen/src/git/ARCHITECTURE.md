# Git Module Architecture (`packages/codegen/src/git`)

## 1. Purpose

The `src/git` module provides Git-aware primitives for code-generation workflows:

- low-level Git command execution (`GitExecutor`),
- agent-facing LangChain tools (`git_status`, `git_diff`, `git_commit`, `git_log`, `git_branch`),
- prompt-ready repository context formatting,
- optional commit-message generation from diffs via LLM,
- worktree orchestration for parallel branch isolation.

Design goal: keep Git operations composable and reusable across autonomous agents, while avoiding hard coupling between Git internals and higher-level orchestration logic.

---

## 2. Module Composition

Files in this folder:

- `git-types.ts`: shared data contracts for status/diff/log/commit/config.
- `git-executor.ts`: low-level async wrapper over `git` CLI.
- `git-tools.ts`: LangChain tool factories wrapping `GitExecutor`.
- `git-middleware.ts`: context gatherer + markdown formatter for prompts.
- `commit-message.ts`: LLM-driven commit message generator from diff summary.
- `git-worktree.ts`: manager for create/list/remove/merge worktrees.
- `index.ts`: local barrel export (executor, tools, types, commit-message).

Note on exports:

- package root (`packages/codegen/src/index.ts`) exports the full Git surface, including middleware and worktree manager.
- local git barrel (`src/git/index.ts`) exports a subset and does not re-export `gatherGitContext`, `formatGitContext`, or `GitWorktreeManager`.

---

## 3. Core Data Model

Defined in `git-types.ts`:

- `GitFileStatus`: `added | modified | deleted | renamed | untracked | conflicted`.
- `GitFileEntry`: file path + status + staged flag (+ optional `originalPath` for renames).
- `GitStatusResult`: branch/upstream/ahead/behind + file list + `clean` flag.
- `GitDiffResult`: unified diff text + summary counts + per-file stats.
- `GitLogEntry`: hash/shortHash/author/date/message.
- `GitCommitResult`: commit hash/message/filesChanged.
- `GitExecutorConfig`: `cwd`, command timeout, max buffer.
- `CommitMessageConfig`: conventional/descriptive style + subject-length + file-list behavior.

---

## 4. Execution Flows

### 4.1 Runtime Tool Resolution Flow (Cross-Package)

Primary runtime path is in `packages/server/src/runtime/tool-resolver.ts`:

1. Resolver detects `git` category or explicit Git tool names.
2. It loads `createGitTools` + `GitExecutor` from `@dzupagent/codegen`.
3. If package import fails, it falls back to monorepo source imports (`codegen/src/git/*`).
4. It instantiates `new GitExecutor({ cwd })`.
5. It calls `createGitTools(gitExec)` and filters by requested names.
6. Resulting tools are registered as source `"git"`.

This keeps `server` decoupled from concrete Git implementation while still supporting local monorepo development.

### 4.2 `GitExecutor` Command Flow

```text
Consumer call (status/diff/log/commit/branch/...)
        |
        v
GitExecutor method builds git args
        |
        v
private git(args) -> execFileAsync("git", args, { cwd, timeout, maxBuffer })
        |
        v
stdout/stderr parsed into typed result
```

Behavior characteristics:

- Most methods throw on git command failure.
- `isGitRepo()` is explicitly non-throwing and returns `false` on failure.
- `getCurrentBranch()` falls back to `(detached <hash>)` when symbolic ref fails.

### 4.3 Status Parsing Flow

`status()` issues:

- `getCurrentBranch()`
- `git status --porcelain=v1 -b --untracked-files=normal`

It then parses:

- branch metadata line (`## ...`) for upstream/ahead/behind,
- file lines (`XY path`) into staged/unstaged entries,
- rename records (`old -> new`) with `originalPath`,
- untracked (`??`) entries.

### 4.4 Diff Flow

`diff(options)` does two calls:

1. `git diff ... --stat` for summary parsing.
2. `git diff ...` for full patch text.

Supported modes:

- unstaged (default),
- staged (`--cached`),
- ref comparison (`ref1` and optional `ref2`),
- path-limited diff (`-- <paths...>`).

`git-tools.ts` additionally truncates diff text to 8,000 chars for tool response safety.

### 4.5 Commit Flow (`git_commit` tool path)

```text
tool input -> optional staging (addAll or add(paths))
        |
        v
executor.status() -> ensure staged files exist
        |
        +-- none staged -> return JSON error (non-throw)
        |
        v
executor.commit(message)
        |
        v
JSON { hash, message, filesChanged, success: true }
```

The tool description embeds operational guardrails:

- do not commit unless user requested,
- prefer explicit `paths` over `addAll`,
- do not bypass failing hooks.

### 4.6 Git Context Injection Flow

`gatherGitContext()` runs `status()` and `log()` concurrently, then returns:

- branch,
- formatted working-tree lines,
- compact recent commit list (`<shortHash> <subject>`),
- `isDirty` flag.

`formatGitContext()` serializes this into markdown for LLM/system-prompt injection.

If Git commands fail (not a repo/git unavailable), `gatherGitContext()` returns `null`.

### 4.7 Commit Message Generation Flow

`generateCommitMessage(registry, diff, config?, modelTier='chat')`:

1. merge default config + overrides,
2. pick model from `ModelRegistry`,
3. build system prompt (style and subject-length constraints),
4. build compact diff summary (stats + optional file list + truncated diff body),
5. invoke model with 15s timeout via `invokeWithTimeout`,
6. sanitize output (strip fences/quotes),
7. enforce subject max length.

### 4.8 Worktree Lifecycle Flow

`GitWorktreeManager` supports:

- `create(branchName, baseBranch?)` -> `git worktree add -b`.
- `remove(branchName, deleteBranch=true)` -> force remove worktree, best-effort branch delete.
- `list()` -> parse `git worktree list --porcelain`.
- `merge(worktreeBranch, targetBranch)` -> checkout target, merge, checkout original branch, return `{ success, output }`.

---

## 5. Feature Catalog (Descriptive)

### 5.1 Repository Introspection

- Detect repo presence (`isGitRepo`).
- Resolve repo root (`getRepoRoot`).
- Resolve current branch and detached-head representation.
- Parse branch tracking divergence (ahead/behind).

### 5.2 Change Intelligence

- Machine-readable status snapshots with staged/unstaged distinction.
- Diff extraction with both raw patch and aggregate stats.
- Structured commit history parsing with support for `|` inside messages.

### 5.3 Safe-ish Tool Wrappers for Agents

- JSON-only tool responses for stable downstream parsing.
- Per-tool try/catch converts operational failures to explicit `error` payloads.
- Diff-size truncation protects context windows.
- Commit tool enforces staged-change check before committing.

### 5.4 Prompt Conditioning

- Git context can be injected as markdown block for richer model grounding.
- Commit message generation uses concise summaries to reduce token cost.

### 5.5 Parallel Agent Support

- Worktree manager provides isolated branch directories for concurrent workers.
- `GitWorktreeWorkspaceFS` in `src/vfs` can mount these directories as workspace backends.

---

## 6. Usage Examples

### 6.1 Direct `GitExecutor` Usage

```ts
import { GitExecutor } from '@dzupagent/codegen'

const git = new GitExecutor({ cwd: '/repo', timeoutMs: 30_000 })

const status = await git.status()
if (!status.clean) {
  const unstaged = await git.diff()
  console.log(unstaged.filesChanged, unstaged.insertions, unstaged.deletions)
}
```

### 6.2 Agent Tools (LangChain)

```ts
import { GitExecutor, createGitTools } from '@dzupagent/codegen'

const executor = new GitExecutor({ cwd: '/repo' })
const tools = createGitTools(executor)

// Tool names:
// git_status, git_diff, git_commit, git_log, git_branch
```

### 6.3 Commit With Explicit Staging (Recommended Pattern)

```ts
const gitCommitTool = tools.find((t) => t.name === 'git_commit')!
const result = await gitCommitTool.invoke({
  message: 'fix(auth): handle missing refresh token',
  paths: ['src/auth/session.ts', 'src/auth/session.test.ts'],
})
```

### 6.4 Prompt Context Injection

```ts
import { gatherGitContext, formatGitContext } from '@dzupagent/codegen'

const ctx = await gatherGitContext({ cwd: '/repo', recentCommits: 5 })
const gitBlock = ctx ? formatGitContext(ctx) : '## Git Context\n(not a git repo)'
```

### 6.5 Commit Message Generation

```ts
import { generateCommitMessage, type GitDiffResult } from '@dzupagent/codegen'
import type { ModelRegistry } from '@dzupagent/core'

async function autoMessage(registry: ModelRegistry, diff: GitDiffResult) {
  return generateCommitMessage(registry, diff, {
    style: 'conventional',
    maxSubjectLength: 72,
    includeFileList: true,
  })
}
```

### 6.6 Worktree-Oriented Parallel Flow

```ts
import { GitWorktreeManager, GitWorktreeWorkspaceFS } from '@dzupagent/codegen'

const mgr = new GitWorktreeManager({ repoDir: '/repo' })
const wt = await mgr.create('agent/fix-auth', 'main')
const fs = new GitWorktreeWorkspaceFS(wt.dir)

await fs.write('src/auth.ts', '// isolated edit')
// ... run checks in worktree
await mgr.merge('agent/fix-auth', 'main')
await mgr.remove('agent/fix-auth', true)
```

---

## 7. Practical Use Cases

- Autonomous coding agent that needs safe Git visibility and controlled commits.
- PR-assistant workflow where diff/log/status are tool-callable functions.
- Multi-agent fix orchestration with one worktree per worker branch.
- Pre-commit assistant generating high-quality commit messages from staged diff.
- Prompt enrichment for repositories with large or active change sets.

---

## 8. Cross-Package References and Current Usage

As of this analysis (2026-04-04), active references are:

- `packages/server/src/runtime/tool-resolver.ts`
  - Runtime integration point for Git tool activation.
  - Dynamically imports `GitExecutor` and `createGitTools`.
  - Builds tools with request `cwd` metadata.
- `packages/server/src/__tests__/tool-resolver.test.ts`
  - Verifies git category resolution, explicit-name resolution, profile behavior, and warning behavior.
- `packages/codegen/src/index.ts`
  - Re-exports the Git module APIs at package root for external consumers.
- `packages/codegen/src/vfs/workspace-fs.ts`
  - `GitWorktreeWorkspaceFS` documents external dependency on `GitWorktreeManager.create()` result.

Current non-usage (code references not found outside declarations/exports/tests):

- `generateCommitMessage(...)` is exported but has no in-repo runtime call sites.
- `gatherGitContext(...)` is exported but has no in-repo runtime call sites.
- `GitWorktreeManager` is exported but not currently instantiated by other packages.
- Individual tool factories (`createGitStatusTool`, etc.) are not directly consumed outside `createGitTools`.

Interpretation:

- The Git module is fully published and wired for server tool resolution, while some advanced APIs (middleware, commit-message generation, worktree manager) are extension surfaces ready for adoption.

---

## 9. Test Coverage Status

Validation performed:

- Targeted tests:
  - `yarn workspace @dzupagent/codegen test src/__tests__/git-executor.test.ts src/__tests__/git-tools.test.ts`
  - Result: 2 files passed, 67 tests passed.
- Targeted coverage run:
  - `yarn workspace @dzupagent/codegen test:coverage -- src/__tests__/git-executor.test.ts src/__tests__/git-tools.test.ts`
  - Coverage report generated, but command exited non-zero due package global thresholds (expected when running only a subset).

Coverage from that run for `src/git`:

- Folder `git`: 41.99% statements, 77.02% branches, 80.95% functions, 41.99% lines.
- `git-executor.ts`: 99.41% statements, 80% branches, 100% functions, 99.41% lines.
- `git-middleware.ts`: 59.52% statements, 100% branches, 50% functions, 59.52% lines.
- `commit-message.ts`: 0% across all metrics.
- `git-tools.ts`: 0% across all metrics.
- `git-worktree.ts`: 0% across all metrics.

What is explicitly covered:

- `GitExecutor` constructor/config handling.
- `isGitRepo`, `getRepoRoot`, detached-head handling.
- status parsing for upstream/ahead/behind, staged/unstaged, untracked, renamed.
- diff modes (`staged`, `ref`), add/addAll, commit parsing, branch operations, head hash.
- `formatGitContext` markdown output (clean/dirty scenarios).
- Cross-package activation behavior via server resolver tests (tool name resolution paths).

Not directly covered by dedicated unit tests:

- `gatherGitContext` runtime behavior.
- tool-factory behavior in `git-tools.ts` (schemas, truncation path, commit guard path, error payload shape).
- `generateCommitMessage` prompt/output sanitation behavior.
- `GitWorktreeManager` create/list/remove/merge semantics.

---

## 10. Observed Constraints and Extension Notes

- `GitContextConfig.includeDiffStat` exists but is not currently used in `gatherGitContext`.
- `status()` comment references porcelain v2, while command uses `--porcelain=v1`.
- Diff stat parsing is heuristic (`+`/`-` char counting); special diff formats may not map perfectly.
- Worktree merge flow attempts checkout back to previous branch only on successful command path; a merge exception returns `{ success: false }` without explicit recovery step.
- Local `src/git/index.ts` is not the full Git surface; package-root imports are the stable consumer entry point.
