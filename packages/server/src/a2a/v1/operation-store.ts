import { randomUUID } from 'node:crypto'
import type { ServerCallContext } from '@a2a-js/sdk/server'
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm'
import { a2aV1Operations } from '../../persistence/drizzle-schema.js'
import type { DrizzleStoreDatabase } from '../../persistence/drizzle-store-types.js'
import { dzupOwnerResolver } from './identity.js'
import { OperationRefusedError, RECOVERY_DEFAULTS, TASK_LOCK_SEED, TERMINAL_TASK_STATES, operationKeyFor, taskLockKey, type A2AExecutionPort, type OperationView } from './recovery-port.js'

/**
 * A2A-M3-RECOVERY-20261111-R1 (admission 972a4583): the operation ledger and the claim predicates.
 * Every predicate below is the one named in the admission (P_ORPHAN_DISPATCH, P_FINISH, P_CLAIM_SCAN, P_CLAIM_LATE,
 * P_RECORD_ONLY, P_TOKEN) and is a single SQL statement: the database surface has no transaction.
 */

const GENERIC = 'Internal server error'

export { OperationRefusedError }

export interface RecoveryLog {
  level: 'error' | 'warn'
  operation: string
}

export interface A2AV1RecoveryOptions {
  /** Fixed per process boot. Tests create a new instance per simulated restart. */
  bootId?: string
  /** Server-side diagnostics only: operation names, never ids, scope, payloads or driver text. */
  logger?: (entry: RecoveryLog) => void
  /**
   * M3b: the read-only inspect port. With a port the handler-owned cancel flow is active and the scanner takes the port from here.
   * The handler and the scanner share these timings so they cannot disagree about the claim TTL or the inspect bound.
   */
  port?: A2AExecutionPort
  /** A claim older than this is expired and reclaimable (default 300 000). */
  claimTtlMs?: number
  /** Operations younger than this are not scanned (default 60 000). */
  minAgeMs?: number
  /** One bounded wait for an inspect or a stop request, clamped to at most claimTtlMs / 4 (default 10 000). */
  inspectTimeoutMs?: number
}

export interface ScanTimings {
  minAgeMs: number
  claimTtlMs: number
}

export interface OperationRow extends OperationView {
  tenantId: string
  ownerKey: string
  taskId: string
  messageId: string
  claimToken: string | null
  recoveryReceipt: string | null
}

const op = (column: string): SQL => sql.raw(`"a2a_v1_operations"."${column}"`)
const interval = (ms: number): SQL => sql`(${ms}::double precision / 1000.0) * interval '1 second'`
// Built lazily: modules that mock drizzle-orm must not fail at import time.
const terminalList = (): SQL => sql.join(TERMINAL_TASK_STATES.map((state) => sql`${state}`), sql`, `)

const latest = (): SQL => sql`${op('generation')} = (select max("o2"."generation") from "a2a_v1_operations" "o2"
  where "o2"."tenant_id" = ${op('tenant_id')} and "o2"."owner_key" = ${op('owner_key')} and "o2"."task_id" = ${op('task_id')})`
const taskState = (): SQL => sql`(select "tk"."state" from "a2a_v1_tasks" "tk" where "tk"."tenant_id" = ${op('tenant_id')}
  and "tk"."owner_key" = ${op('owner_key')} and "tk"."id" = ${op('task_id')})`

function pOrphanDispatch(boot: string, t: ScanTimings): SQL {
  return sql`(${latest()} and ${op('state')} = 'started'
    and (${op('boot_id')} <> ${boot} or (${op('recovery_state')} = 'recovering' and ${op('claim_kind')} = 'scan'
         and ${op('recovery_updated_at')} < now() - ${interval(t.claimTtlMs)}))
    and ${op('created_at')} < now() - ${interval(t.minAgeMs)}
    and (${taskState()} is null or ${taskState()} in ('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING')))`
}

function pFinish(t: ScanTimings): SQL {
  return sql`(${latest()} and ${op('state')} in ('started', 'cancel_pending') and ${op('recovery_state')} = 'recovering'
    and ${op('claim_kind')} in ('scan', 'cancel')
    and ${op('recovery_updated_at')} < now() - ${interval(t.claimTtlMs)} and ${taskState()} in (${terminalList()}))`
}

function pClaimScan(t: ScanTimings): SQL {
  return sql`(${op('recovery_state')} is null or (${op('recovery_state')} = 'recovering' and ${op('claim_kind')} in ('scan', 'cancel')
    and ${op('recovery_updated_at')} < now() - ${interval(t.claimTtlMs)}))`
}

