/**
 * Approval escalation — an ordered approver chain with per-level timeouts.
 *
 * Level 0 starts when the engine is constructed. Any one approver of the
 * active level may decide; the first decision resolves the request. When a
 * level's `timeoutMs` elapses without a decision the request escalates to
 * the next level, which starts at the previous deadline (so a late
 * {@link EscalationEngine.tick} catches up deterministically). When the last
 * level times out, `onExhausted` applies — `reject` by default (fail closed).
 *
 * Only the active level holds authority: once escalated, earlier approvers
 * can no longer decide. Timeouts are positive integer milliseconds, the
 * flow DSL's `timeoutMs` convention. Outcomes `granted` / `rejected` map to
 * an approval node's `onApprove` / `onReject`.
 *
 * No timers, no I/O: the host drives `tick()`. The clock is injectable.
 */

export type EscalationDecision = "granted" | "rejected";
export type EscalationExhaustedAction = "reject" | "approve";

export interface EscalationLevel {
  /** Distinct, non-blank approver ids; any one of them decides for the level. */
  approvers: readonly string[];
  /** Positive integer ms the level stays active before escalating. */
  timeoutMs: number;
}

export interface EscalationPolicy {
  /** Ordered chain, level 0 first. Must not be empty. */
  levels: readonly EscalationLevel[];
  /** Applied when the last level times out. Defaults to `reject`. */
  onExhausted?: EscalationExhaustedAction;
}

export type EscalationEvent =
  | {
      type: "level_started";
      level: number;
      approvers: string[];
      at: number;
      deadline: number;
    }
  | { type: "level_timed_out"; level: number; at: number }
  | {
      type: "decided";
      level: number;
      approverId: string;
      decision: EscalationDecision;
      reason?: string;
      at: number;
    }
  | {
      type: "exhausted";
      action: EscalationExhaustedAction;
      decision: EscalationDecision;
      at: number;
    };

export interface EscalationState {
  status: "pending" | EscalationDecision;
  /** Active level; the last active level once resolved. */
  level: number;
  /** Active level's deadline (epoch ms). */
  deadline: number;
  resolvedBy?:
    | { kind: "approver"; approverId: string }
    | { kind: "exhausted" };
}

export interface EscalationEngineOptions {
  /** Epoch-ms clock. Defaults to `Date.now`. */
  now?: () => number;
  onEvent?: (event: EscalationEvent) => void;
}

/** Thrown when an escalation policy is malformed. */
export class InvalidEscalationPolicyError extends Error {
  constructor(message: string) {
    super(`Invalid escalation policy: ${message}`);
    this.name = "InvalidEscalationPolicyError";
  }
}

/** Thrown when a decision comes from an approver outside the active level. */
export class ApproverNotActiveError extends Error {
  constructor(approverId: string, level: number) {
    super(`Approver ${approverId} is not on active escalation level ${level}`);
    this.name = "ApproverNotActiveError";
  }
}

export function validateEscalationPolicy(policy: EscalationPolicy): void {
  if (policy.levels.length === 0) {
    throw new InvalidEscalationPolicyError("levels must not be empty");
  }
  policy.levels.forEach((level, index) => {
    if (level.approvers.length === 0) {
      throw new InvalidEscalationPolicyError(
        `level ${index} approvers must not be empty`
      );
    }
    const seen = new Set<string>();
    for (const id of level.approvers) {
      if (id.trim() === "") {
        throw new InvalidEscalationPolicyError(
          `level ${index} approver ids must not be blank`
        );
      }
      if (seen.has(id)) {
        throw new InvalidEscalationPolicyError(
          `level ${index} duplicate approver ${id}`
        );
      }
      seen.add(id);
    }
    if (!Number.isInteger(level.timeoutMs) || level.timeoutMs <= 0) {
      throw new InvalidEscalationPolicyError(
        `level ${index} timeoutMs must be a positive integer`
      );
    }
  });
  if (
    policy.onExhausted !== undefined &&
    policy.onExhausted !== "reject" &&
    policy.onExhausted !== "approve"
  ) {
    throw new InvalidEscalationPolicyError(
      `unknown onExhausted ${String(policy.onExhausted)}`
    );
  }
}

export class EscalationEngine {
  private readonly policy: EscalationPolicy;
  private readonly now: () => number;
  private readonly onEvent: (event: EscalationEvent) => void;
  private current: EscalationState;

  constructor(policy: EscalationPolicy, options: EscalationEngineOptions = {}) {
    validateEscalationPolicy(policy);
    this.policy = policy;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent ?? (() => {});
    this.current = { status: "pending", level: 0, deadline: 0 };
    this.startLevel(0, this.now());
  }

  get state(): EscalationState {
    const { resolvedBy, ...rest } = this.current;
    return resolvedBy ? { ...rest, resolvedBy: { ...resolvedBy } } : rest;
  }

  /** Apply every deadline that has elapsed by `now()`. */
  tick(): EscalationState {
    const now = this.now();
    while (this.current.status === "pending" && now >= this.current.deadline) {
      const { level, deadline } = this.current;
      this.onEvent({ type: "level_timed_out", level, at: deadline });
      if (level + 1 < this.policy.levels.length) {
        this.startLevel(level + 1, deadline);
      } else {
        const action = this.policy.onExhausted ?? "reject";
        const decision = action === "approve" ? "granted" : "rejected";
        this.current = {
          ...this.current,
          status: decision,
          resolvedBy: { kind: "exhausted" },
        };
        this.onEvent({ type: "exhausted", action, decision, at: deadline });
      }
    }
    return this.state;
  }

  /**
   * Record a decision from an approver on the active level. Elapsed
   * deadlines are applied first; once resolved, later decisions are no-ops.
   */
  decide(
    approverId: string,
    decision: EscalationDecision,
    reason?: string
  ): EscalationState {
    this.tick();
    if (this.current.status !== "pending") return this.state;
    const { level } = this.current;
    if (!this.policy.levels[level]!.approvers.includes(approverId)) {
      throw new ApproverNotActiveError(approverId, level);
    }
    this.current = {
      ...this.current,
      status: decision,
      resolvedBy: { kind: "approver", approverId },
    };
    this.onEvent({
      type: "decided",
      level,
      approverId,
      decision,
      ...(reason !== undefined ? { reason } : {}),
      at: this.now(),
    });
    return this.state;
  }

  private startLevel(level: number, at: number): void {
    const { approvers, timeoutMs } = this.policy.levels[level]!;
    const deadline = at + timeoutMs;
    this.current = { status: "pending", level, deadline };
    this.onEvent({
      type: "level_started",
      level,
      approvers: [...approvers],
      at,
      deadline,
    });
  }
}
