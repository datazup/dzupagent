/**
 * RunJournalBridgeRunStore -- wraps a RunStore to dual-write into a RunJournal.
 *
 * When the feature flag is enabled, all state changes are also written to the
 * journal, making it the canonical audit trail. The wrapped store remains the
 * primary query interface (no reads go through the journal yet).
 *
 * Feature flag: set `useRunJournal: true` in config to enable dual-write.
 * When disabled, this is a transparent pass-through with zero overhead.
 */

import type {
  RunStore,
  Run,
  CreateRunInput,
  RunFilter,
  LogEntry,
  RunStatus,
} from './store-interfaces.js'
import type { RunJournal, RunJournalEntryType } from './run-journal-types.js'

export class RunJournalBridgeRunStore implements RunStore {
  constructor(
    private readonly store: RunStore,
    private readonly journal: RunJournal,
    private readonly enabled: boolean = false,
  ) {}

  async create(input: CreateRunInput): Promise<Run> {
    const run = await this.store.create(input)
    if (this.enabled) {
      try {
        await this.journal.append(run.id, {
          type: 'run_started',
          data: { input: input.input ?? null, agentId: input.agentId },
        })
      } catch {
        // Journal write is non-fatal -- run creation already succeeded
      }
    }
    return run
  }

  async update(id: string, patch: Partial<Run>): Promise<void> {
    await this.store.update(id, patch)
    if (this.enabled && patch.status) {
      const entryType = statusToJournalEntryType(patch.status)
      if (entryType) {
        try {
          await this.journal.append(id, {
            type: entryType,
            data: buildJournalData(entryType, patch),
          })
        } catch {
          // Journal write is non-fatal -- store update already succeeded
        }
      }
    }
  }

  async get(id: string): Promise<Run | null> {
    return this.store.get(id)
  }

  async list(filter?: RunFilter): Promise<Run[]> {
    return this.store.list(filter)
  }

  async addLog(runId: string, entry: LogEntry): Promise<void> {
    await this.store.addLog(runId, entry)
    // Logs are not journaled individually (too noisy)
  }

  async addLogs(runId: string, entries: LogEntry[]): Promise<void> {
    await this.store.addLogs(runId, entries)
  }

  async getLogs(runId: string): Promise<LogEntry[]> {
    return this.store.getLogs(runId)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_TO_ENTRY_TYPE: Partial<Record<RunStatus, RunJournalEntryType>> = {
  completed: 'run_completed',
  failed: 'run_failed',
  cancelled: 'run_cancelled',
  paused: 'run_paused',
  suspended: 'run_suspended',
  running: 'run_resumed',
}

function statusToJournalEntryType(
  status: RunStatus,
): RunJournalEntryType | null {
  return STATUS_TO_ENTRY_TYPE[status] ?? null
}

/**
 * Build the `data` payload for a journal entry based on the entry type and
 * the partial Run patch. Each entry type has a specific `data` shape defined
 * in run-journal-types.ts; we populate what we can from the patch.
 */
function buildJournalData(
  entryType: RunJournalEntryType,
  patch: Partial<Run>,
): Record<string, unknown> {
  switch (entryType) {
    case 'run_completed':
      return {
        output: patch.output ?? null,
        ...(patch.tokenUsage
          ? {
              totalTokens:
                patch.tokenUsage.input + patch.tokenUsage.output,
            }
          : {}),
        ...(patch.costCents !== undefined
          ? { totalCostCents: patch.costCents }
          : {}),
      }
    case 'run_failed':
      return {
        error: patch.error ?? 'unknown error',
      }
    case 'run_cancelled':
      return {
        reason: (patch.metadata?.['cancelReason'] as string) ?? undefined,
      }
    case 'run_paused':
      return {
        reason:
          (patch.metadata?.['pauseReason'] as string) ?? 'cooperative',
      }
    case 'run_suspended':
      return {
        stepId: (patch.metadata?.['stepId'] as string) ?? 'unknown',
        reason: (patch.metadata?.['suspendReason'] as string) ?? undefined,
      }
    case 'run_resumed':
      return {
        resumeToken:
          (patch.metadata?.['resumeToken'] as string) ?? '',
        input: patch.input ?? undefined,
      }
    default:
      return { status: patch.status }
  }
}
