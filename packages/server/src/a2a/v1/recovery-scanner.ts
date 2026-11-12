import { createHash, randomUUID } from 'node:crypto'
import { loadTaskForRecovery, recoveredTaskPayload, writeRecoveredTask } from './drizzle-task-store.js'
import type { A2AV1RecoveryStore, OperationRow, ScanTimings } from './operation-store.js'
import type { DrizzleStoreDatabase } from '../../persistence/drizzle-store-types.js'
import {
  CANCELED_TEXT, NOT_STARTED_TEXT, RECOVERY_DEFAULTS, TERMINAL_STATE_NAME, TERMINAL_TASK_STATES, parseInspectAnswer, parseTextParts, receiptRecord,
  type A2AExecutionPort, type InspectAnswer, type InspectKind, type TerminalOutcome, type TextPart,
} from './recovery-port.js'

/**
 * A2A-M3-RECOVERY-20261111-R1 (admission 972a4583). The scanner and the late-result path only ever inspect and write
 * recovery state: neither has an executor, so neither can start (or restart) work.
 */

const GENERIC = 'Internal server error'

/** Raised inside a recovery transaction to roll it back when the claim is no longer ours. */
class StaleClaim extends Error {}
const DEFAULTS = { ...RECOVERY_DEFAULTS, batch: 50 }

export interface RecoverOptions {
  /** Operations younger than this are not claimed (default 60 000). Hosts call again after it for a fresh crash. */
  minAgeMs?: number
  /** A claim older than this is expired and can be reclaimed (default 300 000). */
  claimTtlMs?: number
  /** A slower inspect is `unknown` (default 10 000). */
  inspectTimeoutMs?: number
  batch?: number
}

export type RecoveryOutcome = 'terminal' | 'canceled' | 'attached' | 'not_applied' | 'recovery_required' | 'finished' | 'superseded' | 'stale'

export interface RecoveryResult {
  operationKey: string
  outcome: RecoveryOutcome
}

/**
 * One source of truth: a per-call value overrides the scanner's own use but must not contradict a value the host configured on the
 * recovery instance (compared against the instance's clamped value). Without an explicit instance value the per-call value, then the
 * instance value, then the default applies.
 */
function effectiveOptions(recovery: A2AV1RecoveryStore, options: RecoverOptions): { timings: ScanTimings; inspectTimeoutMs: number } {
  const pick = (name: 'minAgeMs' | 'claimTtlMs' | 'inspectTimeoutMs'): number => {
    const call = options[name]
    const configured = recovery[name]
    if (call !== undefined && recovery.explicit?.[name] && configured !== undefined && call !== configured) {
      throw new Error(`recovery option ${name} differs from the recovery instance`)
    }
    return call ?? configured ?? DEFAULTS[name]
  }
  const timings = { minAgeMs: pick('minAgeMs'), claimTtlMs: pick('claimTtlMs') }
  // An inspect must finish well inside the claim it runs under.
  return { timings, inspectTimeoutMs: Math.min(pick('inspectTimeoutMs'), Math.max(1, Math.floor(timings.claimTtlMs / 2))) }
}

const partBytes = (parts: TextPart[]): number => parts.reduce((total, part) => total + Buffer.byteLength(part.text, 'utf8'), 0)

const isTerminalState = (state: string | undefined): boolean => state !== undefined && (TERMINAL_TASK_STATES as readonly string[]).includes(state)

/** Raised by the timer of a bounded port call so a timeout is told from a throw; carries no data. */
class PortTimeout extends Error {}

/**
 * One bounded port call. A throw and a timeout each emit exactly one fixed, payload-free record (no id, scope, payload or error text)
 * and return `failed`; a slow port is never awaited past the bound.
 */
