/**
 * Filesystem checkpoint manager using root-bound shadow Git repositories.
 *
 * Checkpoints are independent commits referenced below
 * `refs/dzupagent/checkpoints/`. Each operation uses an isolated Git index so
 * checkpointing never mutates the user's repository index or a shared shadow
 * index. Sensitive and generated paths are excluded before Git object creation.
 */
import {
  createCheckpointSettings,
  failureFrom,
  normalizeReason,
  serializeRoot,
  skippedOrFailed,
} from './checkpoint/checkpoint-errors.js'
import { CheckpointPolicy } from './checkpoint/checkpoint-policy.js'
import { CheckpointStoreController } from './checkpoint/checkpoint-store.js'
import type {
  CheckpointDiff,
  CheckpointDiffResult,
  CheckpointCompactionResult,
  CheckpointDetailedResult,
  CheckpointEntry,
  CheckpointListResult,
  CheckpointManagerConfig,
  CheckpointProof,
  CheckpointRecoveryAuthorization,
  CheckpointRecoveryInspectionResult,
  CheckpointRecoveryResult,
  CheckpointRestoreResult,
  CheckpointResult,
} from './checkpoint/checkpoint-types.js'

export type {
  CheckpointManagerConfig,
  CheckpointErrorCode,
  CheckpointFailure,
  CheckpointEntry,
  CheckpointDiff,
  CheckpointResult,
  CheckpointProof,
  CheckpointDetailedResult,
  CheckpointListResult,
  CheckpointDiffResult,
  CheckpointRestoreResult,
  CheckpointRecoveryState,
  CheckpointRecoveryInspectionResult,
  CheckpointRecoveryAuthorization,
  CheckpointRecoveryResult,
  CheckpointCompactionResult,
} from './checkpoint/checkpoint-types.js'

/**
 * Root-bound shadow-Git checkpoint manager.
 *
 * @experimental Operational rollback readiness requires package and adopter
 * qualification. Callers must treat every non-success result as a hard stop
 * before protected mutation.
 */
export class CheckpointManager {
  private readonly policy: CheckpointPolicy
  private readonly store: CheckpointStoreController
  /** Tracks successful snapshots for per-turn deduplication. */
  private turnSnapshots = new Map<string, CheckpointProof>()

  constructor(config?: CheckpointManagerConfig) {
    const settings = createCheckpointSettings(config)
    this.policy = new CheckpointPolicy(settings)
    this.store = new CheckpointStoreController(settings, this.policy)
  }

  /** Allow a new successful checkpoint for each canonical root. */
  newTurn(): void {
    this.turnSnapshots.clear()
  }

  /**
   * Ensure a checkpoint exists for this directory in the current turn.
   *
   * This method never throws for runtime failures. A failed or skipped result
   * is not permission to continue a protected mutation.
   */
  async ensureCheckpoint(workDir: string, reason: string): Promise<CheckpointResult> {
    const result = await this.ensureCheckpointDetailed(workDir, reason)
    if (result.status === 'created' || result.status === 'deduplicated') {
      return { status: result.status, checkpointId: result.checkpointId }
    }
    return result
  }

  /** Create or reuse a checkpoint with a source/root/generation proof. */
  async ensureCheckpointDetailed(
    workDir: string,
    reason: string,
  ): Promise<CheckpointDetailedResult> {
    try {
      const canonicalRoot = await this.policy.canonicalizeRoot(workDir)
      return await serializeRoot(canonicalRoot, async () => {
        const prior = this.turnSnapshots.get(canonicalRoot)
        if (prior) {
          const verified = await this.store.verifyProof(canonicalRoot, prior)
          if (!verified) this.turnSnapshots.delete(canonicalRoot)
          else {
            this.turnSnapshots.set(canonicalRoot, verified)
            return {
              status: 'deduplicated',
              checkpointId: verified.checkpointId,
              proof: verified,
            }
          }
        }
        const snapshot = await this.store.snapshot(canonicalRoot, normalizeReason(reason))
        this.turnSnapshots.set(canonicalRoot, snapshot.proof)
        return snapshot.created
          ? { status: 'created', checkpointId: snapshot.checkpointId, proof: snapshot.proof }
          : { status: 'deduplicated', checkpointId: snapshot.checkpointId, proof: snapshot.proof }
      })
    } catch (error: unknown) {
      return skippedOrFailed(error)
    }
  }

