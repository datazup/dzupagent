import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CheckpointInternalError, safeNodeErrorCode } from './checkpoint-errors.js'
import { readControlText, writeControlJson } from './checkpoint-control-files.js'
import { emitCheckpointTestPhase } from './checkpoint-test-hooks.js'
import type {
  CheckpointLease,
  CheckpointOperation,
  CheckpointOwnershipRecord,
  CheckpointStore,
} from './checkpoint-types.js'

const LOCK_DIRECTORY = 'operation-lock.v1'
const OWNER_FILE = 'owner.v1.json'
const GENERATION_FILE = 'operation-generation.v1.json'
const LEASE_DURATION_MS = 5 * 60 * 1000
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type LockInspection =
  | { kind: 'absent'; digest: 'absent'; record: null }
  | { kind: 'valid'; digest: string; record: CheckpointOwnershipRecord }
  | { kind: 'corrupt'; digest: string; record: null }

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseOwner(value: string): CheckpointOwnershipRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  const record = parsed as Partial<CheckpointOwnershipRecord> | null
  const allowedKeys = new Set([
    'version',
    'rootSha256',
    'ownerNonce',
    'generation',
    'operation',
    'acquiredAt',
    'expiresAt',
  ])
  if (
    !record
    || Array.isArray(record)
    || Object.keys(record).some((key) => !allowedKeys.has(key))
    || record.version !== 1
    || !SHA256_PATTERN.test(record.rootSha256 ?? '')
    || !UUID_PATTERN.test(record.ownerNonce ?? '')
    || !Number.isSafeInteger(record.generation)
    || (record.generation ?? 0) <= 0
    || !['snapshot', 'list', 'diff', 'restore', 'compact', 'recovery'].includes(
      record.operation ?? '',
    )
    || typeof record.acquiredAt !== 'string'
    || typeof record.expiresAt !== 'string'
    || Number.isNaN(Date.parse(record.acquiredAt ?? ''))
    || Number.isNaN(Date.parse(record.expiresAt ?? ''))
  ) return null
  return record as CheckpointOwnershipRecord
}

export function checkpointRecoveryToken(
  rootSha256: string,
  lockDigest: string,
  journalDigest: string,
): string {
  return digest(`checkpoint-recovery-v1\0${rootSha256}\0${lockDigest}\0${journalDigest}`)
}

