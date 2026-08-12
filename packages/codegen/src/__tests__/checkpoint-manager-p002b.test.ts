import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckpointManager } from '../vfs/checkpoint-manager.js'
import type {
  CheckpointDetailedResult,
  CheckpointErrorCode,
  CheckpointProof,
} from '../vfs/checkpoint/checkpoint-types.js'
import { installCheckpointTestHook } from '../vfs/checkpoint/checkpoint-test-hooks.js'
import { runProtectedMutation } from './fixtures/checkpoint-protected-mutation.js'

const execFileAsync = promisify(execFile)

async function checkpointStoreDir(baseDir: string, workDir: string): Promise<string> {
  const canonicalRoot = await realpath(workDir)
  const digest = createHash('sha256').update(canonicalRoot).digest('hex')
  return join(baseDir, digest)
}

describe('CheckpointManager P002B expected-red admission', () => {
  let tempRoot: string
  let workDir: string
  let baseDir: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dzup-checkpoint-p002b-'))
    workDir = join(tempRoot, 'work')
    baseDir = join(tempRoot, 'checkpoints')
    await mkdir(workDir)
    await writeFile(join(workDir, 'file.txt'), 'baseline')
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('returns a root, source, and operation-generation proof for protected adopters', async () => {
    const manager = new CheckpointManager({ baseDir })
    const result = await manager.ensureCheckpointDetailed(workDir, 'protected mutation')

    expect(result.status).toBe('created')
    if (result.status !== 'created') return
    expect(result.proof.rootSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.proof.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.proof.generation).toBeGreaterThan(0)

    const unchanged = await manager.ensureCheckpointDetailed(workDir, 'exact retry')
    expect(unchanged.status).toBe('deduplicated')
    if (unchanged.status !== 'deduplicated') return
    expect(unchanged.proof.sourceDigest).toBe(result.proof.sourceDigest)
    expect(unchanged.proof.generation).toBeGreaterThan(result.proof.generation)

    await writeFile(join(workDir, 'file.txt'), 'changed in the same turn')
    const changed = await manager.ensureCheckpointDetailed(workDir, 'changed retry')
    expect(changed.status).toBe('created')
    if (changed.status === 'created') {
      expect(changed.proof.sourceDigest).not.toBe(result.proof.sourceDigest)
    }
  })

  it('fails closed instead of trusting a legacy 16-hex shadow store', async () => {
    const legacyName = createHash('sha256').update(resolve(workDir)).digest('hex').slice(0, 16)
    await mkdir(join(baseDir, legacyName), { recursive: true })

    const result = await new CheckpointManager({ baseDir })
      .ensureCheckpointDetailed(workDir, 'legacy refusal')

    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.code).toBe('legacy_store')
  })

  it('offers explicit physical compaction with a typed result', async () => {
    const manager = new CheckpointManager({ baseDir })
    await manager.ensureCheckpointDetailed(workDir, 'baseline')

    const result = await manager.compactDetailed(workDir)
    expect(result.status).toBe('compacted')
    if (result.status === 'compacted') {
      expect(result.retainedCheckpoints).toBe(1)
      expect(result.unreachableObjects).toBe(0)
    }
  })

  it('revalidates the staged tree after ownership closes the admission race window', async () => {
    const manager = new CheckpointManager({ baseDir, maxFileBytes: 16 })
    const removeHook = installCheckpointTestHook(async (phase) => {
      if (phase === 'ownership_acquired') {
        await writeFile(join(workDir, 'file.txt'), 'x'.repeat(32))
      }
    })

    let result: CheckpointDetailedResult
    try {
      result = await manager.ensureCheckpointDetailed(workDir, 'post-scan growth')
    } finally {
      removeHook()
    }

    expect(result).toMatchObject({ status: 'skipped', code: 'resource_limit' })
    const inspection = await manager.inspectRecoveryDetailed(workDir)
    expect(inspection.status).toBe('recovery_required')
    if (inspection.status !== 'recovery_required') return
    expect(await manager.recoverDetailed(workDir, {
      recoveryToken: inspection.recoveryToken,
      operatorConfirmedAbandoned: true,
    })).toMatchObject({ status: 'recovered', recoveredState: 'no_worktree_mutation' })
    expect(await manager.list(workDir)).toEqual([])
  })

  it('physically removes an unreachable retained-out checkpoint without harming retained refs', async () => {
    const manager = new CheckpointManager({ baseDir, maxSnapshots: 2 })
    const first = await manager.ensureCheckpointDetailed(workDir, 'one')
    expect(first.status).toBe('created')
    if (first.status !== 'created') return
    manager.newTurn()
    await writeFile(join(workDir, 'file.txt'), 'two')
    await manager.ensureCheckpointDetailed(workDir, 'two')
    manager.newTurn()
    await writeFile(join(workDir, 'file.txt'), 'three')
    await manager.ensureCheckpointDetailed(workDir, 'three')

    const gitDir = join(await checkpointStoreDir(baseDir, workDir), 'repo')
    const gitEnv = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: workDir }
    await execFileAsync('git', ['cat-file', '-e', `${first.checkpointId}^{commit}`], {
      cwd: workDir,
      env: gitEnv,
    })

    const compacted = await manager.compactDetailed(workDir)
    expect(compacted.status).toBe('compacted')
    if (compacted.status === 'compacted') expect(compacted.retainedCheckpoints).toBe(2)
    await expect(execFileAsync(
      'git', ['cat-file', '-e', `${first.checkpointId}^{commit}`],
      { cwd: workDir, env: gitEnv },
    )).rejects.toMatchObject({ code: 128 })
    expect(await manager.list(workDir)).toHaveLength(2)
  })

  it('keeps corrupt journals and incomplete ownership records fail-closed', async () => {
    const manager = new CheckpointManager({ baseDir })
    await manager.ensureCheckpointDetailed(workDir, 'baseline')
    const storeDir = await checkpointStoreDir(baseDir, workDir)
    await writeFile(join(storeDir, 'operation-journal.v1.json'), '{broken', { mode: 0o600 })

    const corruptJournal = await manager.inspectRecoveryDetailed(workDir)
    expect(corruptJournal.status).toBe('recovery_required')
    if (corruptJournal.status !== 'recovery_required') return
    expect(corruptJournal.state).toBe('ambiguous')
    expect(await manager.recoverDetailed(workDir, {
      recoveryToken: corruptJournal.recoveryToken,
      operatorConfirmedAbandoned: true,
    })).toMatchObject({ status: 'failed', code: 'recovery_required' })

    const secondWorkDir = join(tempRoot, 'second-work')
    const secondBaseDir = join(tempRoot, 'second-checkpoints')
    await mkdir(secondWorkDir)
    await writeFile(join(secondWorkDir, 'file.txt'), 'content')
    const second = new CheckpointManager({ baseDir: secondBaseDir })
    await second.ensureCheckpointDetailed(secondWorkDir, 'baseline')
    const secondStore = await checkpointStoreDir(secondBaseDir, secondWorkDir)
    await mkdir(join(secondStore, 'operation-lock.v1'))

    const missingOwner = await second.inspectRecoveryDetailed(secondWorkDir)
    expect(missingOwner).toMatchObject({ status: 'recovery_required', state: 'ambiguous' })
    second.newTurn()
    expect(await second.ensureCheckpointDetailed(secondWorkDir, 'blocked')).toMatchObject({
      status: 'failed',
      code: 'recovery_required',
    })
  })

  it('proves the fake protected adopter blocks every non-success and binds its receipt', async () => {
    const proof: CheckpointProof = {
      checkpointId: '1'.repeat(40),
      rootSha256: '2'.repeat(64),
      sourceDigest: '3'.repeat(64),
      generation: 7,
    }
    const failureCodes: CheckpointErrorCode[] = [
      'not_found',
      'unsafe_input',
      'resource_limit',
      'corrupt_store',
      'ownership_conflict',
      'recovery_required',
      'compaction_failure',
      'legacy_store',
      'timeout',
      'git_failure',
      'io_failure',
    ]
    const nonSuccesses: CheckpointDetailedResult[] = [
      { status: 'skipped', code: 'unsafe_input', reason: 'bounded' },
      { status: 'skipped', code: 'resource_limit', reason: 'bounded' },
      ...failureCodes.map((code) => ({ status: 'failed' as const, code, error: 'bounded' })),
    ]

    for (const checkpoint of nonSuccesses) {
      let mutated = false
      const result = await runProtectedMutation(
        { ensureCheckpointDetailed: async () => checkpoint },
        workDir,
        async () => { mutated = true },
      )
      expect(result).toMatchObject({ status: 'blocked' })
      expect(mutated).toBe(false)
    }

    for (const status of ['created', 'deduplicated'] as const) {
      let compatibilityWrapperCalled = false
      let mutated = false
      const port = {
        ensureCheckpoint: async () => {
          compatibilityWrapperCalled = true
          throw new Error('compatibility wrapper must not be called')
        },
        ensureCheckpointDetailed: async (): Promise<CheckpointDetailedResult> => ({
          status,
          checkpointId: proof.checkpointId,
          proof,
        }),
      }
      const result = await runProtectedMutation(port, workDir, async () => { mutated = true })
      expect(result).toEqual({ status: 'mutated', receipt: proof })
      expect(mutated).toBe(true)
      expect(compatibilityWrapperCalled).toBe(false)
    }

    const realManager = new CheckpointManager({ baseDir })
    const realResult = await runProtectedMutation(realManager, workDir, async () => {
      await writeFile(join(workDir, 'protected.txt'), 'mutated')
    })
    expect(realResult.status).toBe('mutated')
    if (realResult.status === 'mutated') {
      expect(realResult.receipt.rootSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(realResult.receipt.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(realResult.receipt.generation).toBeGreaterThan(0)
    }
    expect(await readFile(join(workDir, 'protected.txt'), 'utf8')).toBe('mutated')
  })
})
