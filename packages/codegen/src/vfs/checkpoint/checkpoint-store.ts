import { CheckpointInternalError } from './checkpoint-errors.js'
import {
  CheckpointJournalController,
  classifyJournal,
} from './checkpoint-journal.js'
import type { JournalInspection } from './checkpoint-journal.js'
import {
  CheckpointOwnershipController,
  checkpointRecoveryToken,
} from './checkpoint-ownership.js'
import type { LockInspection } from './checkpoint-ownership.js'
import type { CheckpointPolicy } from './checkpoint-policy.js'
import {
  CheckpointRepository,
  checkpointSourceDigest,
} from './checkpoint-repository.js'
import { emitCheckpointTestPhase } from './checkpoint-test-hooks.js'
import type {
  CheckpointCompactionResult,
  CheckpointDiff,
  CheckpointEntry,
  CheckpointLease,
  CheckpointOperation,
  CheckpointProof,
  CheckpointRecoveryAuthorization,
  CheckpointRecoveryInspectionResult,
  CheckpointRecoveryResult,
  CheckpointRecoveryState,
  CheckpointSettings,
  CheckpointStore,
  SnapshotOutcome,
} from './checkpoint-types.js'

interface RecoveryInspection {
  store: CheckpointStore
  lock: LockInspection
  journal: JournalInspection
  state: CheckpointRecoveryState
  token: string
  generation: number | null
}

export class CheckpointStoreController {
  private readonly journal = new CheckpointJournalController()
  private readonly ownership = new CheckpointOwnershipController()
  private readonly repository: CheckpointRepository

  constructor(
    settings: CheckpointSettings,
    private readonly policy: CheckpointPolicy,
  ) {
    this.repository = new CheckpointRepository(settings, policy, this.ownership)
  }

  async snapshot(canonicalRoot: string, reason: string): Promise<SnapshotOutcome> {
    const admission = await this.policy.scanAdmittedTree(canonicalRoot)
    return this.withOwnedOperation(canonicalRoot, 'snapshot', async (store, lease) => {
      await this.journal.write(store, lease, 'snapshot_started')
      const snapshot = await this.repository.createSnapshot(
        canonicalRoot,
        reason,
        store,
        lease,
        {
          commitWrittenPhase: 'snapshot_commit_object_written',
          refWrittenPhase: 'snapshot_ref_written',
          commitWritten: async (checkpointId, treeHash) => {
            await this.journal.write(store, lease, 'snapshot_commit_written', {
              checkpointId,
              sourceDigest: checkpointSourceDigest(treeHash),
            })
          },
          refPublished: async (checkpointId, treeHash) => {
            await this.journal.write(store, lease, 'snapshot_ref_published', {
              checkpointId,
              sourceDigest: checkpointSourceDigest(treeHash),
            })
          },
        },
        admission,
      )
      await this.repository.pruneOldSnapshots(store, lease)
      await this.journal.write(store, lease, 'snapshot_retention_completed', {
        checkpointId: snapshot.checkpointId,
        sourceDigest: snapshot.proof.sourceDigest,
      })
      await this.journal.clear(store)
      return snapshot
    })
  }

  async list(canonicalRoot: string): Promise<CheckpointEntry[]> {
    return this.withOwnedOperation(
      canonicalRoot,
      'list',
      (store) => this.repository.listEntries(store),
    )
  }

  async verifyProof(
    canonicalRoot: string,
    proof: CheckpointProof,
  ): Promise<CheckpointProof | null> {
    return this.withOwnedOperation(canonicalRoot, 'list', async (store, lease) => {
      const checkpointTree = await this.repository.validateCheckpoint(store, proof.checkpointId)
      if (checkpointSourceDigest(checkpointTree) !== proof.sourceDigest) {
        throw new CheckpointInternalError(
          'corrupt_store',
          'checkpoint proof does not match its stored tree',
        )
      }
      const currentTree = await this.repository.stageAndWriteCurrentTree(store)
      if (currentTree !== checkpointTree) return null
      return { ...proof, rootSha256: lease.rootSha256, generation: lease.generation }
    })
  }

  async diff(canonicalRoot: string, checkpointHash: string): Promise<CheckpointDiff> {
    return this.withOwnedOperation(canonicalRoot, 'diff', async (store) => {
      const admission = await this.policy.scanAdmittedTree(canonicalRoot)
      return this.repository.diffCurrent(store, checkpointHash, admission)
    })
  }

