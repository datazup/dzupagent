/**
 * P2 — Durable node ledger reclaimer.
 *
 * Background worker that detects stale (lease-expired) durable nodes and nudges
 * their owning runs back onto the queue so a live worker resumes them. The
 * reclaimer does **not** re-lease nodes itself: a stale node is already
 * re-leasable (its lease expired), so the next worker `acquire` bumps the fence
 * and resumes. The reclaimer's job is purely detection + re-enqueue + eventing.
 *
 * Every `intervalMs` the reclaimer:
 *   1. Asks the ledger for up to `batchSize` stale nodes via `findStale(now())`.
 *   2. For each stale node, emits a `node:reclaimed` event and calls
 *      `onReclaimed` (per-node observability).
 *   3. Re-enqueues each owning run AT MOST ONCE per tick (deduped by `runId`)
 *      via the host-provided `reEnqueueRun` seam. A failure to re-enqueue one
 *      run is surfaced via `onError` and does not abort the sweep.
 *
 * The worker mirrors {@link MailDlqWorker}'s conventions: narrow injected
 * dependencies, an injected clock, `start()`/`stop()`/`tick()`, a re-entrancy
 * guard, an `unref()`'d timer, and constructor validation.
 *
 * See workspace-docs/repos/dzupagent/docs/architecture/plans/
 * P2-run-leasing-and-fencing.md (crash-safe spec §6.1 node lifecycle,
 * §14 failure matrix — stale-lease reclaim).
 */
import type { DzupEvent } from '@dzupagent/core/events'
import type {
  DurableNodeLease,
  DurableNodeLedger,
} from '@dzupagent/core/persistence'

/**
 * Subset of {@link DurableNodeLedger} the reclaimer depends on.
 *
 * The reclaimer only needs to detect stale nodes; pinning the dependency to a
 * narrow interface keeps it independent of leasing/fencing internals and makes
 * it trivially stubbable in tests.
 */
type LedgerDependency = Pick<DurableNodeLedger, 'findStale'>

/** Narrow event-bus surface — the reclaimer only emits. */
interface EventEmitter {
  emit: (event: DzupEvent) => void
}

/** Default sweep interval (15 seconds). */
export const DEFAULT_RECLAIMER_INTERVAL_MS = 15_000

/** Default number of stale nodes processed per tick (the `findStale` limit). */
export const DEFAULT_RECLAIMER_BATCH_SIZE = 50

export interface NodeLedgerReclaimerConfig {
  /** Durable node ledger to scan for stale leases. */
  ledger: LedgerDependency
  /**
   * Host-provided seam that puts the run back on the queue so a live worker
   * picks it up. Decouples the reclaimer from the concrete queue. May be sync
   * or async; the reclaimer awaits it. A throw is caught and routed to
   * `onError` so one bad run does not abort the sweep.
   */
  reEnqueueRun: (runId: string) => void | Promise<void>
  /** Event bus used to emit `node:reclaimed` (one per stale node). */
  eventBus: EventEmitter
  /** Sweep interval in milliseconds. Defaults to 15s. */
  intervalMs?: number
  /** Maximum stale nodes processed per tick (passed as `findStale`'s limit). */
  batchSize?: number
  /** Injected clock (for deterministic tests). Defaults to `Date.now`. */
  now?: () => number
  /** Called once per stale node, after its `node:reclaimed` event is emitted. */
  onReclaimed?: (lease: DurableNodeLease) => void
  /** Called when `reEnqueueRun` throws for a run. The sweep continues. */
  onError?: (error: unknown) => void
}

export class NodeLedgerReclaimer {
  private readonly ledger: LedgerDependency
  private readonly reEnqueueRun: (runId: string) => void | Promise<void>
  private readonly eventBus: EventEmitter
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly now: () => number
  private readonly onReclaimed?: (lease: DurableNodeLease) => void
  private readonly onError?: (error: unknown) => void

  private timer: ReturnType<typeof setInterval> | null = null
  private sweeping = false

  constructor(config: NodeLedgerReclaimerConfig) {
    this.ledger = config.ledger
    this.reEnqueueRun = config.reEnqueueRun
    this.eventBus = config.eventBus
    this.intervalMs = config.intervalMs ?? DEFAULT_RECLAIMER_INTERVAL_MS
    this.batchSize = config.batchSize ?? DEFAULT_RECLAIMER_BATCH_SIZE
    this.now = config.now ?? (() => Date.now())
    this.onReclaimed = config.onReclaimed
    this.onError = config.onError

    if (this.intervalMs <= 0) {
      throw new Error('NodeLedgerReclaimer intervalMs must be > 0')
    }
    if (this.batchSize <= 0) {
      throw new Error('NodeLedgerReclaimer batchSize must be > 0')
    }
  }

  /** Start the periodic sweep loop. Safe to call repeatedly. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    // Do not block process exit on this timer.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      try {
        ;(this.timer as { unref: () => void }).unref()
      } catch {
        // noop — some environments (e.g. test timers) do not implement unref.
      }
    }
  }

  /** Stop the periodic sweep loop. Safe to call repeatedly. */
  stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    return Promise.resolve()
  }

  /**
   * Run a single detect + re-enqueue pass. Exposed for tests and for callers
   * that want to trigger a sweep outside of the interval schedule.
   *
   * `reclaimed` counts stale nodes whose owning run was successfully
   * re-enqueued this tick. Nodes belonging to a run whose `reEnqueueRun` threw
   * are still observed (event + `onReclaimed`) but are not counted, since the
   * run was not actually handed back to the queue.
   */
  async tick(): Promise<{ reclaimed: number }> {
    if (this.sweeping) {
      return { reclaimed: 0 }
    }
    this.sweeping = true
    try {
      const stale = await this.ledger.findStale(this.now(), this.batchSize)

      // Emit per-node observability for every stale node, and collect the set
      // of unique owning runs to re-enqueue at most once.
      const nodesByRun = new Map<string, DurableNodeLease[]>()
      for (const lease of stale) {
        this.eventBus.emit({
          type: 'node:reclaimed',
          runId: lease.runId,
          nodeId: lease.nodeId,
          previousOwner: lease.owner,
        })
        this.onReclaimed?.(lease)

        const bucket = nodesByRun.get(lease.runId)
        if (bucket) {
          bucket.push(lease)
        } else {
          nodesByRun.set(lease.runId, [lease])
        }
      }

      // Re-enqueue each unique run once. A failure for one run must not abort
      // the others; surface it via onError and continue.
      let reclaimed = 0
      for (const [runId, leases] of nodesByRun) {
        try {
          await this.reEnqueueRun(runId)
          reclaimed += leases.length
        } catch (error) {
          this.onError?.(error)
        }
      }

      return { reclaimed }
    } finally {
      this.sweeping = false
    }
  }
}
