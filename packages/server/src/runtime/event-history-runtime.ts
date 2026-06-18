/**
 * Stage 5 — opt-in event-history replay runtime.
 *
 * A minimal execute-node coordinator that drives the replay/live branching
 * described in the Stage 5 spec (§6). It is NOT a drop-in replacement for the
 * checkpoint-based `PipelineRuntime`; flows opt in per definition and only this
 * narrow execute contract is provided.
 *
 * Per {@link executeNode} call:
 *   1. On the first call for a run, append `run_started`.
 *   2. Load the run's event history and look for a recorded `node_completed`
 *      event for the node:
 *        - hit  → replay mode: return the recorded output, do NOT execute.
 *        - miss → live mode: append `node_started`, run the executor, then
 *          append `node_completed` (success) or `node_failed` (error, then
 *          re-throw so the queue layer's retry policy applies).
 *
 * Terminal `run_completed` / `run_failed` events are appended by the caller via
 * {@link completeRun} / {@link failRun}.
 *
 * The orchestrator code that calls `executeNode` must be deterministic: given
 * the same recorded prefix it must request the same nodes in the same order,
 * otherwise replay diverges (spec §4).
 */
import { EventCursor } from "./event-cursor.js";
import type { EventStore, FlowEvent } from "./event-store.js";

export class EventHistoryRuntime {
  /** Runs for which `run_started` has already been appended this process. */
  private readonly started = new Set<string>();

  constructor(
    private readonly store: EventStore,
    private readonly tenantId: string = "default"
  ) {}

  /**
   * Execute (or replay) a single node within a run.
   *
   * Returns the node output and whether it was served from history
   * (`replayed: true`) rather than executed live.
   */
  async executeNode(
    runId: string,
    nodeId: string,
    executor: () => Promise<unknown>
  ): Promise<{ output: unknown; replayed: boolean }> {
    await this.ensureRunStarted(runId);

    const history = await this.store.loadForRun(runId);
    const recorded = findCompletionFor(history, nodeId);

    if (recorded) {
      // Replay mode: return the recorded output, skip activity execution.
      return { output: recorded.payload?.output, replayed: true };
    }

    // Live mode: no completion event yet for this node.
    await this.store.append({
      runId,
      eventType: "node_started",
      nodeId,
      payload: { attempt: 1 },
      tenantId: this.tenantId,
    });

    try {
      const output = await executor();
      await this.store.append({
        runId,
        eventType: "node_completed",
        nodeId,
        payload: { output },
        tenantId: this.tenantId,
      });
      return { output, replayed: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.append({
        runId,
        eventType: "node_failed",
        nodeId,
        payload: { error: message, attempt: 1 },
        tenantId: this.tenantId,
      });
      throw err;
    }
  }

  /** Append the terminal `run_completed` event for a run. */
  async completeRun(
    runId: string,
    output?: Record<string, unknown>
  ): Promise<void> {
    await this.store.append({
      runId,
      eventType: "run_completed",
      ...(output !== undefined ? { payload: { output } } : {}),
      tenantId: this.tenantId,
    });
  }

  /** Append the terminal `run_failed` event for a run. */
  async failRun(runId: string, error: string): Promise<void> {
    await this.store.append({
      runId,
      eventType: "run_failed",
      payload: { error },
      tenantId: this.tenantId,
    });
  }

  /**
   * Append `run_started` exactly once per run. Idempotent across calls within a
   * process via the `started` set, and across restarts via the recorded
   * history (a run with any events has already started).
   */
  private async ensureRunStarted(runId: string): Promise<void> {
    if (this.started.has(runId)) return;
    const history = await this.store.loadForRun(runId);
    if (history.length === 0) {
      await this.store.append({
        runId,
        eventType: "run_started",
        tenantId: this.tenantId,
      });
    }
    this.started.add(runId);
  }
}

/**
 * Find the recorded `node_completed` event for `nodeId` in this run's history,
 * or `null` if the node has not yet completed.
 *
 * `executeNode` is called once per node per (re)execution, so a fresh
 * {@link EventCursor} is built each call. We walk the cursor's ordered
 * completions until we reach this node's completion or exhaust the history —
 * mirroring the spec's single-pass replay semantics while remaining correct for
 * the per-node call contract.
 */
function findCompletionFor(
  history: FlowEvent[],
  nodeId: string
): FlowEvent | null {
  // Distinct node ids that have a recorded completion, in sequence order.
  const completedOrder = [...history]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((e) => e.eventType === "node_completed" && e.nodeId !== undefined)
    .map((e) => e.nodeId as string);

  const cursor = new EventCursor(history);
  for (const id of completedOrder) {
    const event = cursor.nextCompletedFor(id);
    if (event && id === nodeId) return event;
  }
  return null;
}
