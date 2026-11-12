import { createHash } from 'node:crypto'

/**
 * A2A-M3-RECOVERY-20261111-R1 (admission 972a4583): the read-only inspect port and the pure rules built on it.
 * The port can only inspect a dispatch effect; DzupAgent recovery has no way to start work.
 */

/** `begin` refused: the message already has an operation under recovery. The executor must not be invoked. */
export class OperationRefusedError extends Error {
  constructor() { super('A2A v1 operation refused') }
}

export const RECOVERY_REQUIRED_TEXT = 'Recovery required; the operator is informed'
export const CANCEL_REFUSED_TEXT = 'Task cannot be canceled while recovery is pending'
export const NOT_STARTED_TEXT = 'Task was not started; resubmit'
/** Defaults shared by the handler's cancel flow and the scanner. */
export const RECOVERY_DEFAULTS = { minAgeMs: 60_000, claimTtlMs: 300_000, inspectTimeoutMs: 10_000 } as const
/** Fixed advisory-lock namespace (the bigint seed of hashtextextended) and key for every writer of one task's recovery state. */
export const TASK_LOCK_SEED = 4121955
export const taskLockKey = (scope: { tenantId: string; ownerKey: string; taskId: string }): string =>
  `a2a:v1:recovery:${JSON.stringify([scope.tenantId, scope.ownerKey, scope.taskId])}`
export const CANCELED_TEXT = 'Task was canceled'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
export const MAX_RESULT_BYTES = 1024 * 1024
/** Bounds applied before any copy, serialization or hashing of a port answer or late result. */
export const MAX_PARTS = 256
export const MAX_MEDIA_TYPE_CHARS = 256

export type InspectKind = 'dispatch' | 'cancel'
/** `stopped` is a cancel-kind answer only: the Worker side confirms the work has stopped. */
export type InspectStatus = 'running' | 'terminal' | 'not_applied' | 'stopped'
export type TerminalOutcome = 'completed' | 'failed' | 'canceled' | 'rejected'

export interface InspectRequest {
  operationKey: string
  tenantId: string
  taskId: string
  /** M3b: which effect is being inspected. The scanner and the cancel flow always send it. */
  kind: InspectKind
}

export interface StopRequest {
  operationKey: string
  tenantId: string
  taskId: string
}

export interface TextPart {
  text: string
  mediaType?: string
}

export interface InspectAnswer {
  status: InspectStatus
  /** `sha256:<64 lowercase hex>`; an answer without a valid receipt is never accepted. */
  receiptRef: string
  terminal?: { state: TerminalOutcome; parts?: TextPart[] }
}

/** Read-only, definitive inspect port. The Worker/Steward adapter lives in Scripts (M3b part c); tests use a labelled fake. */
export interface A2AExecutionPort {
  inspect(request: InspectRequest): Promise<unknown> | unknown
  /**
   * Optional host hook (M3b D3/D15): best-effort request to stop the work, called once per cancel claim by the request handler only
   * (never by the scanner), bounded by the inspect timeout. Its outcome is ignored: only a later receipted inspect answer cancels.
   */
  requestStop?(request: StopRequest): Promise<unknown> | unknown
}

export const TERMINAL_TASK_STATES = [
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED',
] as const
const SCANNED_TASK_STATES = ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']
/** The task states in which a dispatch (and so a cancel claim) can still be outstanding. */
export const isDispatchOutstanding = (taskState: string): boolean => SCANNED_TASK_STATES.includes(taskState)

export const TERMINAL_STATE_NAME: Record<TerminalOutcome, string> = {
  completed: 'TASK_STATE_COMPLETED', failed: 'TASK_STATE_FAILED', canceled: 'TASK_STATE_CANCELED', rejected: 'TASK_STATE_REJECTED',
}

