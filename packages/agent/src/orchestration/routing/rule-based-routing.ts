import type {
  AgentSpec,
  AgentTask,
  RoutingDecision,
  RoutingDiagnostics,
  RoutingPolicy,
  RuleBasedRoutingConfig,
} from "../routing-policy-types.js";

function makeDecisionId(strategy: string, taskId: string): string {
  return `${strategy}-${taskId}-${Date.now()}`;
}

export class RuleBasedRouting implements RoutingPolicy {
  constructor(private readonly config: RuleBasedRoutingConfig) {}

  select(task: AgentTask, candidates: AgentSpec[]): RoutingDecision {
    const candidateIds = candidates.map((c) => c.id);
    const rejectionReasons: Record<string, string> = {};

    // For each task tag, check if there's a matching rule
    if (task.tags) {
      for (const tag of task.tags) {
        const rule = this.config.rules.find((r) => r.tag === tag);
        if (rule) {
          const agent = candidates.find((a) => a.id === rule.agentId);
          if (agent) {
            const selectedIds = [agent.id];
            const filteredIds = candidateIds.filter((id) => id !== agent.id);
            for (const id of filteredIds) {
              rejectionReasons[
                id
              ] = `rule match on tag '${tag}' selected '${agent.id}'`;
            }
            const diagnostics: RoutingDiagnostics = {
              candidateIds,
              selectedIds,
              ...(Object.keys(rejectionReasons).length > 0
                ? { rejectionReasons }
                : {}),
            };
            return {
              selected: [agent],
              reason:
                rule.description ??
                `Rule match: tag '${tag}' → agent '${rule.agentId}'`,
              strategy: "rule",
              routingDecisionId: makeDecisionId("rule", task.taskId),
              diagnostics,
            };
          }
        }
      }
    }

    // Mark all candidates as unmatched before considering fallback
    for (const id of candidateIds) {
      rejectionReasons[id] = "no matching tag rule";
    }

    // Fallback
    if (this.config.fallbackAgentId) {
      const fallback = candidates.find(
        (a) => a.id === this.config.fallbackAgentId
      );
      if (fallback) {
        // The selected fallback is not a rejection — drop it from the map
        // rather than storing an undefined sentinel behind a cast.
        delete rejectionReasons[fallback.id];
        const cleanReasons: Record<string, string> = { ...rejectionReasons };
        const diagnostics: RoutingDiagnostics = {
          candidateIds,
          selectedIds: [fallback.id],
          fallbackReason: "no tag match",
          ...(Object.keys(cleanReasons).length > 0
            ? { rejectionReasons: cleanReasons }
            : {}),
        };
        return {
          selected: [fallback],
          reason: "Fallback rule (no tag match)",
          strategy: "rule",
          fallbackReason: "no tag match",
          routingDecisionId: makeDecisionId("rule", task.taskId),
          diagnostics,
        };
      }
    }

    // Last resort: first candidate
    const first = candidates[0];
    if (first) {
      const others = candidateIds.filter((id) => id !== first.id);
      const cleanReasons: Record<string, string> = { ...rejectionReasons };
      delete cleanReasons[first.id];
      for (const id of others) {
        cleanReasons[id] =
          "no matching rule or fallback; first-candidate selected";
      }
      const diagnostics: RoutingDiagnostics = {
        candidateIds,
        selectedIds: [first.id],
        ...(Object.keys(cleanReasons).length > 0
          ? { rejectionReasons: cleanReasons }
          : {}),
      };
      return {
        selected: [first],
        reason: "No matching rule or fallback; selected first candidate",
        strategy: "rule",
        routingDecisionId: makeDecisionId("rule", task.taskId),
        diagnostics,
      };
    }

    return {
      selected: [],
      reason: "No candidates available",
      strategy: "rule",
      routingDecisionId: makeDecisionId("rule", task.taskId),
      diagnostics: { candidateIds: [], selectedIds: [] },
    };
  }
}
