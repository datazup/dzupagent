import { createHash, randomUUID } from 'node:crypto'
import { loadTaskForRecovery, recoveredTaskPayload, writeRecoveredTask } from './drizzle-task-store.js'
import type { A2AV1RecoveryStore, OperationRow, ScanTimings } from './operation-store.js'
import {
  NOT_STARTED_TEXT, TERMINAL_STATE_NAME, TERMINAL_TASK_STATES, parseInspectAnswer, parseTextParts, receiptRecord,
  type A2AExecutionPort, type InspectAnswer, type TerminalOutcome, type TextPart,
} from './recovery-port.js'

/**
 * A2A-M3-RECOVERY-20261111-R1 (admission 972a4583). The scanner and the late-result path only ever inspect and write
 * recovery state: neither has an executor, so neither can start (or restart) work.
 */

const GENERIC = 'Internal server error'
const DEFAULTS = { minAgeMs: 60_000, claimTtlMs: 300_000, inspectTimeoutMs: 10_000, batch: 50 }

export interface RecoverOptions {
  /** Operations younger than this are not claimed (default 60 000). Hosts call again after it for a fresh crash. */
  minAgeMs?: number
  /** A claim older than this is expired and can be reclaimed (default 300 000). */
  claimTtlMs?: number
  /** A slower inspect is `unknown` (default 10 000). */
  inspectTimeoutMs?: number
  batch?: number
}

export type RecoveryOutcome = 'terminal' | 'attached' | 'not_applied' | 'recovery_required' | 'finished' | 'superseded' | 'stale'

export interface RecoveryResult {
  operationKey: string
  outcome: RecoveryOutcome
}

const timingsOf = (options: RecoverOptions): ScanTimings => ({
  minAgeMs: options.minAgeMs ?? DEFAULTS.minAgeMs, claimTtlMs: options.claimTtlMs ?? DEFAULTS.claimTtlMs,
})

const isTerminalState = (state: string | undefined): boolean => state !== undefined && (TERMINAL_TASK_STATES as readonly string[]).includes(state)

/** Total: a missing port, a throw, a timeout or a malformed answer is `undefined` (unknown). Nothing is ever guessed. */
async function inspectSafely(port: A2AExecutionPort | undefined, row: OperationRow, timeoutMs: number): Promise<InspectAnswer | undefined> {
  if (!port) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race([
      Promise.resolve(port.inspect({ operationKey: row.operationKey, tenantId: row.tenantId, taskId: row.taskId })),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('inspect timeout')), timeoutMs) }),
    ])
    return parseInspectAnswer(answer)
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Writes a terminal task status for a claimed row. Returns `written` false when the M2 guard or the claim fence refused it. */
async function writeTerminal(
  recovery: A2AV1RecoveryStore, row: OperationRow, token: string, state: string, parts: TextPart[],
): Promise<'written' | 'already_terminal' | 'fenced' | 'no_task'> {
  const scope = { tenantId: row.tenantId, ownerKey: row.ownerKey }
  const stored = await loadTaskForRecovery(recovery.db, scope, row.taskId)
  if (!stored) return 'no_task'
  if (isTerminalState(stored.state)) return 'already_terminal'
  const payload = recoveredTaskPayload(stored.task, state, `recovery-${row.operationKey.slice(-12)}`, parts)
  if (await writeRecoveredTask(recovery.db, scope, row.taskId, payload, token)) return 'written'
  // Refused: either a live completion won in the meantime, or the claim fence failed (stale token, superseded generation).
  const after = await loadTaskForRecovery(recovery.db, scope, row.taskId)
  return after && isTerminalState(after.state) ? 'already_terminal' : 'fenced'
}

async function resolveClaimed(
  recovery: A2AV1RecoveryStore, row: OperationRow, token: string, port: A2AExecutionPort | undefined, inspectTimeoutMs: number,
): Promise<RecoveryOutcome> {
  const scope = { tenantId: row.tenantId, ownerKey: row.ownerKey }
  const task = await loadTaskForRecovery(recovery.db, scope, row.taskId)
  // P_FINISH: a previous scanner wrote the terminal task state and died before the operation write. Finish the operation row only.
  if (task && isTerminalState(task.state)) {
    return (await recovery.finish(row, token, { resolve: true })) ? 'finished' : 'stale'
  }
  const answer = await inspectSafely(port, row, inspectTimeoutMs)
  if (!answer) {
    return (await recovery.finish(row, token, { recoveryState: 'recovery_required' })) ? 'recovery_required' : 'stale'
  }
  if (answer.status === 'running') {
    const receipt = receiptRecord(answer.receiptRef, 'running', 0)
    return (await recovery.finish(row, token, { recoveryState: 'attached', receipt })) ? 'attached' : 'stale'
  }
  const terminal = answer.status === 'terminal'
  const state = terminal ? TERMINAL_STATE_NAME[answer.terminal!.state] : 'TASK_STATE_FAILED'
  const parts: TextPart[] = terminal && answer.terminal!.parts ? answer.terminal!.parts : [{ text: terminal ? 'Task finished' : NOT_STARTED_TEXT }]
  const written = await writeTerminal(recovery, row, token, state, parts)
  if (written === 'already_terminal' || written === 'fenced') {
    // A live completion (or a later generation) won: nothing to write; the operation is finished and recovery_state is unchanged.
    return (await recovery.finish(row, token, { resolve: true })) ? 'superseded' : 'stale'
  }
  const done = await recovery.finish(row, token, terminal ? { resolve: true, recoveryState: null } : { resolve: true, recoveryState: 'not_applied' })
  if (!done) return 'stale'
  return terminal ? 'terminal' : 'not_applied'
}