function pClaimLate(key: string, t: ScanTimings): SQL {
  return sql`(${latest()} and ${op('operation_key')} = ${key}
    and (${op('recovery_state')} in ('attached', 'recovery_required')
      or (${op('recovery_state')} = 'recovering' and ${op('claim_kind')} = 'late' and ${op('recovery_updated_at')} < now() - ${interval(t.claimTtlMs)})))`
}

/** P_ORPHAN_CANCEL: only an EXPIRED claim of a cancel_pending row, in any boot; expiry plus the token CAS is the fence. */
function pOrphanCancel(t: ScanTimings): SQL {
  return sql`(${latest()} and ${op('state')} = 'cancel_pending' and ${op('recovery_state')} = 'recovering'
    and ${op('claim_kind')} in ('scan', 'cancel') and ${op('recovery_updated_at')} < now() - ${interval(t.claimTtlMs)}
    and (${taskState()} is null or ${taskState()} in ('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING')))`
}

/** P_CLAIM_CANCEL: no boot and no age predicate; only an unexpired claim holds the row. */
function pClaimCancel(t: ScanTimings): SQL {
  return sql`(${latest()} and ${op('state')} in ('started', 'cancel_pending')
    and (${op('recovery_state')} is null or ${op('recovery_state')} <> 'recovering'
      or ${op('recovery_updated_at')} < now() - ${interval(t.claimTtlMs)}))`
}

const pToken = (token: string): SQL => sql`(${op('claim_token')} = ${token} and ${op('recovery_state')} = 'recovering')`

function toRow(raw: unknown): OperationRow | undefined {
  const row = raw as Record<string, unknown> | undefined
  if (!row || typeof row.operationKey !== 'string' || typeof row.tenantId !== 'string') return undefined
  return {
    tenantId: row.tenantId as string, ownerKey: row.ownerKey as string, taskId: row.taskId as string,
    generation: row.generation as number, operationKey: row.operationKey, messageId: row.messageId as string,
    bootId: row.bootId as string, state: row.state as string,
    recoveryState: (row.recoveryState as string | null) ?? null, claimKind: (row.claimKind as string | null) ?? null,
    claimToken: (row.claimToken as string | null) ?? null, recoveryReceipt: (row.recoveryReceipt as string | null) ?? null,
  }
}

/** Internal, row-scoped interface used by the scanner. It is not part of the SDK TaskStore and no route exposes it. */
export interface A2AV1RecoveryStore {
  readonly bootId: string
  readonly db: DrizzleStoreDatabase
  /**
   * M3b members are optional so any test-local store still compiles (a store without them has no cancel support and every call
   * takes the scanner's own defaults). `explicit` names the timings the host configured, which a per-call value must not contradict.
   */
  readonly port?: A2AExecutionPort
  readonly claimTtlMs?: number
  readonly minAgeMs?: number
  readonly inspectTimeoutMs?: number
  readonly explicit?: { claimTtlMs?: true; minAgeMs?: true; inspectTimeoutMs?: true }
  claimCancel?(context: ServerCallContext, taskId: string, token: string): Promise<OperationRow | undefined>
  /**
   * Runs `fn` in one transaction after taking the per-task advisory lock. Every writer of a task's recovery state (begin, claims,
   * finish, record, and the recovery task write together with its operation write) goes through it, so a writer's predicates are
   * evaluated by statements that start after the lock is held and no claim replacement or generation advance can commit in between.
   */
  atomic<T>(scope: { tenantId: string; ownerKey: string; taskId: string }, fn: (tx: DrizzleStoreDatabase) => Promise<T>): Promise<T>
  candidates(timings: ScanTimings, limit: number): Promise<OperationRow[]>
  claimScan(row: OperationRow, token: string, timings: ScanTimings): Promise<OperationRow | undefined>
  /** Compare-and-set under P_TOKEN. Returns whether the row was updated. */
  finish(row: OperationRow, token: string, set: { recoveryState?: string | null; receipt?: string | null; resolve?: boolean }, tx?: DrizzleStoreDatabase): Promise<boolean>
  release(row: OperationRow, token: string): Promise<void>
  byKey(operationKey: string): Promise<OperationRow | undefined>
  isLatest(row: OperationRow): Promise<boolean>
  claimLate(row: OperationRow, token: string, timings: ScanTimings): Promise<OperationRow | undefined>
  recordOnly(row: OperationRow, receipt: string): Promise<boolean>
  log(entry: RecoveryLog): void
}

type TransactionalDatabase = DrizzleStoreDatabase & {
  transaction<T>(fn: (tx: DrizzleStoreDatabase) => Promise<T>): Promise<T>
}

