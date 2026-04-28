/**
 * @dzupagent/codegen/vfs — virtual filesystem facade.
 */

export { VirtualFS } from './vfs/virtual-fs.js'
export type { FileDiff } from './vfs/virtual-fs.js'
export { saveSnapshot, loadSnapshot } from './vfs/vfs-snapshot.js'
export type { SnapshotStore, SnapshotSaveResult, SnapshotLoadResult } from './vfs/vfs-snapshot.js'
export { CheckpointManager } from './vfs/checkpoint-manager.js'
export type { CheckpointManagerConfig, CheckpointEntry, CheckpointDiff, CheckpointResult } from './vfs/checkpoint-manager.js'
export { CopyOnWriteVFS } from './vfs/cow-vfs.js'
export type { MergeStrategy, MergeConflict, MergeResult, VFSDiff, SampleResult } from './vfs/vfs-types.js'
export { sample, selectBest, commitBest, sampleAndCommitBest } from './vfs/parallel-sampling.js'
export { parseUnifiedDiff, applyPatch, applyPatchSet, PatchParseError } from './vfs/patch-engine.js'
export type {
  PatchErrorCode,
  PatchHunk,
  PatchLine,
  FilePatch,
  HunkResult,
  PatchApplyResult,
  ApplyPatchSetOptions,
} from './vfs/patch-engine.js'
export { WorkspaceRunner } from './vfs/workspace-runner.js'
export type { WorkspaceRunResult, WorkspaceRunOptions } from './vfs/workspace-runner.js'
export { InMemoryWorkspaceFS, DiskWorkspaceFS, GitWorktreeWorkspaceFS } from './vfs/workspace-fs.js'
export type { WorkspaceFS, PatchOptions, WorkspacePatchResult } from './vfs/workspace-fs.js'