  async restore(
    canonicalRoot: string,
    checkpointHash: string,
  ): Promise<{ checkpointId: string; safetyCheckpointId: string; generation: number }> {
    return this.withOwnedOperation(canonicalRoot, 'restore', async (store, lease) => {
      const targetTree = await this.repository.validateCheckpoint(store, checkpointHash)
      await this.journal.write(store, lease, 'restore_started', {
        targetCheckpointId: checkpointHash,
        sourceDigest: checkpointSourceDigest(targetTree),
      })

      let safety: SnapshotOutcome | null = null
      let mutationStarted = false
      try {
        safety = await this.repository.createSnapshot(
          canonicalRoot,
          `pre-restore ${checkpointHash.slice(0, 12)}`,
          store,
          lease,
          { refWrittenPhase: 'restore_safety_ref_written' },
        )
        await this.journal.write(store, lease, 'restore_safety_published', {
          targetCheckpointId: checkpointHash,
          safetyCheckpointId: safety.checkpointId,
          sourceDigest: checkpointSourceDigest(targetTree),
        })

        const admission = await this.policy.scanAdmittedTree(store.workDir)
        await this.journal.write(store, lease, 'restore_mutation_started', {
          targetCheckpointId: checkpointHash,
          safetyCheckpointId: safety.checkpointId,
          sourceDigest: checkpointSourceDigest(targetTree),
        })
        mutationStarted = true
        await this.ownership.assertOwned(store, lease)
        await this.repository.applyTree(store, targetTree, admission.dynamicExcludes)
        await emitCheckpointTestPhase('restore_tree_applied')
        if (await this.repository.stageAndWriteCurrentTree(store) !== targetTree) {
          throw new CheckpointInternalError(
            'corrupt_store',
            'restored checkpoint tree did not match its admitted target',
          )
        }
        await this.journal.write(store, lease, 'restore_target_verified', {
          targetCheckpointId: checkpointHash,
          safetyCheckpointId: safety.checkpointId,
          sourceDigest: checkpointSourceDigest(targetTree),
        })
      } catch (restoreError: unknown) {
        if (!mutationStarted) {
          await this.journal.clear(store)
          throw restoreError
        }
        try {
          if (!safety) throw new Error('missing safety checkpoint')
          const safetyTree = await this.repository.validateCheckpoint(store, safety.checkpointId)
          await this.repository.applyTree(store, safetyTree)
          if (await this.repository.stageAndWriteCurrentTree(store) !== safetyTree) {
            throw new Error('safety recovery mismatch')
          }
          await this.journal.clear(store)
        } catch {
          throw new CheckpointInternalError(
            'recovery_required',
            'checkpoint restore and safety recovery require operator recovery',
          )
        }
        throw restoreError
      }

      await this.repository.pruneOldSnapshots(store, lease)
      await this.journal.clear(store)
      return {
        checkpointId: checkpointHash,
        safetyCheckpointId: safety.checkpointId,
        generation: lease.generation,
      }
    })
  }

  async inspectRecovery(canonicalRoot: string): Promise<CheckpointRecoveryInspectionResult> {
    const inspection = await this.buildRecoveryInspection(canonicalRoot)
    if (inspection.lock.kind === 'absent' && inspection.journal.kind === 'absent') {
      return { status: 'clean' }
    }
    return {
      status: 'recovery_required',
      state: inspection.state,
      recoveryToken: inspection.token,
      generation: inspection.generation,
    }
  }

  async recover(
    canonicalRoot: string,
    authorization: CheckpointRecoveryAuthorization,
  ): Promise<CheckpointRecoveryResult> {
    if (
      !authorization
      || authorization.operatorConfirmedAbandoned !== true
      || !/^[0-9a-f]{64}$/.test(authorization.recoveryToken)
    ) {
      throw new CheckpointInternalError('unsafe_input', 'checkpoint recovery authorization is invalid')
    }

    const admitted = await this.buildRecoveryInspection(canonicalRoot)
    if (admitted.lock.kind === 'absent' && admitted.journal.kind === 'absent') {
      throw new CheckpointInternalError('not_found', 'checkpoint recovery state does not exist')
    }
    if (admitted.state === 'ambiguous') {
      throw new CheckpointInternalError(
        'recovery_required',
        'checkpoint recovery state is ambiguous and requires manual repair',
      )
    }
    if (authorization.recoveryToken !== admitted.token) {
      throw new CheckpointInternalError('unsafe_input', 'checkpoint recovery token does not match')
    }

    await this.ownership.quarantineAbandoned(
      admitted.store,
      admitted.lock.digest,
    )
    const lease = await this.ownership.acquire(
      admitted.store,
      this.policy.rootSha256(canonicalRoot),
      'recovery',
    )
    try {
      const journal = await this.journal.inspect(admitted.store)
      if (journal.digest !== admitted.journal.digest) {
        throw new CheckpointInternalError(
          'recovery_required',
          'checkpoint journal changed during recovery admission',
        )
      }
      await this.repository.initialize(admitted.store, lease)
      const restoredCheckpointId = await this.recoverJournal(
        admitted.store,
        lease,
        admitted.state,
        journal,
      )
      await this.ownership.removeAllQuarantines(admitted.store)
      await this.journal.clear(admitted.store)
      return {
        status: 'recovered',
        recoveredState: admitted.state,
        generation: lease.generation,
        ...(restoredCheckpointId ? { restoredCheckpointId } : {}),
      }
    } finally {
      await this.ownership.release(admitted.store, lease)
    }
  }

