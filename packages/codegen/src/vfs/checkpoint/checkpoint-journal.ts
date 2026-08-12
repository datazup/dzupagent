import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { CheckpointInternalError, isFullObjectId } from './checkpoint-errors.js'
import { readControlText, removeControlFile, writeControlJson } from './checkpoint-control-files.js'
import { emitCheckpointTestPhase } from './checkpoint-test-hooks.js'
import type {
  CheckpointJournalPhase,
  CheckpointJournalRecord,
  CheckpointLease,
  CheckpointRecoveryState,
  CheckpointStore,
} from './checkpoint-types.js'

const JOURNAL_FILE = 'operation-journal.v1.json'
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type JournalInspection =
  | { kind: 'absent'; digest: 'absent'; record: null }
  | { kind: 'valid'; digest: string; record: CheckpointJournalRecord }
  | { kind: 'corrupt'; digest: string; record: null }

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function operationForPhase(phase: CheckpointJournalPhase): CheckpointJournalRecord['operation'] {
  if (phase.startsWith('snapshot_')) return 'snapshot'
  if (phase.startsWith('restore_')) return 'restore'
  return 'compact'
}

function optionalObjectId(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && isFullObjectId(value))
}

function hasExactJournalShape(record: Partial<CheckpointJournalRecord>): boolean {
  const allowedKeys = new Set([
    'version',
    'rootSha256',
    'ownerNonce',
    'generation',
    'operation',
    'phase',
    'checkpointId',
    'targetCheckpointId',
    'safetyCheckpointId',
    'sourceDigest',
  ])
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return false

  switch (record.phase) {
    case 'snapshot_started':
      return record.checkpointId === undefined
        && record.targetCheckpointId === undefined
        && record.safetyCheckpointId === undefined
        && record.sourceDigest === undefined
    case 'snapshot_commit_written':
    case 'snapshot_ref_published':
    case 'snapshot_retention_completed':
      return record.checkpointId !== undefined
        && record.targetCheckpointId === undefined
        && record.safetyCheckpointId === undefined
        && record.sourceDigest !== undefined
    case 'restore_started':
      return record.checkpointId === undefined
        && record.targetCheckpointId !== undefined
        && record.safetyCheckpointId === undefined
        && record.sourceDigest !== undefined
    case 'restore_safety_published':
    case 'restore_mutation_started':
    case 'restore_target_verified':
      return record.checkpointId === undefined
        && record.targetCheckpointId !== undefined
        && record.safetyCheckpointId !== undefined
        && record.sourceDigest !== undefined
    case 'compaction_started':
    case 'compaction_verified':
      return record.checkpointId === undefined
        && record.targetCheckpointId === undefined
        && record.safetyCheckpointId === undefined
        && record.sourceDigest === undefined
    default:
      return false
  }
}

function parseJournal(value: string): CheckpointJournalRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  const record = parsed as Partial<CheckpointJournalRecord> | null
  const phases: CheckpointJournalPhase[] = [
    'snapshot_started',
    'snapshot_commit_written',
    'snapshot_ref_published',
    'snapshot_retention_completed',
    'restore_started',
    'restore_safety_published',
    'restore_mutation_started',
    'restore_target_verified',
    'compaction_started',
    'compaction_verified',
  ]
  if (
    !record
    || Array.isArray(record)
    || record.version !== 1
    || !SHA256_PATTERN.test(record.rootSha256 ?? '')
    || !UUID_PATTERN.test(record.ownerNonce ?? '')
    || !Number.isSafeInteger(record.generation)
    || (record.generation ?? 0) <= 0
    || !phases.includes(record.phase as CheckpointJournalPhase)
    || operationForPhase(record.phase as CheckpointJournalPhase) !== record.operation
    || !optionalObjectId(record.checkpointId)
    || !optionalObjectId(record.targetCheckpointId)
    || !optionalObjectId(record.safetyCheckpointId)
    || (record.sourceDigest !== undefined && !SHA256_PATTERN.test(record.sourceDigest))
    || !hasExactJournalShape(record)
  ) return null
  return record as CheckpointJournalRecord
}

export function classifyJournal(
  inspection: JournalInspection,
): CheckpointRecoveryState {
  if (inspection.kind === 'corrupt') return 'ambiguous'
  if (inspection.kind === 'absent') return 'no_worktree_mutation'
  switch (inspection.record.phase) {
    case 'restore_started':
    case 'restore_safety_published':
      return 'restore_not_started'
    case 'restore_mutation_started':
      return 'restore_recovery_required'
    case 'restore_target_verified':
      return 'target_verified_cleanup_required'
    default:
      return 'no_worktree_mutation'
  }
}

export class CheckpointJournalController {
  async inspect(store: CheckpointStore): Promise<JournalInspection> {
    let text: string | null
    try {
      text = await readControlText(join(store.storeDir, JOURNAL_FILE))
    } catch {
      return { kind: 'corrupt', digest: digest('unreadable-journal'), record: null }
    }
    if (text === null) return { kind: 'absent', digest: 'absent', record: null }
    const record = parseJournal(text)
    if (!record) return { kind: 'corrupt', digest: digest(text), record: null }
    return { kind: 'valid', digest: digest(text), record }
  }

  async assertClean(store: CheckpointStore): Promise<void> {
    const current = await this.inspect(store)
    if (current.kind !== 'absent') {
      throw new CheckpointInternalError(
        'recovery_required',
        current.kind === 'corrupt'
          ? 'checkpoint recovery journal is ambiguous'
          : 'checkpoint recovery journal must be resolved before continuing',
      )
    }
  }

  async write(
    store: CheckpointStore,
    lease: CheckpointLease,
    phase: CheckpointJournalPhase,
    details?: Pick<
      CheckpointJournalRecord,
      'checkpointId' | 'targetCheckpointId' | 'safetyCheckpointId' | 'sourceDigest'
    >,
  ): Promise<CheckpointJournalRecord> {
    const record: CheckpointJournalRecord = {
      version: 1,
      rootSha256: lease.rootSha256,
      ownerNonce: lease.ownerNonce,
      generation: lease.generation,
      operation: operationForPhase(phase),
      phase,
      ...details,
    }
    await writeControlJson(join(store.storeDir, JOURNAL_FILE), record)
    await emitCheckpointTestPhase(phase)
    return record
  }

  async clear(store: CheckpointStore): Promise<void> {
    await removeControlFile(join(store.storeDir, JOURNAL_FILE))
  }
}
