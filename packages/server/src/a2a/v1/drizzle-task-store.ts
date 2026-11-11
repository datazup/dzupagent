import { Task, TaskState, taskStateToJSON } from '@a2a-js/sdk'
import type { ListTasksRequest, ListTasksResponse } from '@a2a-js/sdk'
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import { and, desc, eq, gt, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { a2aV1Tasks } from '../../persistence/drizzle-schema.js'
import type { DrizzleMutationResult, DrizzleStoreDatabase } from '../../persistence/drizzle-store-types.js'
import { dzupOwnerResolver } from './identity.js'

const MAX_BYTES = 1024 * 1024
const STATES = new Set([
  'TASK_STATE_UNSPECIFIED', 'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED',
])
const TERMINAL = [
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED',
]

interface StoreLog {
  level: 'error' | 'warn'
  operation: 'a2a.v1.store.malformed-row' | 'a2a.v1.store.terminal-write' | 'a2a.v1.store.serialization'
}

export interface StoreOptions {
  /** Server-side diagnostics only. No payload, id, scope, or driver text is logged here. */
  logger?: (entry: StoreLog) => void
  /**
   * M3b: hold back a CANCELED save while the task's latest operation is `cancel_pending` (a silent drop, like the M2 terminal fence).
   * Required when the recovery instance has a port: the handler writes CANCELED itself, only on a receipted stop. Without this option
   * `save` is the M2 statement byte for byte and never references the operations table.
   */
  cancelHoldBack?: true
}

// The common database surface intentionally omits driver-specific upsert methods.
// Both supported Postgres Drizzle drivers supply this capability; keep the
// additional structural contract local rather than widening every server store.
interface GuardedInsert extends DrizzleMutationResult {
  onConflictDoUpdate(config: { target: unknown; set: unknown; setWhere: SQL }): DrizzleMutationResult
}

/**
 * P_HOLDBACK: refuse a CANCELED write while the LATEST operation of the task is `cancel_pending` (a superseded generation never holds
 * back). Evaluated only when the store was constructed with the hold-back option. Built lazily like the recovery predicates.
 */
const heldBack = (): SQL => sql`not (excluded.state = 'TASK_STATE_CANCELED' and exists (
  select 1 from "a2a_v1_operations" "oh" where "oh"."tenant_id" = ${a2aV1Tasks.tenantId} and "oh"."owner_key" = ${a2aV1Tasks.ownerKey}
    and "oh"."task_id" = ${a2aV1Tasks.id} and "oh"."state" = 'cancel_pending'
    and "oh"."generation" = (select max("o2"."generation") from "a2a_v1_operations" "o2"
      where "o2"."tenant_id" = "oh"."tenant_id" and "o2"."owner_key" = "oh"."owner_key" and "o2"."task_id" = "oh"."task_id")))`

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value)
}

const string = (value: unknown): value is string => typeof value === 'string'
const strings = (value: unknown): boolean => Array.isArray(value) && value.every(string)
const metadata = (value: unknown): boolean => optional(value, record)
const timestamp = (value: unknown): value is string => string(value) && Number.isFinite(Date.parse(value))

function part(value: unknown): boolean {
  if (!record(value) || !metadata(value.metadata)) return false
  if (!optional(value.filename, string) || !optional(value.mediaType, string)) return false
  const fields = ['text', 'raw', 'url', 'data'].filter((key) => Object.hasOwn(value, key))
  return fields.length === 1 && (fields[0] === 'data' || string(value[fields[0]!]))
}

function message(value: unknown): boolean {
  return record(value) && string(value.messageId) && value.messageId.length > 0 &&
    optional(value.role, (role) => string(role) && ['ROLE_USER', 'ROLE_AGENT', 'ROLE_UNSPECIFIED'].includes(role)) &&
    optional(value.contextId, string) && optional(value.taskId, string) &&
    Array.isArray(value.parts) && value.parts.length > 0 && value.parts.every(part) &&
    metadata(value.metadata) && optional(value.extensions, strings) && optional(value.referenceTaskIds, strings)
}

function artifact(value: unknown): boolean {
  return record(value) && string(value.artifactId) && value.artifactId.length > 0 &&
    optional(value.name, string) && optional(value.description, string) &&
    Array.isArray(value.parts) && value.parts.length > 0 && value.parts.every(part) &&
    metadata(value.metadata) && optional(value.extensions, strings)
}

