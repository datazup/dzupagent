import type { AgentSpec, AgentTask, RoutingDecision, RoutingPolicy } from '../routing-policy-types.js'

/**
 * LLMRouting -- delegates agent selection to an LLM.
 *
 * This is a stub that preserves the existing LLM-based routing behavior.
 * The actual LLM call happens in the supervisor; this class provides the
 * RoutingPolicy interface wrapper.
 *
 * When the supervisor uses LLMRouting, it should call its internal
 * LLM selection logic and pass the result back via createDecision().
 */
export class LLMRouting implements RoutingPolicy {
  /** Synchronous fallback: return all candidates (supervisor's LLM will refine) */
  select(_task: AgentTask, candidates: AgentSpec[]): RoutingDecision {
    return {
      selected: candidates,
      reason: 'LLM routing: all candidates passed to supervisor for LLM selection',
      strategy: 'llm',
    }
  }

  /**
   * Create a decision from an LLM-selected agent ID.
   * Called by the supervisor after its LLM makes a selection.
   */
  createDecision(agentId: string, candidates: AgentSpec[], llmReason?: string): RoutingDecision {
    const agent = candidates.find((a) => a.id === agentId)
    return {
      selected: agent ? [agent] : candidates.slice(0, 1),
      reason: llmReason ?? `LLM selected agent '${agentId}'`,
      strategy: 'llm',
    }
  }
}
