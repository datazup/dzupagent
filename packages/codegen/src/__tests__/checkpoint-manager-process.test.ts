import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckpointManager } from '../vfs/checkpoint-manager.js'
import type { CheckpointTestPhase } from '../vfs/checkpoint/checkpoint-test-hooks.js'
import type { CheckpointRecoveryAuthorization } from '../vfs/checkpoint/checkpoint-types.js'

const require = createRequire(import.meta.url)
const viteNodeCli = require.resolve('vite-node/vite-node.mjs')
const childFixture = fileURLToPath(
  new URL('./fixtures/checkpoint-process-child.ts', import.meta.url),
)

interface ProcessMessage {
  type: 'ready' | 'phase' | 'result' | 'child_error'
  phase?: CheckpointTestPhase
  result?: unknown
}

interface StartMessage {
  type: 'start'
  operation: 'snapshot' | 'restore' | 'compact' | 'recover'
  workDir: string
  baseDir: string
  checkpointId?: string
  pausePhase?: CheckpointTestPhase
  authorization?: CheckpointRecoveryAuthorization
}

interface MessageWaiter {
  predicate: (message: ProcessMessage) => boolean
  resolve: (message: ProcessMessage) => void
  reject: (error: Error) => void
}

const inboxes = new WeakMap<ChildProcess, { queued: ProcessMessage[]; waiters: MessageWaiter[] }>()

function trackChild(child: ChildProcess): void {
  const inbox = { queued: [] as ProcessMessage[], waiters: [] as MessageWaiter[] }
  inboxes.set(child, inbox)
  child.on('message', (message: ProcessMessage) => {
    const waiterIndex = inbox.waiters.findIndex((waiter) => waiter.predicate(message))
    if (waiterIndex < 0) inbox.queued.push(message)
    else inbox.waiters.splice(waiterIndex, 1)[0]!.resolve(message)
  })
  child.once('exit', () => {
    for (const waiter of inbox.waiters.splice(0)) {
      waiter.reject(new Error('checkpoint child exited before its expected IPC barrier'))
    }
  })
}

function waitForMessage(
  child: ChildProcess,
  predicate: (message: ProcessMessage) => boolean,
): Promise<ProcessMessage> {
  const inbox = inboxes.get(child)
  if (!inbox) throw new Error('checkpoint child is not tracked')
  const queuedIndex = inbox.queued.findIndex(predicate)
  if (queuedIndex >= 0) return Promise.resolve(inbox.queued.splice(queuedIndex, 1)[0]!)
  return new Promise((resolve, reject) => {
    inbox.waiters.push({ predicate, resolve, reject })
  })
}