export class A2AV1Recovery implements A2AV1RecoveryStore {
  readonly bootId: string
  readonly port: A2AExecutionPort | undefined
  readonly claimTtlMs: number
  readonly minAgeMs: number
  readonly inspectTimeoutMs: number
  readonly explicit: { claimTtlMs?: true; minAgeMs?: true; inspectTimeoutMs?: true }

  /** `db` must support `transaction` (a drizzle database over a connection pool); a single shared client would interleave statements. */
  constructor(readonly db: DrizzleStoreDatabase, private readonly opts: A2AV1RecoveryOptions = {}) {
    if (typeof (db as Partial<TransactionalDatabase>).transaction !== 'function') {
      throw new Error('A2A v1 recovery requires a database with transaction support')
    }
    // A single shared client has `transaction` too, but concurrent transactions would interleave on one connection and advisory
    // locks are re-entrant within a session: the per-task lock would silently exclude nobody. node-postgres exposes the client as
    // `$client`; a Pool has `totalCount`, a plain Client does not.
    const client = (db as { $client?: { totalCount?: unknown } }).$client
    if (client !== undefined && typeof client.totalCount !== 'number') {
      throw new Error('A2A v1 recovery requires a connection pool, not a single shared client')
    }
    this.bootId = opts.bootId ?? randomUUID()
    this.port = opts.port
    for (const name of ['claimTtlMs', 'minAgeMs', 'inspectTimeoutMs'] as const) {
      const value = opts[name]
      if (value !== undefined && (!Number.isFinite(value) || value < (name === 'minAgeMs' ? 0 : 1))) throw new Error(`A2A v1 recovery option ${name} is invalid`)
    }
    this.claimTtlMs = opts.claimTtlMs ?? RECOVERY_DEFAULTS.claimTtlMs
    this.minAgeMs = opts.minAgeMs ?? RECOVERY_DEFAULTS.minAgeMs
    // The cancel flow waits twice in sequence (a stop request, then an inspect) inside one claim.
    this.inspectTimeoutMs = Math.max(1, Math.min(opts.inspectTimeoutMs ?? RECOVERY_DEFAULTS.inspectTimeoutMs, Math.floor(this.claimTtlMs / 4)))
    this.explicit = {
      ...(opts.claimTtlMs !== undefined ? { claimTtlMs: true as const } : {}),
      ...(opts.minAgeMs !== undefined ? { minAgeMs: true as const } : {}),
      ...(opts.inspectTimeoutMs !== undefined ? { inspectTimeoutMs: true as const } : {}),
    }
  }

  async atomic<T>(scope: { tenantId: string; ownerKey: string; taskId: string }, fn: (tx: DrizzleStoreDatabase) => Promise<T>): Promise<T> {
    const key = taskLockKey(scope)
    return (this.db as TransactionalDatabase).transaction(async (tx) => {
      // A select without a FROM clause is only a builder and never runs: give it a source so the lock is actually taken.
      await tx.select({ locked: sql`pg_advisory_xact_lock(hashtextextended(${key}, ${TASK_LOCK_SEED}))` }).from(sql`(select 1) as "lk"`)
      return fn(tx)
    })
  }

  log(entry: RecoveryLog): void {
    try {
      if (this.opts.logger) this.opts.logger(entry)
      else console.error(JSON.stringify(entry))
    } catch { /* diagnostics must not change recovery semantics */ }
  }

  private scope(context: ServerCallContext): { tenantId: string; ownerKey: string } {
    const ownerKey = dzupOwnerResolver(context)
    if (!context.tenant) throw new Error(GENERIC)
    return { tenantId: context.tenant, ownerKey }
  }

