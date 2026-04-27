# VFS Module Architecture (`packages/codegen/src/vfs`)

## Scope
This document covers the code under `packages/codegen/src/vfs` in `@dzupagent/codegen`:
- `virtual-fs.ts`
- `vfs-types.ts`
- `cow-vfs.ts`
- `parallel-sampling.ts`
- `patch-engine.ts`
- `workspace-fs.ts`
- `workspace-runner.ts`
- `vfs-snapshot.ts`
- `checkpoint-manager.ts`
- `path-security-error.ts`

It also references package-level exports from `packages/codegen/src/index.ts` and direct in-package consumers where relevant.

## Responsibilities
The VFS module is the codegen package's file-state and patch/execution substrate. It is responsible for:
- Holding generated files in memory (`VirtualFS`).
- Creating isolated forked views for speculative edits (`CopyOnWriteVFS`).
- Running and selecting parallel generation attempts (`sample`, `selectBest`, `sampleAndCommitBest`).
- Parsing and applying unified diffs with typed outcomes (`parseUnifiedDiff`, `applyPatch`, `applyPatchSet`).
- Providing backend-neutral workspace file operations (`WorkspaceFS` and implementations).
- Bridging in-memory snapshots to sandbox command execution (`WorkspaceRunner`).
- Persisting and restoring snapshots via a caller-owned store (`saveSnapshot`, `loadSnapshot`).
- Creating rollback checkpoints for real directories using shadow git repos (`CheckpointManager`).
- Enforcing root confinement on disk-backed workspace paths (`PathSecurityError` via `DiskWorkspaceFS.resolveSafe`).

## Structure
- `virtual-fs.ts`
  - `VirtualFS` class and `FileDiff` type.
  - Basic map-backed CRUD/list/snapshot/diff/merge API.
- `vfs-types.ts`
  - Shared CoW/sampling types: `MergeStrategy`, `MergeConflict`, `MergeResult`, `VFSDiff`, `SampleResult`.
- `cow-vfs.ts`
  - `CopyOnWriteVFS` with overlay/deletion masks, parent chaining, conflict detection, merge strategies, and depth guard (`MAX_FORK_DEPTH = 3`).
- `parallel-sampling.ts`
  - Sampling orchestration primitives over `CopyOnWriteVFS` (`sample`, `selectBest`, `commitBest`, `sampleAndCommitBest`).
- `patch-engine.ts`
  - Unified diff parser and applier with typed hunk/file results and rollback-capable patch-set application.
- `workspace-fs.ts`
  - `WorkspaceFS` interface.
  - Implementations: `InMemoryWorkspaceFS`, `DiskWorkspaceFS`, `GitWorktreeWorkspaceFS`.
- `workspace-runner.ts`
  - `WorkspaceRunner` plus `WorkspaceRunOptions`/`WorkspaceRunResult`.
- `vfs-snapshot.ts`
  - Snapshot store contract and non-throwing save/load helpers.
- `checkpoint-manager.ts`
  - Shadow-git checkpoint system with per-turn dedup and restore/diff/list helpers.
- `path-security-error.ts`
  - Dedicated error type thrown when a resolved path escapes workspace root.

## Runtime and Control Flow
1. In-memory editing flow:
- Callers mutate `VirtualFS` using `write/read/delete/list`.
- Optional `toSnapshot()`/`fromSnapshot()` are used to move state across pipeline boundaries.

2. Copy-on-write sampling flow:
- `sample`/`sampleAndCommitBest` create `CopyOnWriteVFS` forks from a root `VirtualFS`.
- Each fork runs independently.
- `selectBest` filters errored samples and scores successful results.
- `commitBest` merges the winner into parent with `theirs` strategy.

3. Unified patch flow:
- `parseUnifiedDiff` converts raw diff text into `FilePatch[]`.
- `applyPatch` applies hunks for one file with context matching and fuzz search (`MAX_FUZZ = 3`).
- `applyPatchSet` orchestrates multi-file application with optional rollback (`rollbackOnFailure`).
- `WorkspaceFS.applyPatch` in both in-memory and disk implementations delegates to that engine.

4. Sandbox run flow:
- `WorkspaceRunner.run` snapshots a `VirtualFS`.
- Uploads snapshot to `SandboxProtocol.uploadFiles`.
- Executes command via `SandboxProtocol.execute`.
- If `syncBack` is enabled, downloads selected paths and writes changed content back into `VirtualFS`.

5. Checkpoint flow for real directories:
- `CheckpointManager.ensureCheckpoint` resolves target dir, applies safety checks, and deduplicates once per turn.
- Uses shadow git repo (`GIT_DIR`/`GIT_WORK_TREE`) to stage and commit snapshot state.
- `restore` creates a pre-rollback snapshot, then checks out target checkpoint content.
- `list` and `diff` expose checkpoint history and drift stats.

## Key APIs and Types
Core state:
- `VirtualFS`
  - `write(path, content)`, `read(path)`, `exists(path)`, `delete(path)`, `list(directory?)`, `size`
  - `toSnapshot()`, `fromSnapshot(snapshot)`
  - `diff(other)`, `merge(other)`
- `FileDiff`

Forking and sampling:
- `CopyOnWriteVFS`
  - `fork()`, `merge(strategy)`, `conflicts(other)`, `diff()`, `forkDelta()`, `detach()`
  - `getModifiedFiles()`, `getDeletedFiles()`, `toSnapshot()`, `depth`, `label`
- `MergeStrategy`, `MergeConflict`, `MergeResult`, `VFSDiff`, `SampleResult<T>`
- `sample`, `selectBest`, `commitBest`, `sampleAndCommitBest`