  async compact(canonicalRoot: string): Promise<CheckpointCompactionResult> {
    return this.withOwnedOperation(canonicalRoot, 'compact', async (store, lease) => {
      await this.journal.write(store, lease, 'compaction_started')
      try {
        const result = await this.repository.compact(store, lease)
        await this.journal.write(store, lease, 'compaction_verified')
        await this.journal.clear(store)
        return { status: 'compacted', generation: lease.generation, ...result }
      } catch (error: unknown) {
        if (
          error instanceof CheckpointInternalError
          && ['ownership_conflict', 'recovery_required'].includes(error.code)
        ) throw error
        throw new CheckpointInternalError(
          'compaction_failure',
          'checkpoint physical compaction failed',
        )
      }
    })
  }

  private async withOwnedOperation<T>(
    canonicalRoot: string,
    operation: CheckpointOperation,
    callback: (store: CheckpointStore, lease: CheckpointLease) => Promise<T>,
  ): Promise<T> {
    const store = await this.policy.prepareStore(canonicalRoot)
    const lease = await this.ownership.acquire(
      store,
      this.policy.rootSha256(canonicalRoot),
      operation,
    )
    let outcome: T | undefined
    let operationError: unknown
    try {
      await this.journal.assertClean(store)
      await this.repository.initialize(store, lease)
      outcome = await callback(store, lease)
    } catch (error: unknown) {
      operationError = error
    }
    await this.ownership.release(store, lease)
    if (operationError) throw operationError
    return outcome as T
  }

  private async buildRecoveryInspection(canonicalRoot: string): Promise<RecoveryInspection> {
    const store = await this.policy.prepareStore(canonicalRoot)
    const [lock, journal] = await Promise.all([
      this.ownership.inspect(store),
      this.journal.inspect(store),
    ])
    const rootSha256 = this.policy.rootSha256(canonicalRoot)
    const recordsMatchRoot = (lock.kind !== 'valid' || lock.record.rootSha256 === rootSha256)
      && (journal.kind !== 'valid' || journal.record.rootSha256 === rootSha256)
    const recordsMatchOwner = lock.kind !== 'valid'
      || journal.kind !== 'valid'
      || (
        lock.record.ownerNonce === journal.record.ownerNonce
        && lock.record.generation === journal.record.generation
        && lock.record.operation === journal.record.operation
      )
      || (
        lock.record.operation === 'recovery'
        && lock.record.generation > journal.record.generation
      )
    const state = lock.kind === 'corrupt'
      || !recordsMatchRoot
      || !recordsMatchOwner
      ? 'ambiguous'
      : classifyJournal(journal)
    return {
      store,
      lock,
      journal,
      state,
      token: checkpointRecoveryToken(rootSha256, lock.digest, journal.digest),
      generation: lock.kind === 'valid'
        ? lock.record.generation
        : journal.kind === 'valid' ? journal.record.generation : null,
    }
  }

  private async recoverJournal(
    store: CheckpointStore,
    lease: CheckpointLease,
    state: Exclude<CheckpointRecoveryState, 'ambiguous'>,
    inspection: JournalInspection,
  ): Promise<string | null> {
    const record = inspection.kind === 'valid' ? inspection.record : null
    if (!record) return null

    if (state === 'restore_recovery_required') {
      if (!record.safetyCheckpointId) {
        throw new CheckpointInternalError(
          'recovery_required',
          'checkpoint safety identity is missing during recovery',
        )
      }
      const safetyTree = await this.repository.validateCheckpoint(
        store,
        record.safetyCheckpointId,
      )
      await this.ownership.assertOwned(store, lease)
      await this.repository.applyTree(store, safetyTree)
      await emitCheckpointTestPhase('recovery_tree_applied')
      if (await this.repository.stageAndWriteCurrentTree(store) !== safetyTree) {
        throw new CheckpointInternalError(
          'recovery_required',
          'checkpoint safety recovery could not be verified',
        )
      }
      return record.safetyCheckpointId
    }

    if (state === 'target_verified_cleanup_required') {
      if (!record.targetCheckpointId) {
        throw new CheckpointInternalError(
          'recovery_required',
          'checkpoint target identity is missing during recovery',
        )
      }
      const targetTree = await this.repository.validateCheckpoint(
        store,
        record.targetCheckpointId,
      )
      if (await this.repository.stageAndWriteCurrentTree(store) !== targetTree) {
        throw new CheckpointInternalError(
          'recovery_required',
          'verified checkpoint target changed before cleanup',
        )
      }
      await this.repository.pruneOldSnapshots(store, lease)
      return null
    }

    if (record.phase === 'snapshot_ref_published' && record.checkpointId) {
      await this.repository.validateCheckpoint(store, record.checkpointId)
      await this.repository.pruneOldSnapshots(store, lease)
    } else if (record.phase === 'snapshot_retention_completed' && record.checkpointId) {
      await this.repository.validateCheckpoint(store, record.checkpointId)
    } else if (record.phase === 'restore_safety_published' && record.safetyCheckpointId) {
      await this.repository.validateCheckpoint(store, record.safetyCheckpointId)
    } else if (record.operation === 'compact') {
      await this.repository.compact(store, lease)
    }
    return null
  }
}
