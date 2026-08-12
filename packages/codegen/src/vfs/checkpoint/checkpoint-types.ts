export interface CheckpointManagerConfig {
  /** Base directory for shadow repos (default ~/.dzupagent/checkpoints) */
  baseDir?: string
  /** Maximum number of snapshots to keep per directory (default 50) */
  maxSnapshots?: number
  /** Git command timeout in milliseconds (default 30_000) */
  timeoutMs?: number
  /** Maximum admitted files in a tree (default 50_000) */
  maxFiles?: number
  /** Maximum bytes in one admitted regular file or symlink (default 64 MiB) */
  maxFileBytes?: number
  /** Maximum aggregate bytes across admitted files and symlinks (default 512 MiB) */
  maxTotalBytes?: number
  /** Maximum relative path depth (default 64) */
  maxDepth?: number
  /** Maximum UTF-8 bytes in a relative path (default 4_096) */
  maxPathBytes?: number
  /** Maximum buffered stdout/stderr bytes from one Git command (default 4 MiB) */
  maxGitOutputBytes?: number
}

export type CheckpointErrorCode =
  | 'not_found'
  | 'unsafe_input'
  | 'resource_limit'
  | 'corrupt_store'
  | 'ownership_conflict'
  | 'recovery_required'
  | 'compaction_failure'
  | 'legacy_store'
  | 'timeout'
  | 'git_failure'
  | 'io_failure'

export interface CheckpointFailure {
  status: 'failed'
  code: CheckpointErrorCode
  /** Bounded diagnostic that never contains workspace paths or Git output. */
  error: string
}

export type CheckpointResult =
  | { status: 'created'; checkpointId: string }
  | { status: 'deduplicated'; checkpointId: string }
  | { status: 'skipped'; code: 'unsafe_input' | 'resource_limit'; reason: string }
  | CheckpointFailure

export interface CheckpointProof {
  checkpointId: string
  /** SHA-256 identity of the canonical checkpoint root. */
  rootSha256: string
  /** SHA-256 binding of the exact admitted Git tree identity. */
  sourceDigest: string
  /** Monotonic root-local cross-process operation generation. */
  generation: number
}

export type CheckpointDetailedResult =
  | { status: 'created'; checkpointId: string; proof: CheckpointProof }
  | { status: 'deduplicated'; checkpointId: string; proof: CheckpointProof }
  | { status: 'skipped'; code: 'unsafe_input' | 'resource_limit'; reason: string }
  | CheckpointFailure

export interface CheckpointEntry {
  hash: string
  timestamp: string
  reason: string
  summary: string
}

export interface CheckpointDiff {
  added: string[]
  modified: string[]
  deleted: string[]
  stats: { filesChanged: number; insertions: number; deletions: number }
}

export type CheckpointListResult =
  | { status: 'ok'; checkpoints: CheckpointEntry[] }
  | CheckpointFailure

export type CheckpointDiffResult =
  | { status: 'ok'; diff: CheckpointDiff }
  | CheckpointFailure

export type CheckpointRestoreResult =
  | {
      status: 'restored'
      checkpointId: string
      safetyCheckpointId: string
      generation: number
    }
  | CheckpointFailure

export type CheckpointRecoveryState =
  | 'no_worktree_mutation'
  | 'restore_not_started'
  | 'restore_recovery_required'
  | 'target_verified_cleanup_required'
  | 'ambiguous'

export type CheckpointRecoveryInspectionResult =
  | { status: 'clean' }
  | {
      status: 'recovery_required'
      state: CheckpointRecoveryState
      recoveryToken: string
      generation: number | null
    }
  | CheckpointFailure

export interface CheckpointRecoveryAuthorization {
  recoveryToken: string
  /** Must be set only after an external custodian has fenced the old owner. */
  operatorConfirmedAbandoned: true
}

export type CheckpointRecoveryResult =
  | {
      status: 'recovered'
      recoveredState: Exclude<CheckpointRecoveryState, 'ambiguous'>
      generation: number
      restoredCheckpointId?: string
    }
  | CheckpointFailure

export type CheckpointCompactionResult =
  | {
      status: 'compacted'
      generation: number
      retainedCheckpoints: number
      unreachableObjects: 0
    }
  | CheckpointFailure

export interface CheckpointSettings {
  baseDir: string
  maxSnapshots: number
  timeoutMs: number
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxDepth: number
  maxPathBytes: number
  maxGitOutputBytes: number
}

export interface CheckpointStore {
  storeDir: string
  gitDir: string
  workDir: string
}

export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RefRecord {
  ref: string
  hash: string
  timestamp: string
  reason: string
}

export interface TreeAdmission {
  dynamicExcludes: string[]
  files: number
  totalBytes: number
}

export interface SnapshotOutcome {
  store: CheckpointStore
  checkpointId: string
  treeHash: string
  proof: CheckpointProof
  created: boolean
}

export type CheckpointOperation =
  | 'snapshot'
  | 'list'
  | 'diff'
  | 'restore'
  | 'compact'
  | 'recovery'

export interface CheckpointOwnershipRecord {
  version: 1
  rootSha256: string
  ownerNonce: string
  generation: number
  operation: CheckpointOperation
  acquiredAt: string
  expiresAt: string
}

export type CheckpointLease = CheckpointOwnershipRecord

export type CheckpointJournalPhase =
  | 'snapshot_started'
  | 'snapshot_commit_written'
  | 'snapshot_ref_published'
  | 'snapshot_retention_completed'
  | 'restore_started'
  | 'restore_safety_published'
  | 'restore_mutation_started'
  | 'restore_target_verified'
  | 'compaction_started'
  | 'compaction_verified'

export interface CheckpointJournalRecord {
  version: 1
  rootSha256: string
  ownerNonce: string
  generation: number
  operation: 'snapshot' | 'restore' | 'compact'
  phase: CheckpointJournalPhase
  checkpointId?: string
  targetCheckpointId?: string
  safetyCheckpointId?: string
  sourceDigest?: string
}
