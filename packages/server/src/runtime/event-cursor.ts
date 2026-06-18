/**
 * Stage 5 — stateful cursor over a run's recorded event history.
 *
 * The orchestrator function re-runs from the top on every (re)start. As it
 * encounters each node, it asks the cursor for that node's recorded
 * `node_completed` event: a hit means the node already ran, so its stored
 * output is returned and the activity is skipped (replay mode); a miss means
 * the node has no completion event yet, so it must execute live.
 *
 * The cursor advances through `node_completed` events in recorded order. It is
 * intentionally minimal — the divergence-detection and live-append logic lives
 * in {@link EventHistoryRuntime}.
 */
import type { FlowEvent } from "./event-store.js";

export class EventCursor {
  /** Recorded `node_completed` events, in sequence order. */
  private readonly completed: FlowEvent[];
  /** Index of the next unconsumed completed event. */
  private position = 0;

  constructor(events: FlowEvent[]) {
    this.completed = [...events]
      .sort((a, b) => a.sequence - b.sequence)
      .filter((e) => e.eventType === "node_completed");
  }

  /**
   * Return the next recorded `node_completed` event for `nodeId`, advancing the
   * cursor past it, or `null` when there is no recorded completion for that node
   * (either the history is drained or the next completed event is for a
   * different node — i.e. this node has not run yet).
   */
  nextCompletedFor(nodeId: string): FlowEvent | null {
    const next = this.completed[this.position];
    if (next === undefined || next.nodeId !== nodeId) return null;
    this.position += 1;
    return next;
  }

  /** True once every recorded completion event has been consumed. */
  isDrained(): boolean {
    return this.position >= this.completed.length;
  }
}
