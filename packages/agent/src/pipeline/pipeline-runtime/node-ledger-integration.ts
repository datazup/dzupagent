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

export type BeginNodeOutcome =
  | { kind: "replay"; output: unknown }
  | { kind: "lease"; lease: NodeLeaseLike }
  | { kind: "busy" };

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
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
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
    now,
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
  durationMs: number,
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
  retryable: boolean,
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