  /** List checkpoints with a typed failure outcome. */
  async listDetailed(workDir: string): Promise<CheckpointListResult> {
    try {
      const canonicalRoot = await this.policy.canonicalizeRoot(workDir)
      const checkpoints = await serializeRoot(
        canonicalRoot,
        () => this.store.list(canonicalRoot),
      )
      return { status: 'ok', checkpoints }
    } catch (error: unknown) {
      return failureFrom(error)
    }
  }

  /** Compatibility wrapper. Prefer listDetailed when failure identity matters. */
  async list(workDir: string): Promise<CheckpointEntry[]> {
    const result = await this.listDetailed(workDir)
    return result.status === 'ok' ? result.checkpoints : []
  }

  /** Compare a checkpoint with the explicitly staged current admitted tree. */
  async diffDetailed(
    workDir: string,
    checkpointHash: string,
  ): Promise<CheckpointDiffResult> {
    try {
      const canonicalRoot = await this.policy.canonicalizeRoot(workDir)
      const diff = await serializeRoot(
        canonicalRoot,
        () => this.store.diff(canonicalRoot, checkpointHash),
      )
      return { status: 'ok', diff }
    } catch (error: unknown) {
      return failureFrom(error)
    }
  }

  /** Compatibility wrapper. Prefer diffDetailed when failure identity matters. */
  async diff(workDir: string, checkpointHash: string): Promise<CheckpointDiff | null> {
    const result = await this.diffDetailed(workDir, checkpointHash)
    return result.status === 'ok' ? result.diff : null
  }

  /** Restore exactly the admitted target tree after a successful safety snapshot. */
  async restoreDetailed(
    workDir: string,
    checkpointHash: string,
  ): Promise<CheckpointRestoreResult> {
    try {
      const canonicalRoot = await this.policy.canonicalizeRoot(workDir)
      const restored = await serializeRoot(
        canonicalRoot,
        () => this.store.restore(canonicalRoot, checkpointHash),
      )
      return { status: 'restored', ...restored }
    } catch (error: unknown) {
      return failureFrom(error)
    }
  }

  /** Compatibility wrapper. Prefer restoreDetailed for fail-closed callers. */
  async restore(workDir: string, checkpointHash: string): Promise<boolean> {
    return (await this.restoreDetailed(workDir, checkpointHash)).status === 'restored'
  }

  /** Inspect bounded structural state left by an interrupted operation. */
  async inspectRecoveryDetailed(
    workDir: string,
  ): Promise<CheckpointRecoveryInspectionResult> {
    try {
      const canonicalRoot = await this.policy.canonicalizeRoot(workDir)
      return await serializeRoot(
        canonicalRoot,
        () => this.store.inspectRecovery(canonicalRoot),
      )
    } catch (error: unknown) {
      return failureFrom(error)
    }
  }

  /** Recover only after an external custodian has fenced the abandoned owner. */
  async recoverDetailed(
    workDir: string,
    authorization: CheckpointRecoveryAuthorization,
  ): Promise<CheckpointRecoveryResult> {
    try {
      const canonicalRoot = await this.policy.canonicalizeRoot(workDir)
      return await serializeRoot(
        canonicalRoot,
        () => this.store.recover(canonicalRoot, authorization),
      )
    } catch (error: unknown) {
      return failureFrom(error)
    }
  }

  /** Run explicit, exclusively owned physical object compaction. */
  async compactDetailed(workDir: string): Promise<CheckpointCompactionResult> {
    try {
      const canonicalRoot = await this.policy.canonicalizeRoot(workDir)
      return await serializeRoot(
        canonicalRoot,
        () => this.store.compact(canonicalRoot),
      )
    } catch (error: unknown) {
      return failureFrom(error)
    }
  }
}
