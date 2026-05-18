# VFS Architecture (`packages/codegen/src/vfs`)

## Scope
This document describes the current implementation under `packages/codegen/src/vfs`:

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

It also covers how this surface is exposed through `src/index.ts` and `src/vfs.ts`, and where it is consumed in the surrounding `@dzupagent/codegen` package.

## Responsibilities
The VFS layer is the file-state and patch/execution substrate for codegen workflows. It is responsible for:

- In-memory file storage and diffing via `VirtualFS`.
- Copy-on-write for speculative edits via `CopyOnWriteVFS`.
- Parallel attempt orchestration and winner commit (`sample`, `selectBest`, `commitBest`, `sampleAndCommitBest`).
- Parsing and applying unified diffs (`parseUnifiedDiff`, `applyPatch`, `applyPatchSet`).
- Providing a backend-neutral file workspace interface (`WorkspaceFS`) with in-memory, disk, and worktree-backed implementations.
- Bridging a `VirtualFS` snapshot into sandbox command execution (`WorkspaceRunner`).
- Persisting snapshots through a caller-provided store contract (`SnapshotStore`).
- Creating rollback checkpoints on real directories using isolated shadow git repositories (`CheckpointManager`).
- Enforcing workspace root confinement for disk operations (`PathSecurityError` in `DiskWorkspaceFS.resolveSafe`).

## Structure
- `virtual-fs.ts`
  - Defines `VirtualFS` and `FileDiff`.
  - Map-backed file CRUD, listing, snapshot import/export, diff, and merge.
- `vfs-types.ts`
  - Shared type contracts for CoW and sampling: `MergeStrategy`, `MergeConflict`, `MergeResult`, `VFSDiff`, `SampleResult<T>`.
- `cow-vfs.ts`
  - Defines `CopyOnWriteVFS`.
  - Overlay + delete mask over parent VFS chain, conflict detection, merge strategies, and `MAX_FORK_DEPTH = 3`.
- `parallel-sampling.ts`
  - Sampling orchestration over `CopyOnWriteVFS`.
  - Enforces sample count bounds (`1..10`) and captures `durationMs` plus optional `error`.
- `patch-engine.ts`
  - Unified diff parser (`parseUnifiedDiff`) and hunk applier (`applyPatch`).
  - Multi-file orchestration with optional rollback (`applyPatchSet`).
  - Typed error model including `PatchParseError`.
- `workspace-fs.ts`
  - `WorkspaceFS` interface and patch options/result contracts.
  - Implementations: `InMemoryWorkspaceFS`, `DiskWorkspaceFS`, `GitWorktreeWorkspaceFS`.
- `workspace-runner.ts`
  - `WorkspaceRunner` for snapshot upload, command execution, optional sync-back, and availability/cleanup delegation.
- `vfs-snapshot.ts`
  - Snapshot persistence contract (`SnapshotStore`) and non-throwing save/load wrappers.
- `checkpoint-manager.ts`
  - Checkpoint creation/list/diff/restore against a shadow git repo keyed by target directory hash.
- `path-security-error.ts`
  - Dedicated traversal error class carrying attempted path and workspace root.

## Runtime and Control Flow
1. In-memory edit flow
- Callers mutate `VirtualFS` with `write`, `read`, `delete`, and `list`.
- `toSnapshot()` and `VirtualFS.fromSnapshot()` move state across pipeline boundaries.
- `diff` and `merge` provide simple file-level reconciliation.

2. Copy-on-write speculative flow
- A `CopyOnWriteVFS` wraps `VirtualFS` (or another CoW fork) with isolated overlay and deletion masking.
- `fork()` creates nested forks up to depth 3.
- `merge(strategy)` writes selected child changes back to parent (`theirs` default, `ours`, or conflict-only `manual`).

3. Parallel sampling flow
- `sample` or `sampleAndCommitBest` forks a source `VirtualFS` `N` times.
- Each fork runs independently through caller logic and returns a `SampleResult<T>`.
- `selectBest` ignores errored samples and picks the highest scorer.
- `commitBest` merges winner changes to parent using `theirs`.