/** Validate before using the permissive protobuf codec, which otherwise coerces malformed rows. */
function taskJSON(value: unknown): value is Record<string, unknown> {
  return record(value) && string(value.id) && value.id.length > 0 &&
    string(value.contextId) && value.contextId.length > 0 && record(value.status) &&
    optional(value.status.state, (state) => string(state) && STATES.has(state)) &&
    optional(value.status.timestamp, timestamp) && optional(value.status.message, message) &&
    optional(value.history, (v) => Array.isArray(v) && v.every(message)) &&
    optional(value.artifacts, (v) => Array.isArray(v) && v.every(artifact)) && metadata(value.metadata)
}

/** Explicit opt-in SDK TaskStore. The M1 sanitizer must remain the outer wrapper. */
export class DrizzleA2AV1TaskStore implements TaskStore {
  /** True only when the store was constructed with the hold-back; `createA2AV1Handler` checks it when recovery has a port. */
  readonly cancelHoldBack: boolean

  constructor(private readonly db: DrizzleStoreDatabase, private readonly opts: StoreOptions = {}) {
    this.cancelHoldBack = opts.cancelHoldBack === true
  }

  private log(entry: StoreLog): void {
    try {
      if (this.opts.logger) this.opts.logger(entry)
      else console.error(JSON.stringify(entry))
    } catch { /* diagnostics must not change persistence semantics */ }
  }

  private scope(context: ServerCallContext): { tenantId: string; ownerKey: string } {
    const ownerKey = dzupOwnerResolver(context)
    if (!context.tenant) throw new Error('Internal server error')
    return { tenantId: context.tenant, ownerKey }
  }