  /**
   * Called from `safeExecutor.execute` before every executor invocation. A new messageId gets generation = previous + 1;
   * a repeated messageId is one atomic UPDATE that re-stamps this boot and returns the same key. Zero rows from that UPDATE
   * with an existing row means the row has a recovery state, or is an older generation than the task's latest: the call is
   * refused and the executor is not invoked.
   */
  async begin(context: ServerCallContext, taskId: string, messageId: string): Promise<{ operationKey: string; generation: number }> {
    const scope = this.scope(context)
    const where = and(
      eq(a2aV1Operations.tenantId, scope.tenantId), eq(a2aV1Operations.ownerKey, scope.ownerKey),
      eq(a2aV1Operations.taskId, taskId), eq(a2aV1Operations.messageId, messageId),
    )
    // Under the per-task lock no other writer of this task runs, so a plain read-then-insert cannot collide.
    return this.atomic({ ...scope, taskId }, async (tx) => {
      const repeated = await tx.update(a2aV1Operations).set({ bootId: this.bootId })
        .where(and(where, isNull(a2aV1Operations.recoveryState), latest())).returning()
      const kept = toRow(repeated[0])
      if (kept) return { operationKey: kept.operationKey, generation: kept.generation }
      const existing = await tx.select().from(a2aV1Operations).where(where).limit(1)
      if (existing.length > 0) throw new OperationRefusedError()
      const top = await tx.select({ value: sql`coalesce(max(${a2aV1Operations.generation}), 0)` }).from(a2aV1Operations).where(and(
        eq(a2aV1Operations.tenantId, scope.tenantId), eq(a2aV1Operations.ownerKey, scope.ownerKey), eq(a2aV1Operations.taskId, taskId),
      ))
      const generation = Number((top[0] as { value?: unknown } | undefined)?.value ?? 0) + 1
      const operationKey = operationKeyFor(scope.tenantId, scope.ownerKey, taskId, generation)
      await tx.insert(a2aV1Operations).values({ ...scope, taskId, generation, operationKey, messageId, bootId: this.bootId, state: 'started' }).returning()
      return { operationKey, generation }
    })
  }

  /** True when this messageId already has an operation with a recovery state: a retry of it must be refused before the SDK runs. */
  async retryUnderRecovery(context: ServerCallContext, taskId: string, messageId: string): Promise<boolean> {
    const scope = this.scope(context)
    const rows = await this.db.select().from(a2aV1Operations).where(and(
      eq(a2aV1Operations.tenantId, scope.tenantId), eq(a2aV1Operations.ownerKey, scope.ownerKey),
      eq(a2aV1Operations.taskId, taskId), eq(a2aV1Operations.messageId, messageId),
    )).limit(1)
    const row = toRow(rows[0])
    return row !== undefined && row.recoveryState !== null
  }

  /** The latest operation of a task in the caller's scope, for projection and the cancel guard. */
  async latest(context: ServerCallContext, taskId: string): Promise<OperationView | undefined> {
    const scope = this.scope(context)
    const rows = await this.db.select().from(a2aV1Operations).where(and(
      eq(a2aV1Operations.tenantId, scope.tenantId), eq(a2aV1Operations.ownerKey, scope.ownerKey), eq(a2aV1Operations.taskId, taskId),
    )).orderBy(desc(a2aV1Operations.generation)).limit(1)
    return toRow(rows[0])
  }

  async candidates(t: ScanTimings, limit: number): Promise<OperationRow[]> {
    const rows = await this.db.select().from(a2aV1Operations)
      .where(sql`((${pOrphanDispatch(this.bootId, t)} or ${pOrphanCancel(t)} or ${pFinish(t)}) and ${pClaimScan(t)})`)
      .orderBy(a2aV1Operations.createdAt).limit(limit)
    return rows.flatMap((row) => { const view = toRow(row); return view ? [view] : [] })
  }

  async claimScan(row: OperationRow, token: string, t: ScanTimings): Promise<OperationRow | undefined> {
    return this.atomic(row, async (tx) => this.claimScanIn(tx, row, token, t))
  }

  private async claimScanIn(tx: DrizzleStoreDatabase, row: OperationRow, token: string, t: ScanTimings): Promise<OperationRow | undefined> {
    const rows = await tx.update(a2aV1Operations).set({
      recoveryState: 'recovering', claimKind: 'scan', claimToken: token, bootId: this.bootId, recoveryUpdatedAt: sql`now()`,
    }).where(and(
      eq(a2aV1Operations.tenantId, row.tenantId), eq(a2aV1Operations.ownerKey, row.ownerKey),
      eq(a2aV1Operations.taskId, row.taskId), eq(a2aV1Operations.generation, row.generation),
      sql`((${pOrphanDispatch(this.bootId, t)} or ${pOrphanCancel(t)} or ${pFinish(t)}) and ${pClaimScan(t)})`,
    )).returning()
    return toRow(rows[0])
  }

  /**
   * P_CLAIM_CANCEL: one statement inside the per-task lock. Stamps the current boot and a fresh token and moves the latest operation to
   * `cancel_pending`/`recovering`/`cancel`; from here the task store holds back any CANCELED save of the task. Undefined when no row
   * is claimable (an unexpired claim by anyone, a resolved operation, no operation).
   */
  async claimCancel(context: ServerCallContext, taskId: string, token: string): Promise<OperationRow | undefined> {
    const scope = this.scope(context)
    const t = { minAgeMs: this.minAgeMs, claimTtlMs: this.claimTtlMs }
    return this.atomic({ ...scope, taskId }, async (tx) => {
      const rows = await tx.update(a2aV1Operations).set({
        state: 'cancel_pending', recoveryState: 'recovering', claimKind: 'cancel', claimToken: token, bootId: this.bootId, recoveryUpdatedAt: sql`now()`,
      }).where(and(
        eq(a2aV1Operations.tenantId, scope.tenantId), eq(a2aV1Operations.ownerKey, scope.ownerKey), eq(a2aV1Operations.taskId, taskId),
        pClaimCancel(t),
      )).returning()
      return toRow(rows[0])
    })
  }