4. Unified patch flow
- `parseUnifiedDiff` turns text patches into `FilePatch[]`.
- `applyPatch` applies each hunk with context matching and fuzz search (up to `MAX_FUZZ = 3`), returning per-hunk outcomes.
- `applyPatchSet` applies multi-file patches with optional rollback via `rollbackOnFailure`.
- `WorkspaceFS.applyPatch` implementations delegate to this patch engine.

5. Workspace abstraction flow
- `InMemoryWorkspaceFS` forwards directly to `VirtualFS`.
- `DiskWorkspaceFS` resolves all paths against a root and rejects traversal via `PathSecurityError`.
- `GitWorktreeWorkspaceFS` is a thin adapter around `DiskWorkspaceFS` rooted at an externally managed worktree directory.

6. Sandbox execution flow
- `WorkspaceRunner.run` snapshots `VirtualFS`, uploads all files to `SandboxProtocol`, executes command, and returns structured execution results.
- If `syncBack` is enabled, it downloads selected paths and writes changed content back into `VirtualFS`.

7. Checkpoint flow
- `CheckpointManager.ensureCheckpoint` performs per-turn dedup, safety checks, and size checks before snapshotting.
- Snapshots are git commits in a shadow repo using `GIT_DIR` and `GIT_WORK_TREE`.
- `list` reads commit history, `diff` compares checkpoint to current state, and `restore` snapshots current state then checks out target checkpoint content.

## Key APIs and Types
Core state:
- `VirtualFS`
  - `write(path, content)`, `read(path)`, `exists(path)`, `delete(path)`, `list(directory?)`, `size`
  - `toSnapshot()`, `VirtualFS.fromSnapshot(snapshot)`
  - `diff(other)`, `merge(other)`
- `FileDiff`

Copy-on-write and sampling:
- `CopyOnWriteVFS`
  - `fork(label?)`, `merge(strategy?)`, `conflicts(other)`, `diff()`, `forkDelta()`, `detach()`
  - `getModifiedFiles()`, `getDeletedFiles()`, `toSnapshot()`, `depth`, `label`
- `MergeStrategy`, `MergeConflict`, `MergeResult`, `VFSDiff`, `SampleResult<T>`
- `sample`, `selectBest`, `commitBest`, `sampleAndCommitBest`

Patching:
- `parseUnifiedDiff(diff: string): FilePatch[]`
- `applyPatch(content: string, patch: FilePatch): PatchApplyResult`
- `applyPatchSet(patches, readFile, writeFile, options?)`
- `PatchParseError`
- `PatchErrorCode`, `PatchLine`, `PatchHunk`, `FilePatch`, `HunkResult`, `PatchApplyResult`, `ApplyPatchSetOptions`

Workspace adapters:
- `WorkspaceFS`
- `InMemoryWorkspaceFS`, `DiskWorkspaceFS`, `GitWorktreeWorkspaceFS`
- `PatchOptions`, `WorkspacePatchResult`
- `PathSecurityError` (internal source file; not part of the package export surface)

Execution and persistence:
- `WorkspaceRunner`, `WorkspaceRunOptions`, `WorkspaceRunResult`
- `SnapshotStore`, `saveSnapshot`, `loadSnapshot`, `SnapshotSaveResult`, `SnapshotLoadResult`
- `CheckpointManager`, `CheckpointManagerConfig`, `CheckpointResult`, `CheckpointEntry`, `CheckpointDiff`

## Dependencies
Internal module dependencies:
- `cow-vfs.ts` depends on `virtual-fs.ts` and `vfs-types.ts`.
- `parallel-sampling.ts` depends on `cow-vfs.ts` and `vfs-types.ts`.
- `workspace-fs.ts` depends on `patch-engine.ts` and `path-security-error.ts`.
- `workspace-runner.ts` depends on `../sandbox/sandbox-protocol.ts`.

Node runtime dependencies used directly in `src/vfs`:
- `node:fs/promises`
- `node:path`
- `node:child_process`
- `node:crypto`
- `node:util`

Package dependency note:
- `@dzupagent/codegen` depends on `@dzupagent/core` and `@dzupagent/adapter-types`, but `src/vfs/*` does not directly import those packages.