  private decode(row: unknown): Task | undefined {
    try {
      if (!record(row) || !string(row.tenantId) || !string(row.ownerKey) ||
          !string(row.id) || !string(row.contextId) || !string(row.state) ||
          !taskJSON(row.task) || row.task.id !== row.id || row.task.contextId !== row.contextId ||
          !(row.createdAt instanceof Date) || !Number.isFinite(row.createdAt.getTime()) ||
          !(row.updatedAt instanceof Date) || !Number.isFinite(row.updatedAt.getTime())) throw new Error()
      const task = Task.fromJSON(row.task)
      if (taskStateToJSON(task.status!.state) !== row.state) throw new Error()
      const time = task.status!.timestamp
      if (time === undefined ? row.statusTimestamp !== null :
          !(row.statusTimestamp instanceof Date) || row.statusTimestamp.getTime() !== Date.parse(time)) throw new Error()
      return task
    } catch {
      this.log({ level: 'error', operation: 'a2a.v1.store.malformed-row' })
      return undefined
    }
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const scope = this.scope(context)
    let payload: Record<string, unknown>
    try {
      // The SDK codec preserves oneof parts and metadata in its public JSON format.
      const serialized = JSON.stringify(Task.toJSON(task))
      if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new Error()
      const parsed: unknown = JSON.parse(serialized)
      if (!taskJSON(parsed)) throw new Error()
      payload = parsed
    } catch {
      this.log({ level: 'error', operation: 'a2a.v1.store.serialization' })
      throw new Error('Internal server error')
    }
    const snapshot = Task.fromJSON(payload)
    const state = taskStateToJSON(snapshot.status!.state)
    const values = {
      ...scope, id: snapshot.id, contextId: snapshot.contextId, state,
      statusTimestamp: snapshot.status!.timestamp ? new Date(snapshot.status!.timestamp) : null,
      task: payload, updatedAt: new Date(),
    }
    const insert = this.db.insert(a2aV1Tasks).values(values) as unknown as GuardedInsert
    const rows = await insert.onConflictDoUpdate({
      target: [a2aV1Tasks.tenantId, a2aV1Tasks.ownerKey, a2aV1Tasks.id],
      set: {
        contextId: values.contextId, state, statusTimestamp: values.statusTimestamp, task: payload,
        updatedAt: sql`case when ${a2aV1Tasks.task} = excluded.task then ${a2aV1Tasks.updatedAt} else excluded.updated_at end`,
      },
      // A single row-level SQL fence: first terminal write wins, even across
      // independent store instances/connections. Identical retries are allowed.
      setWhere: and(
        eq(a2aV1Tasks.tenantId, scope.tenantId), eq(a2aV1Tasks.ownerKey, scope.ownerKey),
        or(notInArray(a2aV1Tasks.state, TERMINAL), sql`${a2aV1Tasks.task} = excluded.task`),
        ...(this.cancelHoldBack ? [heldBack()] : [])
      )!,
    }).returning({ id: a2aV1Tasks.id })
    if (rows.length === 0) this.log({ level: 'warn', operation: 'a2a.v1.store.terminal-write' })
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const scope = this.scope(context)
    const rows = await this.db.select().from(a2aV1Tasks).where(and(
      eq(a2aV1Tasks.tenantId, scope.tenantId), eq(a2aV1Tasks.ownerKey, scope.ownerKey), eq(a2aV1Tasks.id, taskId)
    )).limit(1)
    return rows.length ? this.decode(rows[0]) : undefined
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const scope = this.scope(context)
    const requested = params.pageSize ?? 50
    if (!Number.isInteger(requested) || requested < 1) throw new Error('Internal server error')
    const pageSize = Math.min(requested, 100)
    const conditions = [eq(a2aV1Tasks.tenantId, scope.tenantId), eq(a2aV1Tasks.ownerKey, scope.ownerKey)]
    if (params.contextId) conditions.push(eq(a2aV1Tasks.contextId, params.contextId))
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      conditions.push(eq(a2aV1Tasks.state, taskStateToJSON(params.status)))
    }
    if (params.statusTimestampAfter) {
      if (!timestamp(params.statusTimestampAfter)) throw new Error('Internal server error')
      conditions.push(gt(a2aV1Tasks.statusTimestamp, new Date(params.statusTimestampAfter)))
    }
    // Keyset pagination: the page query is bounded by LIMIT pageSize + 1 in SQL, so the scoped set is never
    // materialised. totalSize comes from a separate count over the same scoped, filtered predicate.
    // NULL timestamps sort last (the SDK treats an absent timestamp as "").
    // totalSize is the count of STORED rows matching the scope and filters. A malformed row that decode() drops from the
    // page is still counted: counting only decodable rows would need the whole scoped set decoded and would undo the SQL
    // bound above (pinned by G1.15).
    const counted = await this.db.select({ total: sql`count(*)` }).from(a2aV1Tasks).where(and(...conditions))
    const first = counted[0]
    const totalSize = Number(record(first) ? first.total : Number.NaN)
    if (!Number.isSafeInteger(totalSize) || totalSize < 0) throw new Error('Internal server error')
    const pageConditions = [...conditions]
    if (params.pageToken) {
      try {
        if (params.pageToken.length > MAX_BYTES * 2) throw new Error()
        const cursor: unknown = JSON.parse(Buffer.from(params.pageToken, 'base64url').toString('utf8'))
        if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== 1 || !string(cursor[1]) || !string(cursor[2])) throw new Error()
        const afterId = cursor[2]
        if (cursor[1] === '') {
          pageConditions.push(and(isNull(a2aV1Tasks.statusTimestamp), lt(a2aV1Tasks.id, afterId))!)
        } else {
          if (!timestamp(cursor[1])) throw new Error()
          const afterTime = new Date(cursor[1])
          pageConditions.push(or(
            lt(a2aV1Tasks.statusTimestamp, afterTime),
            and(eq(a2aV1Tasks.statusTimestamp, afterTime), lt(a2aV1Tasks.id, afterId)),
            isNull(a2aV1Tasks.statusTimestamp)
          )!)
        }
      } catch { throw new Error('Internal server error') }
    }
    const rows = await this.db.select().from(a2aV1Tasks).where(and(...pageConditions))
      .orderBy(sql`${a2aV1Tasks.statusTimestamp} desc nulls last`, desc(a2aV1Tasks.id))
      .limit(pageSize + 1)
    const pageRows = rows.slice(0, pageSize)
    const page = pageRows.flatMap((row) => { const task = this.decode(row); return task ? [task] : [] })
    const lastRow = pageRows[pageRows.length - 1]
    const nextPageToken = rows.length > pageSize && record(lastRow) && string(lastRow.id)
      ? Buffer.from(JSON.stringify([1, lastRow.statusTimestamp instanceof Date ? lastRow.statusTimestamp.toISOString() : '', lastRow.id])).toString('base64url') : ''
    if (!params.includeArtifacts) for (const task of page) task.artifacts = []
    return { tasks: page, nextPageToken, pageSize, totalSize }
  }
}