async function startChild(message: StartMessage): Promise<ChildProcess> {
  const child = fork(viteNodeCli, [childFixture], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  trackChild(child)
  await waitForMessage(child, (candidate) => candidate.type === 'ready')
  child.send(message)
  return child
}

async function waitForPhase(
  child: ChildProcess,
  phase: CheckpointTestPhase,
): Promise<void> {
  const message = await waitForMessage(
    child,
    (candidate) => candidate.type === 'phase' && candidate.phase === phase,
  )
  expect(message.phase).toBe(phase)
}

async function continuePhase(child: ChildProcess, phase: CheckpointTestPhase): Promise<void> {
  child.send({ type: 'continue', phase })
}

async function waitForResult<T>(child: ChildProcess): Promise<T> {
  const message = await waitForMessage(
    child,
    (candidate) => candidate.type === 'result' || candidate.type === 'child_error',
  )
  expect(message.type).toBe('result')
  return message.result as T
}

async function killAtPhase(child: ChildProcess, phase: CheckpointTestPhase): Promise<void> {
  await waitForPhase(child, phase)
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
}

describe('CheckpointManager deterministic cross-process qualification', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dzup-checkpoint-process-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('admits one first initializer, blocks the concurrent owner, then deduplicates retry', async () => {
    const workDir = join(tempRoot, 'work')
    const baseDir = join(tempRoot, 'checkpoints')
    await mkdir(workDir)
    await writeFile(join(workDir, 'file.txt'), 'one')

    const owner = await startChild({
      type: 'start',
      operation: 'snapshot',
      workDir,
      baseDir,
      pausePhase: 'snapshot_started',
    })
    await waitForPhase(owner, 'snapshot_started')

    const contender = await startChild({ type: 'start', operation: 'snapshot', workDir, baseDir })
    const blocked = await waitForResult<{ status: string; code?: string }>(contender)
    expect(blocked).toMatchObject({ status: 'failed', code: 'ownership_conflict' })

    await continuePhase(owner, 'snapshot_started')
    const created = await waitForResult<{ status: string }>(owner)
    expect(created.status).toBe('created')

    const retry = await startChild({ type: 'start', operation: 'snapshot', workDir, baseDir })
    const deduplicated = await waitForResult<{ status: string }>(retry)
    expect(deduplicated.status).toBe('deduplicated')
    expect(await new CheckpointManager({ baseDir }).list(workDir)).toHaveLength(1)
  })

  it('allows two independent roots to cross the same phase concurrently', async () => {
    const baseDir = join(tempRoot, 'checkpoints')
    const firstRoot = join(tempRoot, 'first')
    const secondRoot = join(tempRoot, 'second')
    await mkdir(firstRoot)
    await mkdir(secondRoot)
    await writeFile(join(firstRoot, 'file.txt'), 'first')
    await writeFile(join(secondRoot, 'file.txt'), 'second')

    const first = await startChild({
      type: 'start', operation: 'snapshot', workDir: firstRoot, baseDir,
      pausePhase: 'snapshot_started',
    })
    const second = await startChild({
      type: 'start', operation: 'snapshot', workDir: secondRoot, baseDir,
      pausePhase: 'snapshot_started',
    })
    await Promise.all([
      waitForPhase(first, 'snapshot_started'),
      waitForPhase(second, 'snapshot_started'),
    ])
    await Promise.all([
      continuePhase(first, 'snapshot_started'),
      continuePhase(second, 'snapshot_started'),
    ])
    const results = await Promise.all([
      waitForResult<{ status: string }>(first),
      waitForResult<{ status: string }>(second),
    ])
    expect(results.map((result) => result.status)).toEqual(['created', 'created'])
  })

  it('publishes exactly one checkpoint for two processes observing the same changed tree', async () => {
    const workDir = join(tempRoot, 'work')
    const baseDir = join(tempRoot, 'checkpoints')
    await mkdir(workDir)
    await writeFile(join(workDir, 'file.txt'), 'baseline')
    const manager = new CheckpointManager({ baseDir })
    await manager.ensureCheckpointDetailed(workDir, 'baseline')
    await writeFile(join(workDir, 'file.txt'), 'changed')

    const owner = await startChild({
      type: 'start', operation: 'snapshot', workDir, baseDir,
      pausePhase: 'snapshot_started',
    })
    await waitForPhase(owner, 'snapshot_started')
    const contender = await startChild({ type: 'start', operation: 'snapshot', workDir, baseDir })
    expect(await waitForResult<{ status: string; code?: string }>(contender)).toMatchObject({
      status: 'failed', code: 'ownership_conflict',
    })
    await continuePhase(owner, 'snapshot_started')
    expect((await waitForResult<{ status: string }>(owner)).status).toBe('created')

    const retry = await startChild({ type: 'start', operation: 'snapshot', workDir, baseDir })
    expect((await waitForResult<{ status: string }>(retry)).status).toBe('deduplicated')
    expect(await manager.list(workDir)).toHaveLength(2)
  })

  it('does not steal a stale-looking live owner or accept implicit recovery authority', async () => {
    const workDir = join(tempRoot, 'work')
    const baseDir = join(tempRoot, 'checkpoints')
    await mkdir(workDir)
    await writeFile(join(workDir, 'file.txt'), 'content')
    const owner = await startChild({
      type: 'start', operation: 'snapshot', workDir, baseDir,
      pausePhase: 'snapshot_started',
    })
    await waitForPhase(owner, 'snapshot_started')

    const canonicalRoot = await realpath(workDir)
    const rootSha256 = createHash('sha256').update(canonicalRoot).digest('hex')
    const ownerPath = join(baseDir, rootSha256, 'operation-lock.v1', 'owner.v1.json')
    const ownerRecord = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<string, unknown>
    ownerRecord['acquiredAt'] = '2000-01-01T00:00:00.000Z'
    ownerRecord['expiresAt'] = '2000-01-01T00:05:00.000Z'
    await writeFile(ownerPath, `${JSON.stringify(ownerRecord)}\n`, { mode: 0o600 })

    const manager = new CheckpointManager({ baseDir })
    expect(await manager.ensureCheckpointDetailed(workDir, 'contender')).toMatchObject({
      status: 'failed', code: 'ownership_conflict',
    })
    const inspection = await manager.inspectRecoveryDetailed(workDir)
    expect(inspection.status).toBe('recovery_required')
    if (inspection.status !== 'recovery_required') return
    expect(await manager.recoverDetailed(workDir, {
      recoveryToken: inspection.recoveryToken,
      operatorConfirmedAbandoned: false,
    } as unknown as CheckpointRecoveryAuthorization)).toMatchObject({
      status: 'failed', code: 'unsafe_input',
    })

    await continuePhase(owner, 'snapshot_started')
    expect((await waitForResult<{ status: string }>(owner)).status).toBe('created')
  })

  it('blocks snapshot and compaction while restore owns the root', async () => {
    const workDir = join(tempRoot, 'work')
    const baseDir = join(tempRoot, 'checkpoints')
    await mkdir(workDir)
    await writeFile(join(workDir, 'file.txt'), 'target')
    const manager = new CheckpointManager({ baseDir })
    const target = await manager.ensureCheckpointDetailed(workDir, 'target')
    expect(target.status).toBe('created')
    if (target.status !== 'created') return
    await writeFile(join(workDir, 'file.txt'), 'current')

    const owner = await startChild({
      type: 'start', operation: 'restore', workDir, baseDir,
      checkpointId: target.checkpointId,
      pausePhase: 'restore_safety_published',
    })
    await waitForPhase(owner, 'restore_safety_published')

    const snapshot = await startChild({ type: 'start', operation: 'snapshot', workDir, baseDir })
    const restore = await startChild({
      type: 'start', operation: 'restore', workDir, baseDir,
      checkpointId: target.checkpointId,
    })
    const compact = await startChild({ type: 'start', operation: 'compact', workDir, baseDir })
    const blocked = await Promise.all([
      waitForResult<{ status: string; code?: string }>(snapshot),
      waitForResult<{ status: string; code?: string }>(restore),
      waitForResult<{ status: string; code?: string }>(compact),
    ])
    expect(blocked).toEqual([
      expect.objectContaining({ status: 'failed', code: 'ownership_conflict' }),
      expect.objectContaining({ status: 'failed', code: 'ownership_conflict' }),
      expect.objectContaining({ status: 'failed', code: 'ownership_conflict' }),
    ])

    await continuePhase(owner, 'restore_safety_published')
    expect((await waitForResult<{ status: string }>(owner)).status).toBe('restored')
  })

  it('rejects an admitted recovery token after the journal bytes change', async () => {
    const workDir = join(tempRoot, 'token-work')
    const baseDir = join(tempRoot, 'token-checkpoints')
    await mkdir(workDir)
    await writeFile(join(workDir, 'file.txt'), 'content')
    const child = await startChild({
      type: 'start', operation: 'snapshot', workDir, baseDir,
      pausePhase: 'snapshot_started',
    })
    await killAtPhase(child, 'snapshot_started')

    const manager = new CheckpointManager({ baseDir })
    const admitted = await manager.inspectRecoveryDetailed(workDir)
    expect(admitted.status).toBe('recovery_required')
    if (admitted.status !== 'recovery_required') return

    const canonicalRoot = await realpath(workDir)
    const rootSha256 = createHash('sha256').update(canonicalRoot).digest('hex')
    const journalPath = join(baseDir, rootSha256, 'operation-journal.v1.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 })

    expect(await manager.recoverDetailed(workDir, {
      recoveryToken: admitted.recoveryToken,
      operatorConfirmedAbandoned: true,
    })).toMatchObject({ status: 'failed', code: 'unsafe_input' })

    const refreshed = await manager.inspectRecoveryDetailed(workDir)
    expect(refreshed.status).toBe('recovery_required')
    if (refreshed.status !== 'recovery_required') return
    expect(refreshed.recoveryToken).not.toBe(admitted.recoveryToken)
    expect(await manager.recoverDetailed(workDir, {
      recoveryToken: refreshed.recoveryToken,
      operatorConfirmedAbandoned: true,
    })).toMatchObject({ status: 'recovered' })
  })

  it('classifies a valid-looking cross-generation owner and journal as ambiguous', async () => {
    const workDir = join(tempRoot, 'generation-work')
    const baseDir = join(tempRoot, 'generation-checkpoints')
    await mkdir(workDir)
    await writeFile(join(workDir, 'file.txt'), 'content')
    const child = await startChild({
      type: 'start', operation: 'snapshot', workDir, baseDir,
      pausePhase: 'snapshot_started',
    })
    await killAtPhase(child, 'snapshot_started')

    const canonicalRoot = await realpath(workDir)
    const rootSha256 = createHash('sha256').update(canonicalRoot).digest('hex')
    const journalPath = join(baseDir, rootSha256, 'operation-journal.v1.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>
    journal['generation'] = Number(journal['generation']) + 1
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 })

    const manager = new CheckpointManager({ baseDir })
    const inspection = await manager.inspectRecoveryDetailed(workDir)
    expect(inspection).toMatchObject({ status: 'recovery_required', state: 'ambiguous' })
    if (inspection.status !== 'recovery_required') return
    expect(await manager.recoverDetailed(workDir, {
      recoveryToken: inspection.recoveryToken,
      operatorConfirmedAbandoned: true,
    })).toMatchObject({ status: 'failed', code: 'recovery_required' })
  })

  it('repeats safety recovery after the recovery process itself is interrupted', async () => {
    const workDir = join(tempRoot, 'recovery-retry-work')
    const baseDir = join(tempRoot, 'recovery-retry-checkpoints')
    await mkdir(workDir)
    await writeFile(join(workDir, 'file.txt'), 'target')
    const manager = new CheckpointManager({ baseDir })
    const target = await manager.ensureCheckpointDetailed(workDir, 'target')
    expect(target.status).toBe('created')
    if (target.status !== 'created') return
    await writeFile(join(workDir, 'file.txt'), 'current')

    const restore = await startChild({
      type: 'start', operation: 'restore', workDir, baseDir,
      checkpointId: target.checkpointId, pausePhase: 'restore_tree_applied',
    })
    await killAtPhase(restore, 'restore_tree_applied')
    const admitted = await manager.inspectRecoveryDetailed(workDir)
    expect(admitted).toMatchObject({
      status: 'recovery_required', state: 'restore_recovery_required',
    })
    if (admitted.status !== 'recovery_required') return

    const recovery = await startChild({
      type: 'start', operation: 'recover', workDir, baseDir,
      authorization: {
        recoveryToken: admitted.recoveryToken,
        operatorConfirmedAbandoned: true,
      },
      pausePhase: 'recovery_tree_applied',
    })
    await killAtPhase(recovery, 'recovery_tree_applied')

    const interrupted = await manager.inspectRecoveryDetailed(workDir)
    expect(interrupted).toMatchObject({
      status: 'recovery_required', state: 'restore_recovery_required',
    })
    if (interrupted.status !== 'recovery_required') return
    expect(await manager.recoverDetailed(workDir, {
      recoveryToken: interrupted.recoveryToken,
      operatorConfirmedAbandoned: true,
    })).toMatchObject({ status: 'recovered', restoredCheckpointId: expect.any(String) })
    expect(await readFile(join(workDir, 'file.txt'), 'utf8')).toBe('current')
    expect(await manager.inspectRecoveryDetailed(workDir)).toEqual({ status: 'clean' })
  })

  it('classifies and recovers the normalized interruption matrix twice', async () => {
    const runMatrix = async (run: number) => {
      const evidence: Array<{ phase: string; state: string; outcome: string }> = []
      const phases: CheckpointTestPhase[] = [
        'ownership_acquired',
        'snapshot_started',
        'snapshot_commit_object_written',
        'snapshot_commit_written',
        'snapshot_ref_written',
        'snapshot_ref_published',
        'snapshot_retention_completed',
        'restore_started',
        'restore_safety_ref_written',
        'restore_safety_published',
        'restore_mutation_started',
        'restore_tree_applied',
        'restore_target_verified',
        'compaction_started',
        'compaction_repacked',
        'compaction_pruned',
        'compaction_verified',
      ]

      for (const phase of phases) {
        const workDir = join(tempRoot, `run-${run}-${phase}-work`)
        const baseDir = join(tempRoot, `run-${run}-${phase}-store`)
        await mkdir(workDir)
        await writeFile(join(workDir, 'file.txt'), phase.startsWith('restore_') ? 'target' : 'snapshot')
        const manager = new CheckpointManager({ baseDir })

        let child: ChildProcess
        if (phase.startsWith('restore_')) {
          const target = await manager.ensureCheckpointDetailed(workDir, 'target')
          expect(target.status).toBe('created')
          if (target.status !== 'created') throw new Error('target checkpoint missing')
          await writeFile(join(workDir, 'file.txt'), 'current')
          child = await startChild({
            type: 'start', operation: 'restore', workDir, baseDir,
            checkpointId: target.checkpointId, pausePhase: phase,
          })
        } else if (phase.startsWith('compaction_')) {
          await manager.ensureCheckpointDetailed(workDir, 'compaction baseline')
          child = await startChild({
            type: 'start', operation: 'compact', workDir, baseDir, pausePhase: phase,
          })
        } else {
          child = await startChild({
            type: 'start', operation: 'snapshot', workDir, baseDir, pausePhase: phase,
          })
        }

        await killAtPhase(child, phase)
        const inspection = await manager.inspectRecoveryDetailed(workDir)
        expect(inspection.status).toBe('recovery_required')
        if (inspection.status !== 'recovery_required') throw new Error('inspection missing')
        expect(inspection.state).not.toBe('ambiguous')
        const recovered = await manager.recoverDetailed(workDir, {
          recoveryToken: inspection.recoveryToken,
          operatorConfirmedAbandoned: true,
        })
        expect(recovered.status).toBe('recovered')
        expect((await manager.inspectRecoveryDetailed(workDir)).status).toBe('clean')

        const content = await readFile(join(workDir, 'file.txt'), 'utf8')
        const outcome = phase === 'restore_target_verified'
          ? (content === 'target' ? 'target' : 'unexpected')
          : phase.startsWith('restore_')
            ? (content === 'current' ? 'safety' : 'unexpected')
            : phase.startsWith('compaction_')
              ? 'compacted'
            : (await manager.list(workDir)).length === 1 ? 'published' : 'unpublished'
        evidence.push({ phase, state: inspection.state, outcome })
        expect((await manager.compactDetailed(workDir)).status).toBe('compacted')
      }
      return evidence
    }

    const first = await runMatrix(1)
    const second = await runMatrix(2)
    expect(second).toEqual(first)
    expect(first).toEqual([
      { phase: 'ownership_acquired', state: 'no_worktree_mutation', outcome: 'unpublished' },
      { phase: 'snapshot_started', state: 'no_worktree_mutation', outcome: 'unpublished' },
      { phase: 'snapshot_commit_object_written', state: 'no_worktree_mutation', outcome: 'unpublished' },
      { phase: 'snapshot_commit_written', state: 'no_worktree_mutation', outcome: 'unpublished' },
      { phase: 'snapshot_ref_written', state: 'no_worktree_mutation', outcome: 'published' },
      { phase: 'snapshot_ref_published', state: 'no_worktree_mutation', outcome: 'published' },
      { phase: 'snapshot_retention_completed', state: 'no_worktree_mutation', outcome: 'published' },
      { phase: 'restore_started', state: 'restore_not_started', outcome: 'safety' },
      { phase: 'restore_safety_ref_written', state: 'restore_not_started', outcome: 'safety' },
      { phase: 'restore_safety_published', state: 'restore_not_started', outcome: 'safety' },
      { phase: 'restore_mutation_started', state: 'restore_recovery_required', outcome: 'safety' },
      { phase: 'restore_tree_applied', state: 'restore_recovery_required', outcome: 'safety' },
      { phase: 'restore_target_verified', state: 'target_verified_cleanup_required', outcome: 'target' },
      { phase: 'compaction_started', state: 'no_worktree_mutation', outcome: 'compacted' },
      { phase: 'compaction_repacked', state: 'no_worktree_mutation', outcome: 'compacted' },
      { phase: 'compaction_pruned', state: 'no_worktree_mutation', outcome: 'compacted' },
      { phase: 'compaction_verified', state: 'no_worktree_mutation', outcome: 'compacted' },
    ])
  }, 120_000)
})
