import type { AgentSpec, AgentTask, RoutingDecision, RoutingPolicy, RuleBasedRoutingConfig } from '../routing-policy-types.js'

export class RuleBasedRouting implements RoutingPolicy {
  constructor(private readonly config: RuleBasedRoutingConfig) {}

  select(task: AgentTask, candidates: AgentSpec[]): RoutingDecision {
    // For each task tag, check if there's a matching rule
    if (task.tags) {
      for (const tag of task.tags) {
        const rule = this.config.rules.find((r) => r.tag === tag)
        if (rule) {
          const agent = candidates.find((a) => a.id === rule.agentId)
          if (agent) {
            return {
              selected: [agent],
              reason: rule.description ?? `Rule match: tag '${tag}' → agent '${rule.agentId}'`,
              strategy: 'rule',
            }
          }
        }
      }
    }
    // Fallback
    if (this.config.fallbackAgentId) {
      const fallback = candidates.find((a) => a.id === this.config.fallbackAgentId)
      if (fallback) {
        return { selected: [fallback], reason: 'Fallback rule (no tag match)', strategy: 'rule' }
      }
    }
    // Last resort: first candidate
    return {
      selected: candidates.slice(0, 1),
      reason: 'No matching rule or fallback; selected first candidate',
      strategy: 'rule',
    }
  }
}
