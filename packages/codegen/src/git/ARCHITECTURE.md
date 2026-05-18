# Git Module Architecture

## Scope
This document covers `packages/codegen/src/git` in `@dzupagent/codegen`.

Included files:
- `git-types.ts`
- `git-executor.ts`
- `git-tools.ts`
- `git-middleware.ts`
- `commit-message.ts`
- `git-worktree.ts`
- `ref-validator.ts`
- `index.ts`
- `__tests__/ref-validator.test.ts`
- `__tests__/git-executor-ref-validation.test.ts`
- `__tests__/git-worktree-ref-validation.test.ts`

Related package-level surfaces referenced for integration context:
- `packages/codegen/src/index.ts` (root package exports)
- `packages/codegen/src/vfs/workspace-fs.ts` (`GitWorktreeWorkspaceFS`)
- `packages/codegen/package.json`
- `packages/codegen/docs/api-tiers.md`
- Git-related tests under `packages/codegen/src/__tests__`

## Responsibilities
The git module provides operational primitives for repository-aware codegen flows:

- Execute git CLI commands with typed results (`GitExecutor`).
- Provide LangChain tool wrappers around git actions (`git_status`, `git_diff`, `git_commit`, `git_log`, `git_branch`).
- Enforce host-side policy for mutating tool calls (`GitToolPolicy.allowMutatingTools`).
- Build prompt-injection git context blocks (`gatherGitContext`, `formatGitContext`).
- Generate commit messages from diffs with LLM calls (`generateCommitMessage`).
- Manage branch-isolated worktrees for parallel editing (`GitWorktreeManager`).
- Validate caller-supplied git refs before invoking git (`validateRefName` / `InvalidGitRefError`).

This module is utility/runtime plumbing. It does not decide when to branch, merge, or commit; callers and higher-level orchestration own that policy.

## Structure
- `git-types.ts`
  - Shared contracts for status/diff/log/commit outputs and executor/message-generator config.
  - Defines `GitExecutorConfig.allowedRoots` for cwd confinement.

- `ref-validator.ts`
  - Strict ref validation and branded `GitRefName`.
  - Exposes `validateRefName` (assertion-style) and `asRefName`.
  - Throws `InvalidGitRefError` with structured metadata.

- `git-executor.ts`
  - `GitExecutor` wraps `execFile('git', ...)` with `timeoutMs` and `maxBuffer` defaults.
  - Applies `allowedRoots` boundary checks during construction.
  - Implements `isGitRepo`, `getRepoRoot`, `getCurrentBranch`, `status`, `diff`, `log`, `add`, `addAll`, `commit`, `createBranch`, `switchBranch`, `listBranches`, `headHash`.
  - Applies ref validation and uses `--end-of-options` in branch mutation methods.

- `git-tools.ts`
  - Tool factories over a provided `GitExecutor`.
  - Returns JSON strings from all handlers (success and error paths).
  - Gates mutating operations (`git_commit`, `git_branch:create`, `git_branch:switch`) behind `allowMutatingTools`.

- `git-middleware.ts`
  - `gatherGitContext` collects status/log in parallel and returns a compact context object or `null`.
  - `formatGitContext` renders context into markdown with fenced blocks.

- `commit-message.ts`
  - `generateCommitMessage` builds system/human messages, invokes model with timeout, and normalizes output.
  - Supports `conventional` and `descriptive` style guidance.

- `git-worktree.ts`
  - `GitWorktreeManager` with `create`, `remove`, `list`, `merge`.
  - Uses `git worktree` and branch checkout/merge commands.
  - Validates input refs and injects `--end-of-options` for checkout/merge/add flows.

- `index.ts`
  - Local git barrel exports executor, tool factories, commit-message generator, and core git types.
  - Does not export middleware, worktree manager, or ref-validator helpers (those are exported from package root `src/index.ts` except ref-validator, which remains internal).

## Runtime and Control Flow
1. Executor initialization and trust boundary
- `GitExecutor` resolves `cwd` and optionally enforces it is inside one of `allowedRoots`.
- All git invocations run via `execFileAsync('git', args, { cwd, timeout, maxBuffer })`.

2. Status/log/diff read paths
- `status()`:
  - Gets branch with `symbolic-ref --short HEAD`, falls back to detached short hash.
  - Parses `git status --porcelain=v1 -b --untracked-files=normal`.
  - Emits staged/unstaged/untracked entries and branch tracking metadata.
- `log(maxCount)` parses `git log --format=%H|%h|%an|%aI|%s`.
- `diff(options)` runs `git diff ... --stat` and then `git diff ...`, returning summary plus unified diff text.

3. Mutating git paths
- `createBranch` / `switchBranch`:
  - Validate refs up front.
  - Use `--end-of-options` so user-supplied refs are not parsed as flags.
- `commit` path:
  - Tool-level flow may stage (`add`/`addAll`) then verifies staged files via `status()`.
  - If staged files exist, executor runs `git commit -m ...`, then reads latest commit and changed-file count.

4. Tool wrapper behavior
- `createGitTools` returns five tools.
- Tools catch exceptions and serialize `{ error: ... }`.
- `git_diff` truncates returned `diff` to 8,000 chars.
- Mutating operations return a policy-denied payload when `allowMutatingTools` is false.

5. Context middleware path
- `gatherGitContext` runs `status()` and `log(recentCommits)` concurrently.
- Formats file list and commit list into text fragments.
- Returns `null` on any git failure (non-repo, missing binary, command errors).
- `formatGitContext` converts the object into prompt-ready markdown.

