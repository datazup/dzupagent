/**
 * Team policy types — orthogonal knobs that control how a `TeamDefinition`
 * executes at runtime.
 *
 * Each policy is optional; the runtime applies sensible defaults for supported
 * omissions and rejects reserved policy groups or fields until it can enforce
 * them. Policies are deliberately decoupled from the definition so that the
 * same team can be promoted from ephemeral/sandboxed to persistent/live by
 * swapping policy objects once those controls are implemented.
 */

/** Controls the supported participant scheduling subset for TeamRuntime. */
export interface ExecutionPolicy {
  /** Max number of peer participants running concurrently (default: 5). */
  maxParallelParticipants?: number;
  /**
   * Hard timeout (ms, positive integer) around an entire team run.
   *
   * On expiry the run rejects through the normal failure path (team_failed
   * event, span error). The abandoned pattern promise is NOT cancelled —
   * in-flight member calls run to completion but their results are discarded.
   */
  timeoutMs?: number;
  /**
   * Retry a failed participant attempt (peer_to_peer pattern only; other
   * patterns reject this field). Retries are immediate, up to `maxRetries`
   * extra attempts (default 1).
   */
  retryOnFailure?: boolean;
  /**
   * Extra attempts per participant after the first failure (positive
   * integer, default 1). Requires `retryOnFailure: true`; peer_to_peer only.
   */
  maxRetries?: number;
}

/**
 * Controls quality gates applied by a judge model (typically Opus).
 * Used most heavily by the `council` pattern but available to any pattern.
 */
export interface GovernancePolicy {
  /** Model to use for judging. Recommended: `claude-opus-4-7`. */
  judgeModel: string;
  /**
   * Minimum acceptable judge score in [0, 1]; below this rejects the run.
   *
   * Enforced by the governance acceptance gate after a council run completes,
   * but only when a `TeamGovernanceService` is injected into the runtime — the
   * runtime cannot itself score a free-form judge verdict. When no scorer is
   * wired the run passes ungated (the same seam as
   * `MemoryPolicy.consolidateOnComplete`), but NOT silently: the runtime emits
   * `team_verdict_evaluated` with `outcome: 'skipped'` so an unenforced
   * threshold is visible rather than masquerading as a met one.
   *
   * `createDeterministicVerdictService` in `@dzupagent/testing` is a wireable
   * model-free scorer for tests and as a host template.
   */
  minScore?: number;
  /**
   * If true, council requires unanimous judgment to pass.
   *
   * Enforced by the governance acceptance gate (via the injected
   * `TeamGovernanceService.evaluate` returning `unanimous`). With no scorer
   * wired the run passes ungated and reports a `skipped` verdict, exactly as
   * for {@link GovernancePolicy.minScore}.
   */
  requireUnanimous?: boolean;
}

/**
 * Controls how team memory is scoped and persisted.
 *
 * `tier` and `shareAcrossParticipants` are SCOPED OUT of in-repo TeamRuntime
 * enforcement (see their field docs); `consolidateOnComplete` is enforced behind
 * the host-injected memory-service seam and `blackboardContext` is enforced by
 * the blackboard pattern.
 */
export interface MemoryPolicy {
  /**
   * Storage tier for team memory.
   *
   * SCOPED OUT of in-repo TeamRuntime enforcement: the runtime owns no store
   * whose lifetime this could select. The only store it provisions is a per-run
   * in-process `SharedWorkspace` that is unconditionally ephemeral (discarded
   * when the run ends — there is no "session"/"persistent" mode to switch it
   * to), and all durable persistence happens inside the host-injected
   * `TeamRuntimeMemoryService` (`consolidate` / `store`), whose retention the
   * runtime cannot see or control. Choosing a tier is therefore a consuming-app
   * concern — an app backing that service with a real store reads this policy
   * itself. Note this field deliberately does NOT gate the consolidation pass:
   * `consolidateOnComplete` already expresses that intent directly, and having
   * `tier` silently veto it would create a second, contradictory gate. The
   * validator shape-checks the field so a malformed declaration fails fast.
   */
  tier: "ephemeral" | "session" | "persistent";
  /**
   * Whether all participants share the same memory store.
   *
   * SCOPED OUT of in-repo TeamRuntime enforcement: there are no per-participant
   * memory writes for this flag to partition. Participants share a single
   * per-run `SharedWorkspace` by construction (the runtime has no "unshared"
   * mode — the same reason `IsolationPolicy.sharedWorkspace` is scoped out), and
   * the only memory-service interaction is a single post-run consolidation pass
   * at team scope (`consolidateIfEnabled` uses `namespace = teamId`), which has
   * no participant dimension to split on. Scoping a namespace per participant
   * here would consolidate namespaces nothing ever wrote to. Partitioning memory
   * per participant is therefore a consuming-app concern, owned by whoever backs
   * the memory service. The validator shape-checks the field so a malformed
   * declaration fails fast.
   */
  shareAcrossParticipants: boolean;
  /**
   * Whether to consolidate/summarize memory when the run completes.
   *
   * Enforced by the post-run consolidation pass (`consolidateIfEnabled`) when a
   * `TeamRuntimeMemoryService` (`consolidate` callback or `store`) is injected;
   * inert when no memory service is wired.
   */
  consolidateOnComplete?: boolean;
  /**
   * Serialized-size budget for blackboard shared context passed to
   * participants. Applies only to the `blackboard` coordinator pattern.
   */
  blackboardContext?: BlackboardContextPolicy;
}