async function boundedPortCall(
  recovery: A2AV1RecoveryStore, call: () => unknown, timeoutMs: number, names: { thrown: string; timeout: string },
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      Promise.resolve().then(call),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new PortTimeout()), timeoutMs) }),
    ])
    return { ok: true, value }
  } catch (error) {
    recovery.log({ level: 'error', operation: error instanceof PortTimeout ? names.timeout : names.thrown })
    return { ok: false }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Total: a missing port, a throw, a timeout or a malformed answer is `undefined` (unknown). Nothing is ever guessed. */
async function inspectSafely(
  recovery: A2AV1RecoveryStore, port: A2AExecutionPort | undefined, row: OperationRow, kind: InspectKind, timeoutMs: number,
): Promise<InspectAnswer | undefined> {
  if (!port) return undefined
  const called = await boundedPortCall(
    recovery, () => port.inspect({ operationKey: row.operationKey, tenantId: row.tenantId, taskId: row.taskId, kind }), timeoutMs,
    { thrown: 'a2a.v1.recovery.inspect', timeout: 'a2a.v1.recovery.inspect-timeout' },
  )
  return called.ok ? parseInspectAnswer(called.value, kind) : undefined
}

/**
 * The cancel flow's one optional stop request (D15): called once per cancel claim by the request handler only (the scanner never calls
 * it), bounded, failures and timeouts logged with a fixed record. The outcome is ignored: only a later receipted inspect cancels.
 */
export async function requestStopSafely(
  recovery: A2AV1RecoveryStore, port: A2AExecutionPort | undefined, row: OperationRow, timeoutMs: number,
): Promise<void> {
  const stop = port?.requestStop
  if (!port || typeof stop !== 'function') return
  await boundedPortCall(
    recovery, () => stop.call(port, { operationKey: row.operationKey, tenantId: row.tenantId, taskId: row.taskId }), timeoutMs,
    { thrown: 'a2a.v1.recovery.stop', timeout: 'a2a.v1.recovery.stop-timeout' },
  )
}

type Committed = 'written' | 'already_terminal' | 'fenced' | 'no_task'

/**
 * Inside the per-task lock (`recovery.atomic`): writes a terminal task status for a claimed row. The recovery writer's fence is
 * evaluated by a statement that starts after the lock is held, so a claim replacement or a new generation cannot commit between the
 * check and the write. Returns why nothing was written when the M2 guard or the fence refused it.
 */
async function writeTerminalIn(
  tx: DrizzleStoreDatabase, row: OperationRow, token: string, state: string, parts: TextPart[],
): Promise<Committed> {
  const scope = { tenantId: row.tenantId, ownerKey: row.ownerKey }
  const stored = await loadTaskForRecovery(tx, scope, row.taskId)
  if (!stored) return 'no_task'
  if (isTerminalState(stored.state)) return 'already_terminal'
  const payload = recoveredTaskPayload(stored.task, state, `recovery-${row.operationKey.slice(-12)}`, parts)
  if (await writeRecoveredTask(tx, scope, row.taskId, payload, token)) return 'written'
  // Refused: either a live completion won in the meantime, or the claim fence failed (stale token, superseded generation).
  const after = await loadTaskForRecovery(tx, scope, row.taskId)
  return after && isTerminalState(after.state) ? 'already_terminal' : 'fenced'
}

/**
 * Resolves one claimed operation (scanner claims and the handler's cancel claim share it). The inspect kind follows the claimed row:
 * `started` is a dispatch, `cancel_pending` is a cancel. A cancel never ends `attached`: only a receipted `stopped`, `not_applied` or
 * `terminal` answer resolves it; anything else leaves `recovery_required` with the hold-back in force.
 */
export async function resolveClaimedOperation(
  recovery: A2AV1RecoveryStore, row: OperationRow, token: string, port: A2AExecutionPort | undefined, inspectTimeoutMs: number,
): Promise<RecoveryOutcome> {
  const cancel = row.state === 'cancel_pending'
  const scope = { tenantId: row.tenantId, ownerKey: row.ownerKey }
  const task = await loadTaskForRecovery(recovery.db, scope, row.taskId)
  // P_FINISH: a previous scanner wrote the terminal task state and died before the operation write. Finish the operation row only.
  if (task && isTerminalState(task.state)) {
    return (await recovery.finish(row, token, { resolve: true })) ? 'finished' : 'stale'
  }
  const answer = await inspectSafely(recovery, port, row, cancel ? 'cancel' : 'dispatch', inspectTimeoutMs)
  if (!answer || (cancel && answer.status === 'running')) {
    return (await recovery.finish(row, token, { recoveryState: 'recovery_required' })) ? 'recovery_required' : 'stale'
  }
  if (answer.status === 'running') {
    const receipt = receiptRecord(answer.receiptRef, 'running', 0)
    return (await recovery.finish(row, token, { recoveryState: 'attached', receipt })) ? 'attached' : 'stale'
  }
  const terminal = answer.status === 'terminal'
  // A cancel resolves to CANCELED on `stopped` and on `not_applied` (the work never started: a valid stop).
  const stopped = cancel && !terminal
  const state = terminal ? TERMINAL_STATE_NAME[answer.terminal!.state] : stopped ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED'
  const parts: TextPart[] = terminal && answer.terminal!.parts ? answer.terminal!.parts
    : [{ text: terminal ? 'Task finished' : stopped ? CANCELED_TEXT : NOT_STARTED_TEXT }]
  // A cancel always stores its receipt and ends with no recovery state; the dispatch kind keeps its M3a record.
  const receipt = cancel ? receiptRecord(answer.receiptRef, terminal ? answer.terminal!.state : answer.status, 0) : undefined
  // The task write and the operation write are one transaction under the per-task lock.
  return recovery.atomic(row, async (tx): Promise<RecoveryOutcome> => {
    const written = await writeTerminalIn(tx, row, token, state, parts)
    if (written === 'already_terminal' || written === 'fenced') {
      // A live completion (or a later generation) won: nothing to write; the operation is finished and recovery_state is unchanged.
      return (await recovery.finish(row, token, { resolve: true }, tx)) ? 'superseded' : 'stale'
    }
    const done = await recovery.finish(row, token, cancel
      ? { resolve: true, recoveryState: null, receipt }
      : terminal ? { resolve: true, recoveryState: null } : { resolve: true, recoveryState: 'not_applied' }, tx)
    if (!done) throw new StaleClaim()
    return stopped ? 'canceled' : terminal ? 'terminal' : 'not_applied'
  }).catch((error: unknown) => {
    // A stale claim after the write attempt rolls the whole transaction back: neither the task nor the operation changed.
    if (error instanceof StaleClaim) return 'stale' as const
    throw error
  })
}

/**
 * Resolves every orphaned non-terminal A2A v1 task after a restart to exactly one of: a terminal task state, attached through a
 * receipted `running` inspect answer, or `recovery_required`. Call once at startup (and again after `minAgeMs` / `claimTtlMs` for
 * a crash that is that recent). It never calls an executor and never dispatches.
 */
export async function recoverOrphanedA2AV1Tasks(
  recovery: A2AV1RecoveryStore, passedPort: A2AExecutionPort | undefined, options: RecoverOptions = {},
): Promise<RecoveryResult[]> {
  // The port comes from the recovery instance; a passed port is accepted only when the instance has none (every M3a call).
  if (recovery.port !== undefined && passedPort !== undefined && recovery.port !== passedPort) {
    throw new Error('the passed port differs from the recovery instance port')
  }
  const port = recovery.port ?? passedPort
  const { timings, inspectTimeoutMs } = effectiveOptions(recovery, options)
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
        results.push({ operationKey: claimed.operationKey, outcome: await resolveClaimedOperation(recovery, claimed, token, port, inspectTimeoutMs) })
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
  const { timings } = effectiveOptions(recovery, options)
  const byteLength = partBytes(parts)
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
    return await recovery.atomic(claimed, async (tx): Promise<LateOutcome> => {
      const written = await writeTerminalIn(tx, claimed, token, TERMINAL_STATE_NAME[result.state], parts)
      if (written === 'written' || written === 'no_task') {
        if (!(await recovery.finish(claimed, token, { resolve: true, recoveryState: null, receipt: record }, tx))) throw new StaleClaim()
        return 'applied'
      }
      if (written === 'fenced') {
        // The generation was superseded between the claim and the write: nothing may be applied.
        await recovery.finish(claimed, token, { resolve: true }, tx)
        return 'stale'
      }
      // The task is already terminal (a live completion won): nothing to apply; record it and resolve the row.
      if (!(await recovery.finish(claimed, token, { resolve: true, recoveryState: null, receipt: record }, tx))) throw new StaleClaim()
      return 'applied_noop'
    })
  } catch (error) {
    // The claim was lost while writing: the transaction rolled back, nothing changed.
    if (error instanceof StaleClaim) return 'busy'
    recovery.log({ level: 'error', operation: 'a2a.v1.recovery.late-result' })
    throw new Error(GENERIC)
  }
}