  async finish(row: OperationRow, token: string, set: { recoveryState?: string | null; receipt?: string | null; resolve?: boolean }, tx?: DrizzleStoreDatabase): Promise<boolean> {
    if (!tx) return this.atomic(row, async (locked) => this.finish(row, token, set, locked))
    const values: Record<string, unknown> = { recoveryUpdatedAt: sql`now()` }
    if (set.resolve) values.state = 'resolved'
    if (set.recoveryState !== undefined) values.recoveryState = set.recoveryState
    if (set.receipt !== undefined) values.recoveryReceipt = set.receipt
    const rows = await tx.update(a2aV1Operations).set(values).where(and(
      eq(a2aV1Operations.tenantId, row.tenantId), eq(a2aV1Operations.ownerKey, row.ownerKey),
      eq(a2aV1Operations.taskId, row.taskId), eq(a2aV1Operations.generation, row.generation), pToken(token),
    )).returning({ taskId: a2aV1Operations.taskId })
    return rows.length > 0
  }

  async release(row: OperationRow, token: string): Promise<void> {
    await this.atomic(row, async (tx) => tx.update(a2aV1Operations).set({ recoveryState: null, claimKind: null, claimToken: null }).where(and(
      eq(a2aV1Operations.tenantId, row.tenantId), eq(a2aV1Operations.ownerKey, row.ownerKey),
      eq(a2aV1Operations.taskId, row.taskId), eq(a2aV1Operations.generation, row.generation), pToken(token),
    )).returning({ taskId: a2aV1Operations.taskId }))
  }

  async byKey(operationKey: string): Promise<OperationRow | undefined> {
    const rows = await this.db.select().from(a2aV1Operations).where(eq(a2aV1Operations.operationKey, operationKey)).limit(1)
    return toRow(rows[0])
  }

  async isLatest(row: OperationRow): Promise<boolean> {
    const rows = await this.db.select({ value: sql`max(${a2aV1Operations.generation})` }).from(a2aV1Operations).where(and(
      eq(a2aV1Operations.tenantId, row.tenantId), eq(a2aV1Operations.ownerKey, row.ownerKey), eq(a2aV1Operations.taskId, row.taskId),
    ))
    return Number((rows[0] as { value?: unknown } | undefined)?.value) === row.generation
  }

  async claimLate(row: OperationRow, token: string, t: ScanTimings): Promise<OperationRow | undefined> {
    return this.atomic(row, async (tx) => {
      const rows = await tx.update(a2aV1Operations).set({
        recoveryState: 'recovering', claimKind: 'late', claimToken: token, bootId: this.bootId, recoveryUpdatedAt: sql`now()`,
      }).where(and(
        eq(a2aV1Operations.tenantId, row.tenantId), eq(a2aV1Operations.ownerKey, row.ownerKey),
        eq(a2aV1Operations.taskId, row.taskId), eq(a2aV1Operations.generation, row.generation), pClaimLate(row.operationKey, t),
      )).returning()
      return toRow(rows[0])
    })
  }

  /** P_RECORD_ONLY: first record wins; later calls are no-ops. */
  async recordOnly(row: OperationRow, receipt: string): Promise<boolean> {
    return this.atomic(row, async (tx) => {
      const rows = await tx.update(a2aV1Operations).set({ recoveryReceipt: receipt }).where(and(
        eq(a2aV1Operations.tenantId, row.tenantId), eq(a2aV1Operations.ownerKey, row.ownerKey),
        eq(a2aV1Operations.taskId, row.taskId), eq(a2aV1Operations.generation, row.generation),
        sql`(${latest()} and ${op('operation_key')} = ${row.operationKey} and ${op('recovery_receipt')} is null
          and (${op('recovery_state')} = 'not_applied' or ${op('state')} = 'resolved'))`,
      )).returning({ taskId: a2aV1Operations.taskId })
      return rows.length > 0
    })
  }
}

/** One instance per process boot: the host passes it to the handler (`recovery`) and to the scanner. */
export function createA2AV1Recovery(db: DrizzleStoreDatabase, opts: A2AV1RecoveryOptions = {}): A2AV1Recovery {
  return new A2AV1Recovery(db, opts)
}
