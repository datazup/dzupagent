/**
 * P2 — opt-in DurableNodeLedger integration for the pipeline runtime.
 *
 * Pure helpers called from `dispatchStandardNode` ONLY when
 * `config.nodeLedger` is set. When the ledger is absent these are never
 * invoked, so node execution is byte-for-byte unchanged.
 *
 * Flow per node:
 *   beginNode → replay (skip exec) | lease (run) | busy (skip; held elsewhere)
 *   runNodeWithRetry(...)
 *   finishNode(success) → complete (fence-gated)  | fencedOut → abort
 *   finishNode(failure) → fail (fence-gated)
 *
 * See workspace-docs/repos/dzupagent/docs/architecture/plans/P2-run-leasing-and-fencing.md
 */
import type {
  NodeLedgerLike,
  NodeLeaseLike,
} from "../pipeline-runtime-types.js";

/** Default lease ttl + heartbeat budget (ms). Conservative; tune at the seam. */
export const DEFAULT_LEASE_TTL_MS = 60_000;

/** Default heartbeat interval — renew at ttl/3 so two missed beats don't expire. */
export const DEFAULT_HEARTBEAT_MS = 20_000;

export type BeginNodeOutcome =
  | { kind: "replay"; output: unknown }
  | { kind: "lease"; lease: NodeLeaseLike }
  | { kind: "busy" };

/** Handle for a running heartbeat loop. */
export interface HeartbeatHandle {
  /**
   * Composite signal: aborts when the run is cancelled (parent signal) OR the
   * lease is lost (a heartbeat returned `false` → fenced out). Pass this to
   * the node executor so a long-running node stops promptly on lease loss.
   */
  signal: AbortSignal;
  /** True once a heartbeat reported the lease lost (fenced out). */
  lost: () => boolean;
  /** Stop the interval. Safe to call multiple times. */
  stop: () => void;
}

/**
 * Start renewing a node's lease on an interval while it executes. Returns a
 * {@link HeartbeatHandle} whose `signal` composes the parent run signal with a
 * lease-loss abort. On a heartbeat that returns `false` (fenced out), the
 * signal aborts and `lost()` becomes true; the caller should treat the node as
 * not-completed-by-us. A throwing heartbeat (ledger blip) is treated as
 * transient and does NOT abort — the next beat retries.
 *
 * `onRenewed`/`onLost` are optional event hooks (e.g. emit node:lease_renewed).
 */
export function startNodeHeartbeat(
  ledger: NodeLedgerLike,
  runId: string,
  nodeId: string,
  owner: string,
  fenceToken: number,
  parentSignal: AbortSignal | undefined,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
  intervalMs: number = DEFAULT_HEARTBEAT_MS,
  hooks?: { onRenewed?: () => void; onLost?: () => void }
): HeartbeatHandle {
  const controller = new AbortController();
  let lost = false;

  // Propagate parent cancellation into the composite signal.
  const onParentAbort = () => controller.abort();
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  const timer = setInterval(() => {
    void ledger
      .heartbeat(runId, nodeId, owner, fenceToken, ttlMs, Date.now())
      .then((ok) => {
        if (ok) {
          hooks?.onRenewed?.();
        } else {
          lost = true;
          hooks?.onLost?.();
          controller.abort();
        }
      })
      .catch(() => {
        // Transient ledger error — do not abort; the next beat retries.
      });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  const stop = () => {
    clearInterval(timer);
    if (parentSignal !== undefined) {
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  };

  return { signal: controller.signal, lost: () => lost, stop };
}

/**
 * Attempt to begin a node under the ledger: replay a prior completion, acquire
 * a fresh lease, or report the node is held by a fresh lease elsewhere.
 */
export async function beginNodeUnderLedger(
  ledger: NodeLedgerLike,
  runId: string,
  nodeId: string,
  idempotencyKey: string,
  owner: string,
  now: number,
  ttlMs: number = DEFAULT_LEASE_TTL_MS
): Promise<BeginNodeOutcome> {
  const prior = await ledger.getByIdempotencyKey(idempotencyKey);
  if (prior !== undefined) {
    return { kind: "replay", output: prior.output };
  }
  const lease = (await ledger.acquire(
    runId,
    nodeId,
    idempotencyKey,
    owner,
    ttlMs,
    now
  )) as NodeLeaseLike | null;
  if (lease === null) return { kind: "busy" };
  return { kind: "lease", lease };
}

/**
 * Record a successful node completion (fence-gated). Returns `true` on success,
 * `false` when the write was fenced out (a newer lease superseded us → the
 * runtime must treat the node as not-completed-by-us and abort).
 */
export async function completeNodeUnderLedger(
  ledger: NodeLedgerLike,
  runId: string,
  nodeId: string,
  idempotencyKey: string,
  lease: NodeLeaseLike,
  output: unknown,
  durationMs: number
): Promise<boolean> {
  try {
    await ledger.complete({
      runId,
      nodeId,
      idempotencyKey,
      fenceToken: lease.fenceToken,
      output,
      durationMs,
    });
    return true;
  } catch (err) {
    if (isFencedOut(err)) return false;
    throw err;
  }
}

/**
 * Record a node failure (fence-gated). Swallows a fenced-out write (the newer
 * lease owns the outcome). `retryable` controls whether the node can be
 * re-leased later.
 */
export async function failNodeUnderLedger(
  ledger: NodeLedgerLike,
  runId: string,
  nodeId: string,
  idempotencyKey: string,
  lease: NodeLeaseLike,
  error: string,
  retryable: boolean
): Promise<void> {
  try {
    await ledger.fail({
      runId,
      nodeId,
      idempotencyKey,
      fenceToken: lease.fenceToken,
      error,
      retryable,
    });
  } catch (err) {
    if (isFencedOut(err)) return;
    throw err;
  }
}

function isFencedOut(err: unknown): boolean {
  return err instanceof Error && err.name === "FencedOutError";
}
