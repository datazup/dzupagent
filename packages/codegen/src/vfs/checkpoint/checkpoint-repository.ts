import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { CheckpointInternalError, isFullObjectId } from './checkpoint-errors.js'
import { CheckpointGit } from './checkpoint-git.js'
import type { CheckpointOwnershipController } from './checkpoint-ownership.js'
import { buildAddArgs } from './checkpoint-policy.js'
import type { CheckpointPolicy } from './checkpoint-policy.js'
import { emitCheckpointTestPhase } from './checkpoint-test-hooks.js'
import type { CheckpointTestPhase } from './checkpoint-test-hooks.js'
import { parseCheckpointDiff, validateStoredTreeOutput } from './checkpoint-tree.js'
import type {
  CheckpointDiff,
  CheckpointEntry,
  CheckpointLease,
  CheckpointProof,
  CheckpointSettings,
  CheckpointStore,
  RefRecord,
  SnapshotOutcome,
  TreeAdmission,
} from './checkpoint-types.js'

const CHECKPOINT_REFS = 'refs/dzupagent/checkpoints/'

export function checkpointSourceDigest(treeHash: string): string {
  return createHash('sha256')
    .update(`checkpoint-source-v1\0${treeHash}`)
    .digest('hex')
}

export class CheckpointRepository {
  private readonly git: CheckpointGit

  constructor(
    private readonly settings: CheckpointSettings,
    private readonly policy: CheckpointPolicy,
    private readonly ownership: CheckpointOwnershipController,
  ) {
    this.git = new CheckpointGit(settings)
  }

  async initialize(store: CheckpointStore, lease: CheckpointLease): Promise<void> {
    await this.ownership.assertOwned(store, lease)
    await mkdir(store.gitDir, { recursive: true, mode: 0o700 })
    const gitStat = await lstat(store.gitDir)
    if (
      !gitStat.isDirectory()
      || (gitStat.mode & 0o077) !== 0
      || await realpath(store.gitDir) !== store.gitDir
    ) {
      throw new CheckpointInternalError(
        'corrupt_store',
        'checkpoint Git store path or permissions do not match policy',
      )
    }
    let hasHead = false
    try {
      hasHead = (await lstat(join(store.gitDir, 'HEAD'))).isFile()
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }

    if (!hasHead) {
      await this.git.run(store, ['init', '--quiet'])
    } else {
      try {
        const objectsStat = await lstat(join(store.gitDir, 'objects'))
        const refsStat = await lstat(join(store.gitDir, 'refs'))
        const configStat = await lstat(join(store.gitDir, 'config'))
        if (!objectsStat.isDirectory() || !refsStat.isDirectory() || !configStat.isFile()) {
          throw new Error('invalid checkpoint store structure')
        }
        await this.git.run(store, ['rev-parse', '--git-dir'])
      } catch {
        throw new CheckpointInternalError('corrupt_store', 'checkpoint Git store is invalid')
      }
    }

    await this.git.run(store, ['config', 'user.email', 'checkpoint@dzupagent.invalid'])
    await this.git.run(store, ['config', 'user.name', 'DzupAgent Checkpoint'])
    await this.git.run(store, ['config', 'core.logAllRefUpdates', 'always'])
    await this.git.run(store, ['config', 'gc.auto', '0'])
    await this.git.run(store, ['config', 'gc.cruftPacks', 'false'])
  }

  async createSnapshot(
    canonicalRoot: string,
    reason: string,
    store: CheckpointStore,
    lease: CheckpointLease,
    phases?: {
      commitWritten?: (checkpointId: string, treeHash: string) => Promise<void>
      refPublished?: (checkpointId: string, treeHash: string) => Promise<void>
      commitWrittenPhase?: CheckpointTestPhase
      refWrittenPhase?: CheckpointTestPhase
    },
    admittedTree?: TreeAdmission,
  ): Promise<SnapshotOutcome> {
    const admission = admittedTree ?? await this.policy.scanAdmittedTree(canonicalRoot)
    const treeHash = await this.git.withTemporaryIndex(store, async (indexFile) => {
      await this.stageCurrentTree(store, indexFile, admission.dynamicExcludes)
      return (await this.git.run(store, ['write-tree'], { indexFile })).stdout.trim()
    })
    await this.validateTreeObject(store, treeHash)
    const proofBase = {
      rootSha256: lease.rootSha256,
      sourceDigest: checkpointSourceDigest(treeHash),
      generation: lease.generation,
    }

    const refs = await this.listRefs(store)
    const latest = refs[0]
    if (latest) {
      let latestTree: string
      try {
        latestTree = await this.treeForCommit(store, latest.hash)
      } catch {
        throw new CheckpointInternalError(
          'corrupt_store',
          'latest checkpoint reference points to a missing object',
        )
      }
      if (latestTree === treeHash) {
        const proof: CheckpointProof = { checkpointId: latest.hash, ...proofBase }
        return { store, checkpointId: latest.hash, treeHash, proof, created: false }
      }
    }

    await this.ownership.assertOwned(store, lease)
    const checkpointId = (await this.git.run(
      store,
      ['commit-tree', treeHash, '-m', reason],
    )).stdout.trim()
    if (!isFullObjectId(checkpointId)) {
      throw new CheckpointInternalError('corrupt_store', 'Git returned an invalid checkpoint identity')
    }
    if (phases?.commitWrittenPhase) {
      await emitCheckpointTestPhase(phases.commitWrittenPhase)
    }
    await phases?.commitWritten?.(checkpointId, treeHash)

    const latestSequence = latest
      ? Number(latest.ref.slice(CHECKPOINT_REFS.length, CHECKPOINT_REFS.length + 13))
      : 0
    const sequence = Math.max(Date.now(), latestSequence + 1)
    const ref = `${CHECKPOINT_REFS}${String(sequence).padStart(13, '0')}-${randomUUID()}`
    await this.ownership.assertOwned(store, lease)
    await this.git.run(store, ['update-ref', ref, checkpointId])
    if (phases?.refWrittenPhase) await emitCheckpointTestPhase(phases.refWrittenPhase)
    await phases?.refPublished?.(checkpointId, treeHash)
    const proof: CheckpointProof = { checkpointId, ...proofBase }
    return { store, checkpointId, treeHash, proof, created: true }
  }

