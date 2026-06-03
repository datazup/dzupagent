/**
 * RoutingPolicy — pluggable agent selection strategy for multi-agent orchestration.
 *
 * Built-in policies: RuleBasedRouting, HashRouting, LLMRouting, RoundRobinRouting
 * The supervisor uses a RoutingPolicy to select which agent(s) to delegate to.
 */

/** Minimal description of an agent that can be selected for routing */
export interface AgentSpec {
  /** Unique identifier for this agent */
  id: string;
  /** Human-readable name */
  name: string;
  /** Capability tags used by rule-based routing */
  tags?: string[];
  /** Custom metadata for routing policies */
  metadata?: Record<string, unknown>;
}

/** A task submitted to the supervisor for routing */
export interface AgentTask {
  /** Unique task identifier */
  taskId: string;
  /** The task description/content */
  content: string;
  /** Tags that may match agent capabilities */
  tags?: string[];
  /** Priority hint (higher = more urgent) */
  priority?: number;
  /** Custom metadata passed to routing policies */
  metadata?: Record<string, unknown>;
}

/** The result of a routing decision */
export interface RoutingDecision {
  /** The selected agent(s) to delegate to */
  selected: AgentSpec[];
  /** Human-readable explanation of why these agents were chosen */
  reason: string;
  /** Which strategy produced this decision */
  strategy: "rule" | "hash" | "llm" | "round-robin" | string;
  /** Human-readable explanation when the policy used deterministic fallback behavior */
  fallbackReason?: string;
  /** Machine-readable routing diagnostics for observability */
  diagnostics?: RoutingDiagnostics;
  /**
   * Stable identifier for this routing decision (W7). Persisted on the run
   * record so LLM-routed supervisors can be replayed and audited post-mortem.
   * Format: `<strategy>-<taskId>-<timestamp>`.
   */
  routingDecisionId?: string;
}

/** Machine-readable routing details emitted by supervisors when available */
export interface RoutingDiagnostics {
  /** Candidate IDs considered by the routing policy */
  candidateIds: string[];
  /** Candidate IDs selected by the routing policy */
  selectedIds: string[];
  /** Fallback reason when the policy did not produce a primary selection */
  fallbackReason?: string;
  /**
   * Per-candidate rejection reasons (W6). Keys are candidate IDs that were
   * NOT selected; values explain why (e.g. "no matching tag rule",
   * "circuit open", "hash routed to index 2"). Omitted when all candidates
   * are selected or the policy does not track per-candidate reasons.
   */
  rejectionReasons?: Record<string, string>;
}

/**
 * RoutingPolicy — decides which agent(s) handle a given task.
 *
 * Implementations are responsible for being deterministic (for rule/hash)
 * or documenting non-determinism (for LLM).
 */
export interface RoutingPolicy {
  /**
   * Select agent(s) from candidates for the given task.
   * Must return at least one agent if candidates is non-empty.
   */
  select(task: AgentTask, candidates: AgentSpec[]): RoutingDecision;
}

export type LLMRoutingFallback = "pass-through" | "first-candidate";

export type LLMRoutingSelection =
  | string
  | string[]
  | AgentSpec
  | AgentSpec[]
  | RoutingDecision
  | null
  | undefined;

/** Configuration for the explicit LLM routing adapter */
export interface LLMRoutingConfig {
  /**
   * Product/framework-provided selector result. This stays provider-neutral:
   * callers can adapt any model/tool result into candidate IDs or AgentSpec(s).
   */
  selector?: (task: AgentTask, candidates: AgentSpec[]) => LLMRoutingSelection;
  /**
   * Required deterministic fallback when the selector is omitted, empty, or
   * returns IDs that are not in the current candidate set.
   */
  fallback: LLMRoutingFallback;
}

/** Configuration for rule-based routing */
export interface RuleBasedRoutingConfig {
  /**
   * Tag routing rules: maps a tag to an agent ID.
   * First matching rule wins.
   */
  rules: Array<{
    /** The tag to match on task.tags */
    tag: string;
    /** Agent ID to route to when tag matches */
    agentId: string;
    /** Optional human-readable description of this rule */
    description?: string;
  }>;
  /** Fallback agent ID if no rule matches (required) */
  fallbackAgentId?: string;
}

/** Configuration for hash-based routing */
export interface HashRoutingConfig {
  /** Field to hash on: 'content' | 'taskId' | custom key from metadata */
  hashKey?: "content" | "taskId" | string;
}