/**
 * Resolves every orphaned non-terminal A2A v1 task after a restart to exactly one of: a terminal task state, attached through a
 * receipted `running` inspect answer, or `recovery_required`. Call once at startup (and again after `minAgeMs` / `claimTtlMs` for
 * a crash that is that recent). It never calls an executor and never dispatches.
 */
export async function recoverOrphanedA2AV1Tasks(
  recovery: A2AV1RecoveryStore, port: A2AExecutionPort | undefined, options: RecoverOptions = {},
): Promise<RecoveryResult[]> {
  const timings = timingsOf(options)
  const inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULTS.inspectTimeoutMs
  const results: RecoveryResult[] = []
  const seen = new Set<string>()
  let limit = options.batch ?? DEFAULTS.batch
  for (;;) {
    const raw = await recovery.candidates(timings, limit)
    const batch = raw.filter((row) => !seen.has(row.operationKey))
    if (batch.length === 0) {
      // Rows that failed to claim (or were released) stay candidates: widen the page instead of ending while later rows remain.
      if (raw.length < limit || limit >= 5000) return results
      limit *= 2
      continue
    }
    for (const candidate of batch) {
      seen.add(candidate.operationKey)
      const token = randomUUID()
      const claimed = await recovery.claimScan(candidate, token, timings)
      if (!claimed) continue
      try {
        results.push({ operationKey: claimed.operationKey, outcome: await resolveClaimed(recovery, claimed, token, port, inspectTimeoutMs) })
      } catch {
        recovery.log({ level: 'error', operation: 'a2a.v1.recovery.scan' })
        // A failure after the claim (for example an oversized result) must still leave a visible, deterministic end state:
        // flag the row recovery_required. Only if that write fails too does the claim expire; an expired scan claim is
        // reclaimable in any boot, so the row is never silently lost.
        try {
          if (await recovery.finish(claimed, token, { recoveryState: 'recovery_required' })) {
            results.push({ operationKey: claimed.operationKey, outcome: 'recovery_required' })
          }
        } catch { /* the claim expires */ }
      }
    }
  }
}

export interface LateResult {
  state: TerminalOutcome
  parts: TextPart[]
}

export type LateOutcome = 'applied' | 'applied_noop' | 'recorded' | 'stale' | 'busy' | 'refused'

/**
 * Host-only (no route): the trusted port owner reports a result that arrived after recovery. It never calls an executor and never
 * stores the result body in `recovery_receipt`. Terminal and not_applied rows only record `{digest, state, byteLength}`; attached
 * and recovery_required rows apply the result through the terminal guard under a fresh claim.
 */
export async function applyLateResult(
  recovery: A2AV1RecoveryStore, operationKey: string, result: LateResult, options: RecoverOptions = {},
): Promise<LateOutcome> {
  const parts = parseTextParts(result?.parts)
  if (!parts || typeof result.state !== 'string' || !Object.hasOwn(TERMINAL_STATE_NAME, result.state)) return 'refused'
  const timings = timingsOf(options)
  const byteLength = parts.reduce((total, part) => total + Buffer.byteLength(part.text, 'utf8'), 0)
  const digest = `sha256:${createHash('sha256').update(JSON.stringify([result.state, parts])).digest('hex')}`
  const record = receiptRecord(digest, result.state, byteLength)
  const row = await recovery.byKey(operationKey)
  if (!row) return 'refused'
  if (!(await recovery.isLatest(row))) return 'stale'
  if (row.recoveryState === 'not_applied' || row.state === 'resolved') {
    return (await recovery.recordOnly(row, record)) ? 'recorded' : 'refused'
  }
  const token = randomUUID()
  const claimed = await recovery.claimLate(row, token, timings)
  if (!claimed) {
    const current = await recovery.byKey(operationKey)
    // busy = an unexpired late claim; an unexpired scan claim (or nothing to apply to) is refused.
    return current?.recoveryState === 'recovering' && current.claimKind === 'late' ? 'busy' : 'refused'
  }
  try {
    const written = await writeTerminal(recovery, claimed, token, TERMINAL_STATE_NAME[result.state], parts)
    if (written === 'written' || written === 'no_task') {
      return (await recovery.finish(claimed, token, { resolve: true, recoveryState: null, receipt: record })) ? 'applied' : 'busy'
    }
    if (written === 'fenced') {
      // The generation was superseded between the claim and the write: nothing may be applied.
      await recovery.finish(claimed, token, { resolve: true })
      return 'stale'
    }
    // The task is already terminal (a live completion won): nothing to apply; record it and resolve the row.
    return (await recovery.finish(claimed, token, { resolve: true, recoveryState: null, receipt: record })) ? 'applied_noop' : 'busy'
  } catch {
    recovery.log({ level: 'error', operation: 'a2a.v1.recovery.late-result' })
    throw new Error(GENERIC)
  }
}