  async listEntries(store: CheckpointStore): Promise<CheckpointEntry[]> {
    const visibleRefs = (await this.listRefs(store)).slice(0, this.settings.maxSnapshots)
    for (const entry of visibleRefs) {
      try {
        await this.treeForCommit(store, entry.hash)
      } catch {
        throw new CheckpointInternalError(
          'corrupt_store',
          'checkpoint reference points to a missing object',
        )
      }
    }
    return visibleRefs.map((entry) => ({
      hash: entry.hash,
      timestamp: entry.timestamp,
      reason: entry.reason,
      summary: entry.hash.slice(0, 12),
    }))
  }

  async diffCurrent(
    store: CheckpointStore,
    checkpointHash: string,
    admission: TreeAdmission,
  ): Promise<CheckpointDiff> {
    await this.validateCheckpoint(store, checkpointHash)
    return this.git.withTemporaryIndex(store, async (indexFile) => {
      await this.stageCurrentTree(store, indexFile, admission.dynamicExcludes)
      const currentTree = (await this.git.run(store, ['write-tree'], { indexFile })).stdout.trim()
      await this.validateTreeObject(store, currentTree)
      const { stdout } = await this.git.run(
        store,
        ['diff', '--cached', '--name-status', '--no-renames', '-z', checkpointHash, '--'],
        { indexFile },
      )
      const { stdout: statOut } = await this.git.run(
        store,
        ['diff', '--cached', '--shortstat', checkpointHash, '--'],
        { indexFile },
      )
      return parseCheckpointDiff(stdout, statOut)
    })
  }

  async stageAndWriteCurrentTree(store: CheckpointStore): Promise<string> {
    const admission = await this.policy.scanAdmittedTree(store.workDir)
    return this.git.withTemporaryIndex(store, async (indexFile) => {
      await this.stageCurrentTree(store, indexFile, admission.dynamicExcludes)
      const treeHash = (await this.git.run(store, ['write-tree'], { indexFile })).stdout.trim()
      await this.validateTreeObject(store, treeHash)
      return treeHash
    })
  }

  async applyTree(
    store: CheckpointStore,
    treeHash: string,
    dynamicExcludes?: string[],
  ): Promise<void> {
    const excludes = dynamicExcludes
      ?? (await this.policy.scanAdmittedTree(store.workDir)).dynamicExcludes
    await this.git.withTemporaryIndex(store, async (indexFile) => {
      await this.stageCurrentTree(store, indexFile, excludes)
      const currentTree = (await this.git.run(store, ['write-tree'], { indexFile })).stdout.trim()
      await this.validateTreeObject(store, currentTree)
      await this.git.run(store, ['read-tree', '--reset', '-u', treeHash], { indexFile })
    })
  }

  async validateCheckpoint(store: CheckpointStore, checkpointHash: string): Promise<string> {
    if (!isFullObjectId(checkpointHash)) {
      throw new CheckpointInternalError('unsafe_input', 'checkpoint identity is invalid')
    }
    if (!(await this.listRefs(store)).some((entry) => entry.hash === checkpointHash)) {
      throw new CheckpointInternalError('not_found', 'checkpoint does not exist')
    }
    try {
      const treeHash = await this.treeForCommit(store, checkpointHash)
      await this.validateTreeObject(store, checkpointHash)
      return treeHash
    } catch (error: unknown) {
      if (error instanceof CheckpointInternalError && error.code === 'resource_limit') throw error
      throw new CheckpointInternalError('corrupt_store', 'checkpoint object graph is invalid')
    }
  }

