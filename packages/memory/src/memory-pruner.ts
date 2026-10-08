/**
 * MemoryPruner — keeps a memory store bounded.
 *
 * Two-pass operation:
 *   1. TTL pass — every entry whose `createdAt` is older than `ttlMs`
 *      (default 7 days) is deleted.
 *   2. Capacity pass — when the surviving entry count exceeds `maxEntries`
 *      (default 1000), the lowest-strength entries are evicted until the
 *      ceiling is satisfied.
 *
 * The pruner walks the store in batches of {@link DEFAULT_PAGE_SIZE} using the
 * `offset` cursor of `ConsolidationStore.search()` so it can be called against
 * backends that cap a single `search()` call. Paging is required for
 * correctness, not just politeness: the capacity pass compares the surviving
 * count against `maxEntries` (1000), so a single 500-row page could never
 * reach the cap.
 *
 * Non-fatal: individual delete failures are swallowed so a flaky store does
 * not abort the run. The returned counts reflect successful deletes only.
 * A scan that fails or is truncated part-way through reports
 * `status: 'degraded'` — never `'completed'` — because the counts then
 * describe only the pages that were read.
 */

import type {
  ConsolidationStore,
  ConsolidationStoreItem,
} from "./consolidation-engine.js";
import {
  degradation,
  statusFor,
  type MemoryOperationDegradation,
  type MemoryOperationOutcome,
  type MemoryOperationResult,
} from "./operation-outcome.js";

/** Re-export under a more descriptive name for pruner consumers. */
export type MemoryStore = ConsolidationStore;
export type MemoryStoreItem = ConsolidationStoreItem;

/** Default pagination batch size when scanning a namespace. */
const DEFAULT_PAGE_SIZE = 500;

/** Default capacity before LRU/strength-based eviction kicks in. */
const DEFAULT_MAX_ENTRIES = 1000;

/** Bound each scan while still allowing the capacity pass to observe overflow. */
const DEFAULT_SCAN_MULTIPLIER = 10;

/** Default TTL: 7 days. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on scan pages so a pathologically large (or mis-paginating)
 * namespace cannot spin the pruner forever. At the default page size this
 * covers 1,000,000 entries; exceeding it degrades the run rather than
 * silently reporting a partial scan as complete.
 */
const MAX_SCAN_PAGES = 2000;

export interface PruneOptions {
  /** Maximum entries to keep after pruning (default 1000). */
  maxEntries?: number;
  /** Entries created more than this many ms ago are expired (default 7 days). */
  ttlMs?: number;
  /**
   * Restrict pruning to a single namespace tuple. When omitted the pruner
   * operates on the root scope `[]`, which most stores treat as
   * "everything".
   */
  namespace?: string[];
  /**
   * `Date.now()` proxy — exposed for tests so they can assert TTL behaviour
   * without sleeping. Defaults to `Date.now`.
   */
  now?: () => number;
  /** Override the page size used when scanning the store. */
  pageSize?: number;
  /**
   * Hard ceiling on entries loaded by one run. Must exceed `maxEntries` for
   * capacity eviction to run. Defaults to `10 * maxEntries`.
   */
  maxScan?: number;
}

export interface PruneResult extends MemoryOperationOutcome {
  /** Number of entries deleted because they exceeded the TTL. */
  expired: number;
  /** Number of entries deleted because the store was over capacity. */
  evicted: number;
  /** Number of entries that survived both passes. */
  remaining: number;
}

export type PruneOperationResult = PruneResult & MemoryOperationResult;

