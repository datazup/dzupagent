import type { AgentSpec, AgentTask, RoutingDecision, RoutingPolicy } from '../routing-policy-types.js'

export class RoundRobinRouting implements RoutingPolicy {
  private counter = 0

  select(_task: AgentTask, candidates: AgentSpec[]): RoutingDecision {
    if (candidates.length === 0) {
      return { selected: [], reason: 'No candidates available', strategy: 'round-robin' }
    }
    const index = this.counter % candidates.length
    this.counter++
    const agent = candidates[index]!
    return {
      selected: [agent],
      reason: `Round-robin: slot ${index} → agent '${agent.id}'`,
      strategy: 'round-robin',
    }
  }

  /** Reset counter (useful for testing) */
  reset(): void {
    this.counter = 0
  }
}