## Integration Points
Package exports:
- VFS APIs are exported from both `src/index.ts` and the dedicated subpath facade `src/vfs.ts` (published as `@dzupagent/codegen/vfs` via package exports).
- `path-security-error.ts` exists as source but is not exported through `src/index.ts` or `src/vfs.ts`.

In-package consumers:
- `tools/edit-file.tool.ts` supports `VirtualFS` directly and also workspace-backed reads/writes through `CodegenToolContext.workspace`.
- `tools/multi-edit.tool.ts` edits `VirtualFS` directly.
- `tools/tool-context.ts` carries optional `vfs` and `workspace` handles for tool routing.
- `validation/import-validator.ts` reads from `VirtualFS` for import graph checks.

Cross-package consumers in this monorepo:
- `packages/code-edit-kit` imports `WorkspaceFS` types and in tests uses `InMemoryWorkspaceFS` + `VirtualFS` from `@dzupagent/codegen`.
- `packages/server` and `packages/evals` import `@dzupagent/codegen` for runtime/tool contracts, but they do not import `src/vfs/*` internals directly.

Related but separate workspace layer:
- `src/workspace/*` defines a distinct `Workspace` abstraction and its own `WorkspacePathSecurityError`; this is separate from `src/vfs/path-security-error.ts`.

## Testing and Observability
VFS-focused coverage is implemented in:
- `src/__tests__/vfs.test.ts`
- `src/__tests__/vfs-snapshot.test.ts`
- `src/__tests__/vfs/cow-vfs.test.ts`
- `src/__tests__/vfs/cow-vfs-extended.test.ts`
- `src/__tests__/vfs/parallel-sampling.test.ts`
- `src/__tests__/patch-engine.test.ts`
- `src/__tests__/workspace-fs.test.ts`
- `src/__tests__/workspace-runner.test.ts`
- `src/__tests__/checkpoint-manager.test.ts`

VFS-adjacent behavior tests:
- `src/__tests__/atomic-apply.test.ts` for patch rollback behavior.
- `src/__tests__/path-traversal.test.ts` for traversal rejection in `DiskWorkspaceFS.applyPatch`.
- `src/__tests__/branch-coverage-vfs-pipeline.test.ts` for VFS/CoW edge branches.

Observability characteristics in code:
- Sampling returns timing and captured errors per attempt (`SampleResult.durationMs`, optional `error`).
- `WorkspaceRunner.run` returns structured execution telemetry (`success`, `exitCode`, `stdout`, `stderr`, `timedOut`, `durationMs`, optional `modifiedFiles`).
- Checkpoint operations return discriminated result objects (`created`, `deduplicated`, `skipped`, `failed`) rather than throwing for most expected failures.
- The module has no dedicated logger or metrics sink; returned result payloads are the primary runtime signal surface.

## Risks and TODOs
- `PatchOptions.bestEffort` is defined but not used in either `InMemoryWorkspaceFS.applyPatch` or `DiskWorkspaceFS.applyPatch`.
- `InMemoryWorkspaceFS.applyPatch` does not set a default `rollbackOnFailure`; behavior comes from `applyPatchSet` default (`false`), while `DiskWorkspaceFS` defaults to `true`.
- `WorkspaceRunner.syncBack` only downloads `syncPaths` or original snapshot keys; files created during sandbox execution are not synced unless explicitly listed.
- `DiskWorkspaceFS.read` and `DiskWorkspaceFS.delete` swallow all errors and return `null`/`false`, which simplifies callers but hides specific IO failures.
- `CheckpointManager.ensureCheckpoint` uses shallow `readdir` entry count for `maxFiles`; this is not a recursive size guard.
- `CheckpointManager.pruneOldSnapshots` uses a `rebase --onto` strategy and treats pruning failures as non-fatal, so retention enforcement can silently drift.
- Checkpoint tests heavily mock git and filesystem calls; there is no end-to-end suite here that validates real git process behavior on disk.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: rewrote document against current `packages/codegen/src/vfs` source, exports, and test surface.

