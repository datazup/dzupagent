/**
 * Canonical interrupt/resume outcome contract, shared across
 * @dzupagent/hitl-kit and @dzupagent/subagents so both depend on one
 * type instead of maintaining independently-evolved local shapes.
 * Field names match @dzupagent/hitl-kit's pre-existing ApprovalOutcome
 * verbatim (decision/response/reason) — this is a promotion of that
 * shape, not a redesign.
 */
export type InterruptOutcome<TResponse = unknown> =
  | { decision: "granted"; response?: TResponse }
  | { decision: "rejected"; reason?: string };

export interface InterruptGate<TResponse = unknown> {
  waitForInterrupt(
    runId: string,
    interruptId: string
  ): Promise<InterruptOutcome<TResponse>>;
}

/**
 * Deterministic interrupt-id derivation, matching the pattern already
 * used by @dzupagent/hitl-kit's RuntimeApprovalBridge
 * (`${runId}:${nodeId}:${attempt}`), documented here so new call sites
 * reuse it instead of reinventing it.
 */
export function deriveInterruptId(
  runId: string,
  nodeId: string,
  attempt: number
): string {
  return `${runId}:${nodeId}:${attempt}`;
}