/** Overflow behavior for bounded blackboard context. */
export type BlackboardContextOverflowBehavior = "compact" | "reject";

/** Controls bounded shared-context prompts for the blackboard pattern. */
export interface BlackboardContextPolicy {
  /** Maximum serialized characters for the formatted shared context. */
  maxSerializedChars?: number;
  /** Maximum characters accepted for a single participant contribution. */
  maxEntryChars?: number;
  /** How to handle oversized participant contributions (default: `compact`). */
  overflowBehavior?: BlackboardContextOverflowBehavior;
}

/**
 * Controls the contract-net negotiation run by the `contract_net` coordinator
 * pattern. Applies only to that pattern — the validator rejects this group on
 * any other, mirroring `MemoryPolicy`/`blackboard`.
 *
 * Every field here is threaded straight through to `ContractNetManager.execute`
 * as the matching `ContractNetConfig` field, so each is genuinely ENFORCED (no
 * host-injected-service seam, unlike governance / evaluation). Omitting the
 * group entirely leaves the negotiation on the manager's own defaults, which is
 * exactly the behaviour before this policy existed.
 *
 * Runtime plumbing (`signal`, `eventBus`, `strategy`) is deliberately NOT here:
 * those are not declarative, JSON-expressible knobs, so they ride on
 * `TeamRuntimeOptions` / `TeamPatternContext` instead (see `contractNet` on
 * `TeamRuntimeOptions`).
 */
export interface ContractNetPolicy {
  /**
   * Hard cost ceiling for the awarded contract, in cents. ENFORCED by
   * `ContractNetManager`: bids above it are filtered out before ranking and can
   * never win, and the negotiation throws when no bid fits. Inclusive bound.
   * Omit for no ceiling.
   */
  maxCostCents?: number;
  /** Capabilities announced in the CFP prompt. Must be non-empty strings. */
  requiredCapabilities?: string[];
  /** Per-specialist bid deadline in ms (positive integer, manager default 30000). */
  bidDeadlineMs?: number;
  /** Retry the bidding round once with a doubled deadline when no bids arrive. */
  retryOnNoBids?: boolean;
}

/**
 * Controls sandboxing and workspace sharing.
 *
 * SCOPED OUT of in-repo TeamRuntime enforcement: the runtime spawns
 * participant agents in-process and has no sandbox executor, and it always
 * provisions a fresh per-run `SharedWorkspace` (there is no "unshared" mode to
 * toggle). These knobs are therefore a consuming-app concern — an app that runs
 * participants in real sandboxes/containers reads this policy itself. The
 * validator shape-checks the fields so a malformed declaration fails fast.
 */
export interface IsolationPolicy {
  /** Whether participants run in a sandboxed environment. */
  sandboxed: boolean;
  /** Whether participants share a filesystem/workspace. */
  sharedWorkspace: boolean;
}

/**
 * Controls inter-participant mailbox (message passing).
 *
 * SCOPED OUT of in-repo TeamRuntime enforcement: team coordination patterns do
 * not route messages through the `@dzupagent/agent/mailbox` subsystem, which is
 * host-driven (the host constructs `AgentMailbox` instances and wires delivery).
 * `deliveryMode` / `maxQueueDepth` are therefore a consuming-app concern; the
 * validator shape-checks them so a malformed declaration fails fast.
 */
export interface MailboxPolicy {
  /** Max queued messages per participant (default: unbounded). */
  maxQueueDepth?: number;
  /** How messages are delivered to participants. */
  deliveryMode: "broadcast" | "targeted" | "round_robin";
}

/**
 * Controls automated scoring of the team's final output.
 * Typically uses an Opus-class scorer model for high-stakes evaluation.
 *
 * `minPassScore` is enforced by the evaluation acceptance gate after any
 * pattern completes, but only when a `TeamEvaluationService` is injected into
 * the runtime (`scorerModel` / `scoringCriteria` are passed to it as inputs).
 * Without a scorer service the run passes ungated — the same
 * host-injected-service seam as governance and memory consolidation — and the
 * runtime emits `team_verdict_evaluated` with `outcome: 'skipped'` so the
 * unenforced threshold is observable instead of looking like a pass.
 */
export interface EvaluationPolicy {
  /** Model to use for scoring. Recommended: `claude-opus-4-7`. */
  scorerModel: string;
  /** Human-readable criteria the scorer should apply. */
  scoringCriteria?: string[];
  /** Minimum passing score in [0, 1]. */
  minPassScore?: number;
}

/** Aggregate of all optional team policies. */
export interface TeamPolicies {
  execution?: ExecutionPolicy;
  governance?: GovernancePolicy;
  memory?: MemoryPolicy;
  contractNet?: ContractNetPolicy;
  isolation?: IsolationPolicy;
  mailbox?: MailboxPolicy;
  evaluation?: EvaluationPolicy;
}
