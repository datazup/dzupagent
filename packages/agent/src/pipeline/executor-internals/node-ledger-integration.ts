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
  NodeExecutionContext,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from "../pipeline-runtime-types.js";
import type { PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { runNodeWithRetry } from "./node-retry.js";

/** Default lease ttl + heartbeat budget (ms). Conservative; tune at the seam. */
export const DEFAULT_LEASE_TTL_MS = 60_000;

/** Default heartbeat interval — renew at ttl/3 so two missed beats don't expire. */
export const DEFAULT_HEARTBEAT_MS = 20_000;

export type BeginNodeOutcome =
  | { kind: "replay"; output: unknown }
  | { kind: "lease"; lease: NodeLeaseLike }
  | { kind: "busy" };

/**
 * Thrown by {@link beginNodeUnderLedger} when the ledger holds a completion for
 * the idempotency key that belongs to a different run.
 */
export class CrossRunReplayError extends Error {
  readonly code = "NODE_LEDGER_CROSS_RUN_REPLAY";
  constructor(
    readonly idempotencyKey: string,
    readonly priorRunId: string,
    readonly runId: string,
  ) {
    super(
      `Refusing to replay node output recorded by run ${priorRunId} into run ${runId}`,
    );
    this.name = "CrossRunReplayError";
  }
}

/** Handle for a running heartbeat loop. */
export interface HeartbeatHandle {
  /** Aborts on parent cancellation, fencing, or the last confirmed lease deadline. */
  signal: AbortSignal;
  /** Checks the deadline as well, in case the event loop delayed its timer. */
  lost: () => boolean;
  /** Stops timers and removes the parent listener; late replies are ignored. */
  stop: () => void;
}

/**
 * Serialize renewals and bound them by a separate last-confirmed-lease watchdog.
 * Errors may retry within that window; a hung renewal cannot defer the watchdog.
 * Acknowledgements extend from request time, never from response time.
 * confirmedAt is the initial acquisition's request time, when known.
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
  hooks?: { onRenewed?: () => void; onLost?: () => void },
  confirmedAt: number = Date.now(),
): HeartbeatHandle {
  const controller = new AbortController();
  const safetyMs = Math.max(1, Math.min(intervalMs, ttlMs / 10));
  let deadline = confirmedAt + ttlMs - safetyMs;
  let active = true;
  let lost = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    active = false;
    clearTimeout(renewalTimer);
    clearTimeout(deadlineTimer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  };
  const onParentAbort = () => {
    stop();
    controller.abort(parentSignal?.reason);
  };
  const revoke = () => {
    if (!active) return;
    lost = true;
    stop();
    controller.abort(new Error("Node ledger lease lost"));
    hooks?.onLost?.();
  };
  const checkDeadline = () => {
    if (active && Date.now() >= deadline) revoke();
    return lost;
  };
  const armDeadline = () => {
    clearTimeout(deadlineTimer);
    if (checkDeadline()) return;
    deadlineTimer = setTimeout(revoke, deadline - Date.now());
    deadlineTimer.unref?.();
  };
  const schedule = () => {
    renewalTimer = setTimeout(() => { void renew(); }, intervalMs);
    renewalTimer.unref?.();
  };
  const renew = async () => {
    if (!active || checkDeadline()) return;
    const requestedAt = Date.now();
    try {
      const ok = await ledger.heartbeat(
        runId, nodeId, owner, fenceToken, ttlMs, requestedAt,
      );
      if (!active || checkDeadline()) return;
      if (!ok) {
        revoke();
        return;
      }
      deadline = requestedAt + ttlMs - safetyMs;
      armDeadline();
      if (active) hooks?.onRenewed?.();
    } catch {
      // Retry only inside the unchanged confirmed window, including sync throws.
      checkDeadline();
    } finally {
      if (active) schedule();
    }
  };

  if (!Number.isFinite(ttlMs) || ttlMs <= 1 ||
      !Number.isFinite(intervalMs) || intervalMs <= 0) {
    revoke();
  } else if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    armDeadline();
    if (active) schedule();
  }
  return { signal: controller.signal, lost: checkDeadline, stop };
}

/** Abandon revoked execution and guard every retry, even for an uncooperative executor. */
export async function runNodeWithHeartbeat(
  config: PipelineRuntimeConfig,
  emit: (event: PipelineRuntimeEvent) => void,
  node: PipelineNode,
  context: NodeExecutionContext,
  heartbeat: HeartbeatHandle | undefined,
): ReturnType<typeof runNodeWithRetry> {
  if (heartbeat === undefined) return runNodeWithRetry(config, emit, node, context);
  const { signal } = heartbeat;
  const revokedError = () => new Error(
    'node "' + node.id + '" ' +
      (heartbeat.lost() ? "lease lost during execution" : "cancelled during execution"),
  );
  const check = () => {
    if (heartbeat.lost() || signal.aborted) throw revokedError();
  };
  check();
  const retryController = new AbortController();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      retryController.abort(signal.reason);
      reject(revokedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const execution = runNodeWithRetry({
      ...config,
      signal: retryController.signal,
      nodeExecutor: async (...args) => {
        check();
        const result = await config.nodeExecutor(...args);
        check();
        return result;
      },
    }, emit, node, context);
    const result = await Promise.race([execution, aborted]);
    check();
    return result;
  } finally {
    retryController.abort();
    signal.removeEventListener("abort", onAbort);
  }
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
    // DZUPAGENT-AGENT-H-61: never hand one run another run's output. Keys are
    // run-scoped, so a mismatch means a legacy or colliding row — refuse it.
    if (typeof prior.runId === "string" && prior.runId !== runId) {
      throw new CrossRunReplayError(idempotencyKey, prior.runId, runId);
    }
    return { kind: "replay", output: prior.output };
  }
  const lease = await ledger.acquire(
    runId,
    nodeId,
    idempotencyKey,
    owner,
    ttlMs,
    now
  );
  if (lease === null) return { kind: "busy" };
  if (
    typeof lease !== "object" || lease === null ||
    !("owner" in lease) || typeof lease.owner !== "string" || lease.owner.length === 0 ||
    !("fenceToken" in lease) || typeof lease.fenceToken !== "number" ||
    !Number.isSafeInteger(lease.fenceToken) || lease.fenceToken <= 0
  ) {
    throw new Error("Node ledger returned an invalid lease");
  }
  return { kind: "lease", lease: { owner: lease.owner, fenceToken: lease.fenceToken } };
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