/** Timer pair driving a schedule. Injectable so tests need not sleep. */
export interface PruneScheduleTimers {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface PruneScheduleOptions extends PruneOptions {
  /** Milliseconds between runs. Required; must be positive and finite. */
  intervalMs: number;
  /** Called with every completed run's result. */
  onResult?: (result: PruneOperationResult) => void;
  /**
   * Called when a run (or `onResult`) throws. Defaults to `console.error`.
   * A failed run never stops the schedule.
   */
  onError?: (error: unknown) => void;
  /** Defaults to the global timers, with the handle `unref()`'d. */
  timers?: PruneScheduleTimers;
}

export interface PruneScheduleHandle {
  /**
   * Run a prune now. Shares the in-flight run if one is active. Works after
   * `stop()` too, for a final manual pass.
   */
  runNow(): Promise<PruneOperationResult>;
  /** Clear the timer. Idempotent. */
  stop(): void;
  readonly stopped: boolean;
}

/** Global timers, `unref()`'d so a schedule never keeps the process alive. */
const DEFAULT_SCHEDULE_TIMERS: PruneScheduleTimers = {
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

interface ParsedItem {
  key: string;
  createdAt: number;
  strength: number;
}

/**
 * MemoryPruner — see file header for the eviction strategy.
 *
 * Stateless; safe to call concurrently against different namespaces.
 */
export class MemoryPruner {
  /**
   * Run the two-pass prune on `store`.
   *
   * Returns a {@link PruneResult} summarising how many entries were removed
   * by each pass and how many remain. Callers can wire the result into
   * telemetry to track memory hygiene over time.
   */
  async prune(
    store: MemoryStore,
    options: PruneOptions = {},
  ): Promise<PruneOperationResult> {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const namespace = options.namespace ?? [];
    const now = (options.now ?? Date.now)();
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const maxScan =
      options.maxScan ??
      Math.max(maxEntries + 1, maxEntries * DEFAULT_SCAN_MULTIPLIER);
    const degradations: MemoryOperationDegradation[] = [];

    // ---- Scan: page the whole namespace ------------------------------------
    // The capacity pass must compare against the TRUE entry count, so we must
    // not stop after a single `search()`: one page is bounded by `pageSize`
    // (500), which is below the default `maxEntries` (1000), making the cap
    // unreachable at defaults. We page with `offset` (part of the
    // ConsolidationStore contract) until a short page comes back.
    const items: ConsolidationStoreItem[] = [];
    const seenKeys = new Set<string>();
    let scanComplete = true;
    let offset = 0;
    for (
      let page = 0;
      page < MAX_SCAN_PAGES && items.length < maxScan;
      page++
    ) {
      const limit = Math.min(pageSize, maxScan - items.length);
      let batch: ConsolidationStoreItem[];
      try {
        batch = await store.search(namespace, { limit, offset });
      } catch (error) {
        degradations.push(
          degradation(
            "search",
            offset === 0 ? "source-unavailable" : "partial-result",
            error,
            namespace.join("/"),
          ),
        );
        scanComplete = false;
        break;
      }
      let added = 0;
      for (const item of batch) {
        // Stores that ignore `offset` re-serve the same rows; de-dupe so the
        // loop terminates instead of double-counting.
        if (seenKeys.has(item.key)) continue;
        seenKeys.add(item.key);
        items.push(item);
        added++;
      }
      if (batch.length < limit || added === 0) break;
      offset += batch.length;
      if (page === MAX_SCAN_PAGES - 1) {
        // Ran out of page budget before the namespace was exhausted — the
        // counts below describe only what we saw, so this is a partial result.
        degradations.push(
          degradation(
            "search",
            "partial-result",
            new Error(
              `scan truncated after ${MAX_SCAN_PAGES} pages ` +
                `(${items.length} entries scanned)`,
            ),
            namespace.join("/"),
            // Internally-raised, not a backend failure: classify explicitly so
            // the public code says what happened instead of "backend-error".
            { reason: "scan-budget-exhausted", component: "memory-pruner" },
          ),
        );
        scanComplete = false;
      }
    }

    // A first-page failure means we saw nothing at all — keep the legacy
    // "search unavailable" shape.
    if (!scanComplete && items.length === 0) {
      return {
        expired: 0,
        evicted: 0,
        remaining: 0,
        status: "degraded",
        degradations,
      };
    }

    if (items.length === 0) {
      return {
        expired: 0,
        evicted: 0,
        remaining: 0,
        status: "completed",
        degradations,
      };
    }

    const cutoff = now - ttlMs;
    let expired = 0;
    const survivors: ParsedItem[] = [];

    // ---- Pass 1: TTL expiry ------------------------------------------------
    // Note: we use `createdAt !== 0` (rather than `> 0`) to allow callers
    // with synthetic clocks to drive deterministic expiry — `0` is the
    // sentinel emitted by `parseItem` when no timestamp could be derived.
    for (const item of items) {
      const parsed = parseItem(item);
      if (parsed.createdAt !== 0 && parsed.createdAt < cutoff) {
        try {
          await store.delete(namespace, item.key);
          expired++;
        } catch (error) {
          // delete failure → keep the entry for the next pass to consider
          survivors.push(parsed);
          degradations.push(
            degradation("delete", "partial-result", error, item.key),
          );
        }
        continue;
      }
      survivors.push(parsed);
    }

    // ---- Pass 2: capacity cap ---------------------------------------------
    let evicted = 0;
    if (survivors.length > maxEntries) {
      // Sort weakest first; ties broken by oldest (lowest createdAt) first.
      survivors.sort((a, b) => {
        if (a.strength !== b.strength) return a.strength - b.strength;
        return a.createdAt - b.createdAt;
      });
      const overflow = survivors.length - maxEntries;
      const victims = survivors.splice(0, overflow);
      for (const victim of victims) {
        try {
          await store.delete(namespace, victim.key);
          evicted++;
        } catch (error) {
          // Non-fatal — count the victim as a survivor on failure.
          survivors.push(victim);
          degradations.push(
            degradation("delete", "partial-result", error, victim.key),
          );
        }
      }
    }

    return {
      expired,
      evicted,
      remaining: survivors.length,
      status: statusFor(degradations),
      degradations,
    };
  }

  /**
   * Opt-in scheduled pruning: run {@link prune} on `store` every
   * `intervalMs`, starting one interval from now. Runs never overlap (a tick
   * during an in-flight run is skipped) and never reject: failures go to
   * `onError`. Call `stop()` on the returned handle to end the schedule.
   */
  schedule(
    store: MemoryStore,
    options: PruneScheduleOptions,
  ): PruneScheduleHandle {
    const { intervalMs, onResult, onError, timers, ...pruneOptions } =
      options;
    if (!(Number.isFinite(intervalMs) && intervalMs > 0)) {
      throw new Error(
        `intervalMs must be a positive finite number, got ${String(intervalMs)}`,
      );
    }
    const timerPair = timers ?? DEFAULT_SCHEDULE_TIMERS;
    const reportError = (error: unknown): void => {
      if (onError) {
        onError(error);
        return;
      }
      console.error("[memory] scheduled pruner run failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    };

    let inFlight: Promise<PruneOperationResult> | undefined;
    let stopped = false;

    const runNow = (): Promise<PruneOperationResult> => {
      if (inFlight) return inFlight;
      let run: Promise<PruneOperationResult>;
      try {
        run = this.prune(store, pruneOptions);
      } catch (error) {
        // A synchronous throw must not escape a timer callback.
        run = Promise.reject(error);
      }
      inFlight = run;
      const clear = (): void => {
        if (inFlight === run) inFlight = undefined;
      };
      run.then(clear, clear);
      return run;
    };

    const tick = (): void => {
      if (stopped || inFlight) return;
      runNow().then(
        (result) => {
          try {
            onResult?.(result);
          } catch (error) {
            reportError(error);
          }
        },
        reportError,
      );
    };

    const timer = timerPair.setInterval(tick, intervalMs);

    return {
      runNow,
      stop: () => {
        if (stopped) return;
        stopped = true;
        timerPair.clearInterval(timer);
      },
      get stopped() {
        return stopped;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the data we need for pruning out of a raw store item.
 *
 * Looks for `_decay.strength` and `_decay.createdAt` first (these are the
 * canonical fields written by `MemoryService`), falling back to top-level
 * `createdAt` and the item's `createdAt` timestamp from the store wrapper.
 */
function parseItem(item: ConsolidationStoreItem): ParsedItem {
  const value = item.value;
  const decay = value["_decay"];
  let strength = 1;
  let decayCreatedAt: number | undefined;
  if (decay != null && typeof decay === "object") {
    const d = decay as Record<string, unknown>;
    if (typeof d["strength"] === "number") strength = d["strength"];
    if (typeof d["createdAt"] === "number") decayCreatedAt = d["createdAt"];
  }
  const valueCreatedAt =
    typeof value["createdAt"] === "number"
      ? (value["createdAt"] as number)
      : undefined;
  const wrapperCreatedAt = coerceWrapperTimestamp(item.createdAt);
  const createdAt = decayCreatedAt ?? valueCreatedAt ?? wrapperCreatedAt ?? 0;
  return { key: item.key, createdAt, strength };
}

function coerceWrapperTimestamp(
  raw: Date | string | number | undefined,
): number | undefined {
  if (raw == null) return undefined;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
