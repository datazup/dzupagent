import type {
  AgentSpec,
  AgentTask,
  RoutingDecision,
  RoutingPolicy,
} from "../routing-policy-types.js";

export class RoundRobinRouting implements RoutingPolicy {
  private counter = 0;

  select(task: AgentTask, candidates: AgentSpec[]): RoutingDecision {
    if (candidates.length === 0) {
      return {
        selected: [],
        reason: "No candidates available",
        strategy: "round-robin",
        routingDecisionId: `round-robin-${task.taskId}-${Date.now()}`,
        diagnostics: { candidateIds: [], selectedIds: [] },
      };
    }
    const index = this.counter % candidates.length;
    this.counter++;
    const agent = candidates[index]!;
    const candidateIds = candidates.map((c) => c.id);
    const rejectionReasons: Record<string, string> = {};
    for (const c of candidates) {
      if (c.id !== agent.id) {
        rejectionReasons[
          c.id
        ] = `round-robin slot ${index} selected '${agent.id}'`;
      }
    }
    return {
      selected: [agent],
      reason: `Round-robin: slot ${index} → agent '${agent.id}'`,
      strategy: "round-robin",
      routingDecisionId: `round-robin-${task.taskId}-${Date.now()}`,
      diagnostics: {
        candidateIds,
        selectedIds: [agent.id],
        ...(Object.keys(rejectionReasons).length > 0
          ? { rejectionReasons }
          : {}),
      },
    };
  }

  /** Reset counter (useful for testing) */
  reset(): void {
    this.counter = 0;
  }
}
