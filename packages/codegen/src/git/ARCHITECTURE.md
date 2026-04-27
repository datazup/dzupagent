# Git Module Architecture (`packages/codegen/src/git`)

## Scope
This document covers the Git-focused implementation under `packages/codegen/src/git`:
- `git-types.ts`
- `git-executor.ts`
- `git-tools.ts`
- `git-middleware.ts`
- `commit-message.ts`
- `git-worktree.ts`
- `index.ts`

It also references package-local integration points that consume or re-export this surface (`packages/codegen/src/index.ts`, `packages/codegen/src/vfs/workspace-fs.ts`, and tests under `packages/codegen/src/__tests__`).

## Responsibilities
The Git module provides five concrete capabilities:
- Execute Git CLI operations through a typed async wrapper (`GitExecutor`).
- Expose Git operations as LangChain tools (`git_status`, `git_diff`, `git_commit`, `git_log`, `git_branch`).
- Build prompt-ready repository context for model calls (`gatherGitContext`, `formatGitContext`).
- Generate commit-message text from diff input using a registry-provided model (`generateCommitMessage`).
- Manage Git worktrees for isolated parallel edits (`GitWorktreeManager`).

The module is intentionally operational and utility-oriented. It does not define policy for when commits/branches should happen; that control is left to callers.

## Structure
`git-types.ts`
- Defines shared contracts: file status enums, status/diff/log/commit result shapes, executor config, and commit-message config.

`git-executor.ts`
- Implements `GitExecutor` around `execFile('git', ...)` with configurable `cwd`, timeout, and max buffer.
- Parses porcelain status output, diff/stat output, log format output, and branch lists.

`git-tools.ts`
- Factory functions that bind a `GitExecutor` to LangChain tools.
- Tool handlers are defensive: they catch exceptions and return JSON strings containing `error` fields when failures happen.

`git-middleware.ts`
- `gatherGitContext` reads status + recent log and formats a compact context object.
- `formatGitContext` renders the context as markdown sections with fenced blocks.

`commit-message.ts`
- Builds a constrained system prompt and a compact diff summary.
- Calls `invokeWithTimeout` against a `ModelRegistry` model and normalizes output (fence/quote cleanup, subject-length cap).

`git-worktree.ts`
- `GitWorktreeManager` creates/removes/lists/merges worktrees using `git worktree` plus `git checkout/merge`.

`index.ts`
- Local barrel re-exporting executor, tool factories, commit-message generator, and shared types.
- Note: middleware and worktree exports are not re-exported here; they are exported at package root (`packages/codegen/src/index.ts`).

## Runtime and Control Flow
1. Command execution path (`GitExecutor`)
- Public method builds Git args.
- Private `git(args)` executes `execFileAsync('git', args, { cwd, timeout, maxBuffer })`.
- Method-specific parsers convert stdout/stderr into typed results.

2. Status flow
- `status()` resolves branch (`symbolic-ref`, fallback to detached short hash).
- Runs `git status --porcelain=v1 -b --untracked-files=normal`.
- Parses branch metadata (`upstream`, `ahead`, `behind`) and file entries (staged/unstaged/untracked/renamed).

3. Diff flow
- `diff()` runs `git diff ... --stat` for summary parsing.
- Runs full `git diff ...` for patch text.
- Returns combined summary + raw diff.
- `git_diff` tool truncates returned diff to 8,000 chars.

4. Commit flow
- `git_commit` optionally stages specific files (`add`) or all files (`addAll`).
- Re-checks status and blocks commit when no staged files are present.
- On success, `commit()` runs `git commit -m`, then reads `git log -1` and `git diff --stat HEAD~1 HEAD` to report commit metadata.

5. Context-injection flow
- `gatherGitContext()` runs `status()` and `log(limit)` concurrently.
- Builds compact text blocks for working tree and recent commits.
- Returns `null` on Git failure/non-repo context.

6. Commit-message generation flow
- Caller provides `ModelRegistry` and `GitDiffResult`.
- Function builds style-aware prompt (`conventional` or `descriptive`), truncates diff payload to 4,000 chars, and invokes model with 15s timeout.
- Output is sanitized and subject line is hard-capped to configured length.

