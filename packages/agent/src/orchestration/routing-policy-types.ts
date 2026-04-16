/**
 * RoutingPolicy — pluggable agent selection strategy for multi-agent orchestration.
 *
 * Built-in policies: RuleBasedRouting, HashRouting, LLMRouting, RoundRobinRouting
 * The supervisor uses a RoutingPolicy to select which agent(s) to delegate to.
 */

/** Minimal description of an agent that can be selected for routing */
export interface AgentSpec {
  /** Unique identifier for this agent */
  id: string
  /** Human-readable name */
  name: string
  /** Capability tags used by rule-based routing */
  tags?: string[]
  /** Custom metadata for routing policies */
  metadata?: Record<string, unknown>
}

/** A task submitted to the supervisor for routing */
export interface AgentTask {
  /** Unique task identifier */
  taskId: string
  /** The task description/content */
  content: string
  /** Tags that may match agent capabilities */
  tags?: string[]
  /** Priority hint (higher = more urgent) */
  priority?: number
  /** Custom metadata passed to routing policies */
  metadata?: Record<string, unknown>
}

/** The result of a routing decision */
export interface RoutingDecision {
  /** The selected agent(s) to delegate to */
  selected: AgentSpec[]
  /** Human-readable explanation of why these agents were chosen */
  reason: string
  /** Which strategy produced this decision */
  strategy: 'rule' | 'hash' | 'llm' | 'round-robin' | string
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
  select(task: AgentTask, candidates: AgentSpec[]): RoutingDecision
}

/** Configuration for rule-based routing */
export interface RuleBasedRoutingConfig {
  /**
   * Tag routing rules: maps a tag to an agent ID.
   * First matching rule wins.
   */
  rules: Array<{
    /** The tag to match on task.tags */
    tag: string
    /** Agent ID to route to when tag matches */
    agentId: string
    /** Optional human-readable description of this rule */
    description?: string
  }>
  /** Fallback agent ID if no rule matches (required) */
  fallbackAgentId?: string
}

/** Configuration for hash-based routing */
export interface HashRoutingConfig {
  /** Field to hash on: 'content' | 'taskId' | custom key from metadata */
  hashKey?: 'content' | 'taskId' | string
}