export class CheckpointOwnershipController {
  async acquire(
    store: CheckpointStore,
    rootSha256: string,
    operation: CheckpointOperation,
  ): Promise<CheckpointLease> {
    const lockDirectory = join(store.storeDir, LOCK_DIRECTORY)
    try {
      await mkdir(lockDirectory, { mode: 0o700 })
    } catch (error: unknown) {
      if (safeNodeErrorCode(error) === 'EEXIST') {
        const current = await this.inspect(store)
        throw new CheckpointInternalError(
          current.kind === 'valid' ? 'ownership_conflict' : 'recovery_required',
          current.kind === 'valid'
            ? 'checkpoint root is owned by another operation'
            : 'checkpoint ownership record requires recovery',
        )
      }
      const code = safeNodeErrorCode(error)
      throw new CheckpointInternalError(
        'io_failure',
        code
          ? `checkpoint ownership could not be acquired (${code})`
          : 'checkpoint ownership could not be acquired',
      )
    }

    try {
      const generation = await this.nextGeneration(store)
      const acquiredAt = new Date()
      const lease: CheckpointLease = {
        version: 1,
        rootSha256,
        ownerNonce: randomUUID(),
        generation,
        operation,
        acquiredAt: acquiredAt.toISOString(),
        expiresAt: new Date(acquiredAt.getTime() + LEASE_DURATION_MS).toISOString(),
      }
      await writeControlJson(join(lockDirectory, OWNER_FILE), lease)
      await emitCheckpointTestPhase('ownership_acquired')
      return lease
    } catch (error: unknown) {
      await rm(lockDirectory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async assertOwned(store: CheckpointStore, lease: CheckpointLease): Promise<void> {
    const current = await this.inspect(store)
    if (
      current.kind !== 'valid'
      || current.record.ownerNonce !== lease.ownerNonce
      || current.record.generation !== lease.generation
      || current.record.rootSha256 !== lease.rootSha256
    ) {
      throw new CheckpointInternalError(
        'recovery_required',
        'checkpoint operation no longer owns its root generation',
      )
    }
  }

  async release(store: CheckpointStore, lease: CheckpointLease): Promise<void> {
    await this.assertOwned(store, lease)
    const lockDirectory = join(store.storeDir, LOCK_DIRECTORY)
    const ownerPath = join(lockDirectory, OWNER_FILE)
    const releasingPath = join(lockDirectory, `owner.releasing-${lease.ownerNonce}.json`)
    try {
      await rename(ownerPath, releasingPath)
      await rm(releasingPath)
      await rmdir(lockDirectory)
    } catch (error: unknown) {
      const code = safeNodeErrorCode(error)
      throw new CheckpointInternalError(
        'recovery_required',
        code
          ? `checkpoint ownership release requires recovery (${code})`
          : 'checkpoint ownership release requires recovery',
      )
    }
  }

  async inspect(store: CheckpointStore): Promise<LockInspection> {
    const lockDirectory = join(store.storeDir, LOCK_DIRECTORY)
    try {
      const stat = await lstat(lockDirectory)
      if (!stat.isDirectory()) {
        return { kind: 'corrupt', digest: digest('invalid-lock-type'), record: null }
      }
    } catch (error: unknown) {
      if (safeNodeErrorCode(error) === 'ENOENT') {
        return { kind: 'absent', digest: 'absent', record: null }
      }
      throw error
    }

    let text: string | null
    try {
      text = await readControlText(join(lockDirectory, OWNER_FILE))
    } catch {
      return { kind: 'corrupt', digest: digest('unreadable-owner'), record: null }
    }
    if (text === null) {
      return { kind: 'corrupt', digest: digest('missing-owner'), record: null }
    }
    const record = parseOwner(text)
    if (!record) return { kind: 'corrupt', digest: digest(text), record: null }
    return { kind: 'valid', digest: digest(text), record }
  }

  async quarantineAbandoned(
    store: CheckpointStore,
    expectedDigest: string,
  ): Promise<string | null> {
    const current = await this.inspect(store)
    if (current.digest !== expectedDigest) {
      throw new CheckpointInternalError(
        'recovery_required',
        'checkpoint ownership changed during recovery admission',
      )
    }
    if (current.kind === 'absent') return null

    const quarantineRoot = join(store.storeDir, 'abandoned-ownership')
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
    const quarantineStat = await lstat(quarantineRoot)
    if (
      !quarantineStat.isDirectory()
      || (quarantineStat.mode & 0o077) !== 0
      || await realpath(quarantineRoot) !== quarantineRoot
    ) {
      throw new CheckpointInternalError(
        'recovery_required',
        'checkpoint ownership quarantine does not match policy',
      )
    }
    const quarantinePath = join(quarantineRoot, `lock-${randomUUID()}`)
    try {
      await rename(join(store.storeDir, LOCK_DIRECTORY), quarantinePath)
      return quarantinePath
    } catch (error: unknown) {
      const code = safeNodeErrorCode(error)
      throw new CheckpointInternalError(
        'recovery_required',
        code
          ? `checkpoint ownership could not be quarantined (${code})`
          : 'checkpoint ownership could not be quarantined',
      )
    }
  }

  async removeAllQuarantines(store: CheckpointStore): Promise<void> {
    await rm(join(store.storeDir, 'abandoned-ownership'), { recursive: true, force: true })
  }

  private async nextGeneration(store: CheckpointStore): Promise<number> {
    const generationPath = join(store.storeDir, GENERATION_FILE)
    const text = await readControlText(generationPath)
    let previous = 0
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as { version?: unknown; generation?: unknown }
        if (
          parsed.version !== 1
          || !Number.isSafeInteger(parsed.generation)
          || Number(parsed.generation) < 0
        ) throw new Error('invalid generation')
        previous = Number(parsed.generation)
      } catch {
        throw new CheckpointInternalError(
          'recovery_required',
          'checkpoint operation generation requires recovery',
        )
      }
    }
    if (previous >= Number.MAX_SAFE_INTEGER) {
      throw new CheckpointInternalError(
        'resource_limit',
        'checkpoint operation generation is exhausted',
      )
    }
    const generation = previous + 1
    await writeControlJson(generationPath, { version: 1, generation })
    return generation
  }
}