const isTerminalTaskState = (state: string): boolean => (TERMINAL_TASK_STATES as readonly string[]).includes(state)

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Text parts only, at least one, at most MAX_RESULT_BYTES in total. Returns undefined when invalid. */
export function parseTextParts(value: unknown): TextPart[] | undefined {
  try {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PARTS) return undefined
    let bytes = 0
    const parts: TextPart[] = []
    for (const entry of value) {
      if (!record(entry) || typeof entry.text !== 'string') return undefined
      // Only `text` and `mediaType` are accepted: any other field (metadata, filename, raw, url, data, ...) is rejected unread.
      const keys = Object.keys(entry)
      if (keys.length > 2 || keys.some((key) => key !== 'text' && key !== 'mediaType')) return undefined
      if (entry.mediaType !== undefined && (typeof entry.mediaType !== 'string' || entry.mediaType.length > MAX_MEDIA_TYPE_CHARS)) return undefined
      if (entry.text.length > MAX_RESULT_BYTES) return undefined
      bytes += Buffer.byteLength(entry.text, 'utf8') + (typeof entry.mediaType === 'string' ? Buffer.byteLength(entry.mediaType, 'utf8') : 0)
      if (bytes > MAX_RESULT_BYTES) return undefined
      parts.push({ text: entry.text, ...(typeof entry.mediaType === 'string' ? { mediaType: entry.mediaType } : {}) })
    }
    return parts
  } catch {
    return undefined
  }
}

/**
 * "A positive, receipted report resolves; unknown is never guessed." Anything that is not a valid, receipted
 * answer is `undefined`, which callers treat as unknown. `stopped` is accepted only for the cancel kind.
 */
export function parseInspectAnswer(raw: unknown, kind: InspectKind = 'dispatch'): InspectAnswer | undefined {
  try {
    if (!record(raw)) return undefined
    const { status, receiptRef, terminal } = raw
    if (status !== 'running' && status !== 'terminal' && status !== 'not_applied' && !(status === 'stopped' && kind === 'cancel')) return undefined
    if (typeof receiptRef !== 'string' || !DIGEST.test(receiptRef)) return undefined
    if (status !== 'terminal') return { status, receiptRef }
    if (!record(terminal) || typeof terminal.state !== 'string' || !Object.hasOwn(TERMINAL_STATE_NAME, terminal.state)) return undefined
    if (terminal.parts === undefined) return { status, receiptRef, terminal: { state: terminal.state as TerminalOutcome } }
    const parts = parseTextParts(terminal.parts)
    return parts ? { status, receiptRef, terminal: { state: terminal.state as TerminalOutcome, parts } } : undefined
  } catch {
    return undefined
  }
}

/** Worker-visible dedupe key: derived from the scoped task and the generation; matches `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`. */
export function operationKeyFor(tenantId: string, ownerKey: string, taskId: string, generation: number): string {
  const hash = createHash('sha256').update(JSON.stringify([tenantId, ownerKey, taskId])).digest('hex').slice(0, 32)
  return `a2a:v1:${hash}:${generation}`
}

/** Fixed-shape receipt record: never a result body. */
export function receiptRecord(digest: string, state: string, byteLength: number): string {
  return JSON.stringify({ digest, state, byteLength })
}

export interface OperationView {
  operationKey: string
  generation: number
  state: 'started' | 'resolved' | string
  recoveryState: string | null
  claimKind: string | null
  bootId: string
}

/** Projection applies only to the latest `started` or `cancel_pending` operation of a non-terminal task. */
export function shouldProjectRecovery(operation: OperationView | undefined, taskState: string): boolean {
  if (!operation || (operation.state !== 'started' && operation.state !== 'cancel_pending') || isTerminalTaskState(taskState)) return false
  return operation.recoveryState === 'recovery_required' ||
    (operation.recoveryState === 'recovering' && operation.claimKind === 'late')
}

/**
 * The cancel guard of a recovery instance WITHOUT a port (with a port, the handler-owned cancel flow supersedes it). Refuse when the
 * latest operation is `cancel_pending` on a non-terminal task (a leftover row must not produce an unexplained cancel), or is `started` on
 * a non-terminal task and either (a) a recovery state is set (other than not_applied) or (b) it belongs to another boot and the task is
 * SUBMITTED/WORKING.
 */
export function cancelGuardRefuses(operation: OperationView | undefined, taskState: string, currentBoot: string): boolean {
  if (!operation || isTerminalTaskState(taskState)) return false
  if (operation.state === 'cancel_pending') return true
  if (operation.state !== 'started') return false
  if (operation.recoveryState !== null && operation.recoveryState !== 'not_applied') return true
  return operation.bootId !== currentBoot && SCANNED_TASK_STATES.includes(taskState)
}