  async pruneOldSnapshots(store: CheckpointStore, lease: CheckpointLease): Promise<void> {
    const removed = (await this.listRefs(store)).slice(this.settings.maxSnapshots)
    if (removed.length === 0) return
    await this.ownership.assertOwned(store, lease)
    for (const entry of removed) {
      await this.git.run(store, ['update-ref', '-d', entry.ref, entry.hash])
    }
    await this.git.run(store, ['reflog', 'expire', '--expire=now', '--all'])
    const reachable = new Set(
      (await this.git.run(store, ['rev-list', '--all', '--reflog'])).stdout
        .trim().split('\n').filter(Boolean),
    )
    if (removed.some((entry) => reachable.has(entry.hash))) {
      throw new CheckpointInternalError(
        'corrupt_store',
        'removed checkpoint remains reachable after retention cleanup',
      )
    }
  }

  async compact(
    store: CheckpointStore,
    lease: CheckpointLease,
  ): Promise<{ retainedCheckpoints: number; unreachableObjects: 0 }> {
    const retained = await this.listRefs(store)
    for (const entry of retained) await this.validateCheckpoint(store, entry.hash)
    await this.ownership.assertOwned(store, lease)
    await this.git.run(store, ['reflog', 'expire', '--expire=now', '--all'])
    await this.git.run(store, ['repack', '-Ad'])
    await emitCheckpointTestPhase('compaction_repacked')
    await this.git.run(store, ['prune', '--expire=now'])
    await emitCheckpointTestPhase('compaction_pruned')

    const fsck = await this.git.run(store, [
      'fsck', '--full', '--no-progress', '--no-reflogs', '--unreachable',
    ])
    if (/\b(?:unreachable|dangling)\b/.test(`${fsck.stdout}\n${fsck.stderr}`)) {
      throw new CheckpointInternalError(
        'compaction_failure',
        'checkpoint object store still contains unreachable objects',
      )
    }

    for (const entry of retained) await this.validateCheckpoint(store, entry.hash)
    const reachable = new Set(
      (await this.git.run(store, ['rev-list', '--all', '--reflog'])).stdout
        .trim().split('\n').filter(Boolean),
    )
    const retainedIds = new Set(retained.map((entry) => entry.hash))
    if (
      reachable.size !== retainedIds.size
      || [...retainedIds].some((checkpointId) => !reachable.has(checkpointId))
    ) {
      throw new CheckpointInternalError(
        'compaction_failure',
        'checkpoint retained-object proof failed',
      )
    }
    return { retainedCheckpoints: retained.length, unreachableObjects: 0 }
  }

  private async stageCurrentTree(
    store: CheckpointStore,
    indexFile: string,
    dynamicExcludes: string[],
  ): Promise<void> {
    await this.git.run(store, ['read-tree', '--empty'], { indexFile })
    await this.git.run(store, buildAddArgs(dynamicExcludes), { indexFile })
  }

  private async listRefs(store: CheckpointStore): Promise<RefRecord[]> {
    const { stdout } = await this.git.run(store, [
      'for-each-ref',
      '--sort=-refname',
      '--format=%(refname)|%(objectname)|%(creatordate:iso-strict)|%(subject)',
      CHECKPOINT_REFS,
    ])
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const parts = line.split('|')
      const ref = parts[0] ?? ''
      const hash = parts[1] ?? ''
      const timestamp = parts[2] ?? ''
      const reason = parts.slice(3).join('|')
      const refSuffix = ref.slice(CHECKPOINT_REFS.length)
      if (
        !ref.startsWith(CHECKPOINT_REFS)
        || !/^\d{13}-[0-9a-f-]{36}$/.test(refSuffix)
        || !isFullObjectId(hash)
      ) {
        throw new CheckpointInternalError('corrupt_store', 'checkpoint reference inventory is invalid')
      }
      return { ref, hash, timestamp, reason }
    })
  }

  private async treeForCommit(store: CheckpointStore, checkpointHash: string): Promise<string> {
    const treeHash = (await this.git.run(
      store,
      ['rev-parse', '--verify', `${checkpointHash}^{tree}`],
    )).stdout.trim()
    if (!isFullObjectId(treeHash)) {
      throw new CheckpointInternalError('corrupt_store', 'checkpoint tree identity is invalid')
    }
    return treeHash
  }

  private async validateTreeObject(store: CheckpointStore, objectId: string): Promise<void> {
    if (!isFullObjectId(objectId)) {
      throw new CheckpointInternalError('corrupt_store', 'checkpoint tree identity is invalid')
    }
    const output = (await this.git.run(
      store,
      ['ls-tree', '-l', '-r', '-z', objectId],
    )).stdout
    validateStoredTreeOutput(output, this.settings)
  }
}
