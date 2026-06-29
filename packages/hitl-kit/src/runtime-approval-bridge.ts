/**
 * MPCO P6 — RuntimeApprovalBridge (spec §4.2, T10).
 *
 * Bridges an MPCO `input_required` gate onto the hitl-kit ApprovalStateStore.
 * It deliberately does NOT use ApprovalGate.waitForApproval (which is an
 * unconditional create-then-poll with no resume branch — approval-gate.ts:74).
 * Instead it splits create from poll:
 *   - ensurePending() is idempotent — a resumed run re-enters it as a no-op.
 *   - pollTerminal() returns the store's cached terminal outcome immediately on
 *     resume (InMemoryApprovalStateStore.poll returns entry.outcome if set).
 *
 * Approval ids are deterministic (`runId:nodeId:attempt`) so a resume targets
 * the same pending entry. mapOutcome projects the store's ApprovalOutcome onto
 * the shared CollabGateDecision vocabulary.
 *
 * ensurePending swallows DuplicateApprovalError so the bridge works WHETHER OR
 * NOT the store-level idempotency patch (P6a) has landed — MPCO does not depend
 * on that fix landing first.
 */
import type { CollabGateDecision } from "@dzupagent/adapter-types";
import {
  InMemoryApprovalStateStore,
  ApprovalTimeoutError,
  DuplicateApprovalError,
  type ApprovalOutcome,
  type ApprovalStateStore,
} from "./approval-state-store.js";

/** The subset of CollabGateDecision a human/runtime gate can terminate with. */
export type TerminalGateDecision = Extract<
  CollabGateDecision,
  "human_approved" | "human_rejected" | "timeout"
>;

export interface RuntimeApprovalBridgeOptions {
  /** Backing approval state store. Defaults to an in-memory instance. */
  store?: ApprovalStateStore;
}

export class RuntimeApprovalBridge {
  readonly store: ApprovalStateStore;

  constructor(options: RuntimeApprovalBridgeOptions = {}) {
    this.store = options.store ?? new InMemoryApprovalStateStore();
  }

  /** Deterministic approval id so a resumed run targets the same entry. */
  approvalId(runId: string, nodeId: string, attempt: number): string {
    return `${runId}:${nodeId}:${attempt}`;
  }

  /**
   * Register a pending approval. Idempotent: a duplicate (resume re-entry) is a
   * no-op. Defensive against stores that still throw DuplicateApprovalError.
   */
  async ensurePending(
    runId: string,
    approvalId: string,
    payload: unknown
  ): Promise<void> {
    try {
      await this.store.createPending(runId, approvalId, payload);
    } catch (err) {
      if (err instanceof DuplicateApprovalError) return;
      throw err;
    }
  }

  /** Pure mapping from a terminal ApprovalOutcome to a CollabGateDecision. */
  mapOutcome(outcome: ApprovalOutcome): TerminalGateDecision {
    return outcome.decision === "granted" ? "human_approved" : "human_rejected";
  }

  /**
   * Await the terminal decision. On resume the store already holds the outcome,
   * so poll returns it immediately. A timeout maps to the 'timeout' decision
   * rather than throwing, so the caller gets a uniform CollabGateDecision.
   */
  async pollTerminal(
    runId: string,
    approvalId: string,
    timeoutMs: number
  ): Promise<TerminalGateDecision> {
    try {
      const outcome = await this.store.poll(runId, approvalId, timeoutMs);
      return this.mapOutcome(outcome);
    } catch (err) {
      if (err instanceof ApprovalTimeoutError) return "timeout";
      throw err;
    }
  }
}