6. Commit message generation path
- `generateCommitMessage` gets model by tier (`chat` default) from `ModelRegistry`.
- Builds a compact diff summary with optional file list and diff truncation (4,000 chars max for diff body).
- Invokes model via `invokeWithTimeout(..., { timeoutMs: 15_000 })`.
- Normalizes output by stripping fences/quotes and truncating overly long subject lines.

7. Worktree path
- `create` runs `git worktree add -b <branch> --end-of-options <dir> <base>`.
- `remove` runs forced worktree removal and best-effort branch deletion.
- `list` parses `git worktree list --porcelain`.
- `merge`:
  - Reads current branch.
  - Checks out target, merges worktree branch with `--no-edit`, then checks out previous branch when available.
  - Returns `{ success, output }`; conflict detection is string-based on stdout/stderr containing `CONFLICT`.

## Key APIs and Types
Primary classes/functions:
- `GitExecutor`
- `createGitTools`
- `createGitStatusTool`
- `createGitDiffTool`
- `createGitCommitTool`
- `createGitLogTool`
- `createGitBranchTool`
- `gatherGitContext`
- `formatGitContext`
- `generateCommitMessage`
- `GitWorktreeManager`
- `validateRefName`
- `asRefName`

Primary interfaces/types:
- `GitFileStatus`
- `GitFileEntry`
- `GitStatusResult`
- `GitDiffResult`
- `GitLogEntry`
- `GitCommitResult`
- `GitExecutorConfig`
- `CommitMessageConfig`
- `GitContextConfig`
- `GitContext`
- `WorktreeInfo`
- `WorktreeManagerConfig`
- `GitToolPolicy`
- `GitRefName`
- `GitRefKind`
- `InvalidGitRefError`

Contract notes:
- Tool handlers return serialized JSON strings, not raw objects.
- Ref validation is intentionally stricter than generic git ref formatting to block option-like and metacharacter payloads.

## Dependencies
Direct runtime dependencies inside `src/git`:
- Node built-ins:
  - `node:child_process` (`execFile`)
  - `node:util` (`promisify`)
  - `node:path` (`resolve`, `relative`, `isAbsolute`, `join`)
- Third-party:
  - `@langchain/core/tools` (`tool`, tool interfaces)
  - `@langchain/core/messages` (`HumanMessage`, `SystemMessage`)
  - `zod` (tool input schemas)
- Internal package:
  - `@dzupagent/core/llm` (`ModelRegistry`, `ModelTier`, `invokeWithTimeout`)
  - local `ref-validator.ts` reused by executor/worktree

Package metadata context (`packages/codegen/package.json`):
- `dependencies`: `@dzupagent/core`, `@dzupagent/adapter-types`
- `peerDependencies`: `@langchain/core`, `@langchain/langgraph`, `zod`, optional tree-sitter peers

## Integration Points
Export surfaces:
- `packages/codegen/src/index.ts` exports git executor/tools/types plus middleware/worktree APIs.
- `packages/codegen/src/git/index.ts` is a narrower barrel and omits middleware/worktree/ref-validator exports.
- Published package entrypoints in `package.json` only expose root/`vfs`/`tools`/`runtime`/`compat`; git APIs are consumed via root import.

Runtime adjacency:
- `GitWorktreeWorkspaceFS` in `src/vfs/workspace-fs.ts` is designed to run on a worktree directory created externally (typically by `GitWorktreeManager.create`).

API classification:
- `docs/api-tiers.md` classifies:
  - `GitExecutor`, git tool factories, and git contract types as stable.
  - `generateCommitMessage`, git middleware APIs, and worktree manager APIs as advanced.

## Testing and Observability
Git-specific tests under `src/__tests__`:
- `git-executor.test.ts`
  - Covers constructor constraints (`allowedRoots`), status/log/diff parsing, add/addAll/commit, branch switch/create, list/head hash.
- `git-worktree.test.ts`
  - Covers create/remove/list/merge happy paths and error handling.
- `git-worktree-deep.test.ts`
  - Adds branch/path/timeout/maxBuffer call-shape checks and many edge cases around list/merge/remove behavior.
- `git-middleware.test.ts`
  - Covers formatter output.
- `git-tools.test.ts`
  - Covers mutating-policy gating for `git_commit` and `git_branch` list/switch behavior.
- `codegen-multiedit-repomap-deep.test.ts`
  - Includes `gatherGitContext` success/failure path coverage and formatter interoperability checks.

Ref-hardening tests under `src/git/__tests__`:
- `ref-validator.test.ts`
- `git-executor-ref-validation.test.ts`
- `git-worktree-ref-validation.test.ts`

Observability characteristics:
- No dedicated logger/metrics/tracing inside `src/git`.
- Operational visibility is returned through typed results and tool JSON payloads.
- Worktree merge diagnostics are surfaced as raw concatenated `stdout + stderr` strings.

## Risks and TODOs
- `GitContextConfig.includeDiffStat` exists but is currently unused in `gatherGitContext`.
- `GitExecutor.status()` comment says "Porcelain v2" while command uses `--porcelain=v1`.
- `git-executor.diff()` stat parsing uses line regex plus summary fallback; unusual `--stat` formats may reduce accuracy.
- `GitWorktreeManager.merge()` can leave branch state changed if a failure occurs after checkout and before restoration.
- `git-tools.ts` currently validates policy behavior but has limited direct tests for every tool schema/handler branch (for example, full `git_diff` truncation payload behavior and all invalid-input combinations).
- `generateCommitMessage` has no dedicated unit test file; behavior is currently validated indirectly by type/runtime coverage only.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js