Patch engine:
- `parseUnifiedDiff(diff)`
- `applyPatch(content, patch)`
- `applyPatchSet(patches, readFile, writeFile, options?)`
- Types: `PatchErrorCode`, `PatchLine`, `PatchHunk`, `FilePatch`, `HunkResult`, `PatchApplyResult`, `ApplyPatchSetOptions`
- Error: `PatchParseError`

Workspace abstraction:
- `WorkspaceFS` interface
- `InMemoryWorkspaceFS`, `DiskWorkspaceFS`, `GitWorktreeWorkspaceFS`
- `PatchOptions`, `WorkspacePatchResult`
- Error: `PathSecurityError`

Execution and persistence:
- `WorkspaceRunner`
- `WorkspaceRunOptions`, `WorkspaceRunResult`
- `SnapshotStore`, `saveSnapshot`, `loadSnapshot`, `SnapshotSaveResult`, `SnapshotLoadResult`
- `CheckpointManager`, `CheckpointManagerConfig`, `CheckpointResult`, `CheckpointEntry`, `CheckpointDiff`

## Dependencies
Internal dependencies inside `packages/codegen`:
- `workspace-runner.ts` depends on `../sandbox/sandbox-protocol.js` (`SandboxProtocol`, `ExecOptions`, `ExecResult`).
- `workspace-fs.ts` depends on `patch-engine.ts` and `path-security-error.ts`.
- `parallel-sampling.ts` depends on `cow-vfs.ts` and `vfs-types.ts`.
- `cow-vfs.ts` depends on `virtual-fs.ts` and `vfs-types.ts`.

Node.js runtime dependencies used by VFS layer:
- Filesystem/path: `node:fs/promises`, `node:path`.
- Process/crypto/git helpers: `node:child_process`, `node:crypto`, `node:util`.

Package-level note:
- `@dzupagent/codegen` runtime dependencies are `@dzupagent/core` and `@dzupagent/adapter-types`.
- VFS source files themselves do not directly import package peer dependencies (`@langchain/*`, `zod`, tree-sitter packages).

## Integration Points
Inside `@dzupagent/codegen`:
- Public exports: `packages/codegen/src/index.ts` re-exports the full VFS surface.
- Tools:
  - `tools/edit-file.tool.ts` supports both direct `VirtualFS` and workspace-backed file edits through `CodegenToolContext`.
  - `tools/multi-edit.tool.ts` mutates `VirtualFS` directly.
  - `tools/write-file.tool.ts` can route writes to workspace when provided.
- Validation:
  - `validation/import-validator.ts` traverses `VirtualFS` to resolve relative imports.
- Git/worktree bridge:
  - `GitWorktreeWorkspaceFS` provides a filesystem adapter for directories created by git worktree flows (worktree creation itself is outside `src/vfs`).

Cross-module behavior coupling:
- `WorkspaceRunner` expects sandbox backends implementing `SandboxProtocol` upload/execute/download semantics.
- `DiskWorkspaceFS` patch application security relies on centralized `resolveSafe` checks and throws `PathSecurityError` for path traversal attempts.

## Testing and Observability
Primary VFS-focused suites under `src/__tests__`:
- `vfs.test.ts` (35 tests)
- `vfs-snapshot.test.ts` (7 tests)
- `vfs/cow-vfs.test.ts` (53 tests)
- `vfs/cow-vfs-extended.test.ts` (35 tests)
- `vfs/parallel-sampling.test.ts` (48 tests)
- `patch-engine.test.ts` (33 tests)
- `workspace-fs.test.ts` (19 tests)
- `workspace-runner.test.ts` (17 tests)
- `checkpoint-manager.test.ts` (20 tests)

Additional VFS-adjacent coverage:
- `atomic-apply.test.ts` validates multi-file patching and rollback semantics.
- `path-traversal.test.ts` validates traversal rejection behavior for `DiskWorkspaceFS.applyPatch`.
- `branch-coverage-vfs-pipeline.test.ts` exercises VFS and CoW edge branches.

Observability characteristics in current implementation:
- Sampling captures `durationMs` and error strings per candidate result.
- `WorkspaceRunner.run` returns structured command execution telemetry (`success`, `exitCode`, `stdout`, `stderr`, `timedOut`, `durationMs`, optional `modifiedFiles`).
- Checkpoint paths return discriminated status results (`created`, `deduplicated`, `skipped`, `failed`) instead of throwing for most expected failure modes.
- No dedicated logging/metrics emitter exists in `src/vfs`; observability is primarily through returned result objects and tests.

## Risks and TODOs
- `PatchOptions.bestEffort` is defined on `WorkspaceFS` patch options but is not used by `InMemoryWorkspaceFS` or `DiskWorkspaceFS` implementations.
- `WorkspaceRunner.syncBack` only checks `syncPaths` or original snapshot keys; new files created inside sandbox are not synced unless explicitly included in `syncPaths`.
- `CheckpointManager.ensureCheckpoint` uses `readdir` entry count as a size guard; this is a shallow count heuristic, not a recursive file-count limit.
- `applyPatchSet` rollback writes prior content back via `writeFile`; when a patch creates a new file and later rolls back, behavior depends on writer semantics for empty-string restoration rather than explicit delete-on-rollback.
- `CheckpointManager` is heavily mocked in tests; there is no end-to-end integration test against a real git binary and filesystem state transitions.
- `DiskWorkspaceFS.read` catches all read errors and returns `null`, which intentionally simplifies callers but can hide permission or encoding failures.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: rewrote document against current `packages/codegen/src/vfs` implementation, exports, and test suite.