7. Worktree flow
- `create()` -> `git worktree add -b <branch> <dir> <base>`.
- `remove()` -> forced worktree removal, optional best-effort `git branch -D`.
- `list()` parses porcelain output from `git worktree list --porcelain`.
- `merge()` checks out target branch, merges worktree branch, checks out prior branch, and returns `{ success, output }`.

## Key APIs and Types
Primary classes/functions:
- `GitExecutor`
- `createGitTools`, `createGitStatusTool`, `createGitDiffTool`, `createGitCommitTool`, `createGitLogTool`, `createGitBranchTool`
- `gatherGitContext`, `formatGitContext`
- `generateCommitMessage`
- `GitWorktreeManager`

Primary types:
- `GitFileStatus`, `GitFileEntry`
- `GitStatusResult`, `GitDiffResult`, `GitLogEntry`, `GitCommitResult`
- `GitExecutorConfig`, `CommitMessageConfig`
- `GitContextConfig`, `GitContext`
- `WorktreeInfo`, `WorktreeManagerConfig`

Tool contract behavior:
- Tool handlers return JSON strings, not plain objects.
- Failure mode is encoded in payload (`{ error: ... }`) instead of thrown exception.

## Dependencies
Runtime dependencies used by this module:
- Node built-ins: `node:child_process`, `node:util`, `node:path`.
- `@langchain/core/tools` for tool definitions.
- `@langchain/core/messages` for commit-message prompt messages.
- `zod` for tool input schemas.
- `@dzupagent/core` for `ModelRegistry`, `ModelTier`, and `invokeWithTimeout`.

Package metadata context (`packages/codegen/package.json`):
- Declares `@dzupagent/core` and `@dzupagent/adapter-types` as dependencies.
- Declares `@langchain/core`, `@langchain/langgraph`, and `zod` as peer dependencies (with local dev versions in devDependencies).

## Integration Points
Inside `packages/codegen`:
- `packages/codegen/src/index.ts` exports the full Git surface, including middleware and worktree manager.
- `packages/codegen/src/vfs/workspace-fs.ts` defines `GitWorktreeWorkspaceFS`, which consumes worktree directories created externally (typically from `GitWorktreeManager.create()`).

Consumer-facing package entrypoint:
- External users import Git APIs from `@dzupagent/codegen` (root exports), not from the local `src/git/index.ts` barrel.

Documentation alignment:
- `packages/codegen/docs/api-tiers.md` lists this Git surface as stable/public.

## Testing and Observability
Current tests in this package:
- `src/__tests__/git-executor.test.ts` covers command argument construction and parser behavior for status/diff/log/commit/branch helpers.
- `src/__tests__/git-worktree.test.ts` and `src/__tests__/git-worktree-deep.test.ts` cover worktree create/remove/list/merge and execution option plumbing.
- `src/__tests__/git-middleware.test.ts` covers `formatGitContext` output formatting (pure function).
- `src/__tests__/git-tools.test.ts` currently contains PR-manager/review-handler tests plus `formatGitContext` assertions; it does not validate `createGitTools` behavior.

Observability characteristics:
- No dedicated logger/telemetry in this module.
- Operational visibility is returned via structured outputs (`GitStatusResult`, `GitDiffResult`, merge output strings, tool JSON payloads).
- Failures are mostly surfaced directly from Git command errors or encoded as `{ error }` in tool responses.

## Risks and TODOs
- `GitContextConfig.includeDiffStat` is defined but currently unused in `gatherGitContext`.
- `git-executor.ts` comment says “Porcelain v2” while the implementation runs `--porcelain=v1`.
- `src/git/index.ts` omits middleware/worktree exports; root export is complete, but local barrel can mislead internal imports.
- No focused tests currently exercise:
  - `generateCommitMessage`
  - `gatherGitContext` runtime path (only formatter is tested)
  - `git-tools.ts` tool schemas and handler paths (including truncation and commit guard behavior)
- `GitWorktreeManager.merge()` does not attempt recovery if an error happens after switching branches and before switching back.
- Diff stat parsing in `GitExecutor.diff()` is heuristic (symbol counting + summary regex) and may be inaccurate for unusual stat formats.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js.