export function createDrizzleA2AV1TaskStore(db: DrizzleStoreDatabase, opts: StoreOptions = {}): DrizzleA2AV1TaskStore {
  return new DrizzleA2AV1TaskStore(db, opts)
}

/** Scope of a row as the scanner sees it: taken from the operation row, never from a caller. */
export interface RecoveryScope {
  tenantId: string
  ownerKey: string
}

/** Read the stored task JSON and state for recovery (no decode: the recovery writer only rewrites the status). */
export async function loadTaskForRecovery(
  db: DrizzleStoreDatabase, scope: RecoveryScope, taskId: string,
): Promise<{ state: string; task: Record<string, unknown> } | undefined> {
  const rows = await db.select().from(a2aV1Tasks).where(and(
    eq(a2aV1Tasks.tenantId, scope.tenantId), eq(a2aV1Tasks.ownerKey, scope.ownerKey), eq(a2aV1Tasks.id, taskId),
  )).limit(1)
  const row = rows[0]
  if (!record(row) || !string(row.state) || !record(row.task)) return undefined
  return { state: row.state, task: row.task }
}

/** Builds the recovered task JSON: the stored task with a new terminal status; validated by the same codec as `save`. */
export function recoveredTaskPayload(
  stored: Record<string, unknown>, state: string, messageId: string, parts: Array<{ text: string; mediaType?: string }>,
): Record<string, unknown> {
  const status = {
    state, timestamp: new Date().toISOString(),
    message: { messageId, role: 'ROLE_AGENT', parts: parts.map((part) => ({ text: part.text, mediaType: part.mediaType ?? 'text/plain' })) },
  }
  const next = { ...stored, status }
  const serialized = JSON.stringify(Task.toJSON(Task.fromJSON(next)))
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new Error('Internal server error')
  const parsed: unknown = JSON.parse(serialized)
  if (!taskJSON(parsed)) throw new Error('Internal server error')
  return parsed
}

/**
 * The single recovery task writer (M3a). It is the M2 guarded write with two differences: it is update-only (it never inserts a
 * task row) and its WHERE additionally requires the claim fence: the latest operation of the task must carry this claim token in
 * the `recovering` state. First terminal write still wins. Returns whether a row was written.
 *
 * Invariant: the caller holds the per-task advisory lock (recovery.atomic). The fence subquery below keeps this statement's snapshot even
 * if the UPDATE waits on the task-row lock (for example behind the SDK's own save); that is safe only because every writer of the
 * operations table takes the same advisory lock, so no operation row can change while this transaction is running.
 */
export async function writeRecoveredTask(
  db: DrizzleStoreDatabase, scope: RecoveryScope, taskId: string, payload: Record<string, unknown>, token: string,
): Promise<boolean> {
  const snapshot = Task.fromJSON(payload)
  const state = taskStateToJSON(snapshot.status!.state)
  const fence = sql`exists (select 1 from "a2a_v1_operations" "of" where "of"."tenant_id" = "a2a_v1_tasks"."tenant_id"
    and "of"."owner_key" = "a2a_v1_tasks"."owner_key" and "of"."task_id" = "a2a_v1_tasks"."id"
    and "of"."generation" = (select max("o2"."generation") from "a2a_v1_operations" "o2"
      where "o2"."tenant_id" = "of"."tenant_id" and "o2"."owner_key" = "of"."owner_key" and "o2"."task_id" = "of"."task_id")
    and "of"."claim_token" = ${token} and "of"."recovery_state" = 'recovering')`
  const rows = await db.update(a2aV1Tasks).set({
    contextId: snapshot.contextId, state, statusTimestamp: snapshot.status!.timestamp ? new Date(snapshot.status!.timestamp) : null,
    task: payload, updatedAt: new Date(),
  }).where(and(
    eq(a2aV1Tasks.tenantId, scope.tenantId), eq(a2aV1Tasks.ownerKey, scope.ownerKey), eq(a2aV1Tasks.id, taskId),
    notInArray(a2aV1Tasks.state, TERMINAL), fence,
  )!).returning({ id: a2aV1Tasks.id })
  return rows.length > 0
}
