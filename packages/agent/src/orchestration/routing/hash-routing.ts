import type {
  AgentSpec,
  AgentTask,
  RoutingDecision,
  RoutingPolicy,
  HashRoutingConfig,
} from "../routing-policy-types.js";

/** Simple djb2-style hash for consistent routing */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep as unsigned 32-bit
  }
  return hash;
}

export class HashRouting implements RoutingPolicy {
  private readonly hashKey: string;

  constructor(config: HashRoutingConfig = {}) {
    this.hashKey = config.hashKey ?? "taskId";
  }

  select(task: AgentTask, candidates: AgentSpec[]): RoutingDecision {
    if (candidates.length === 0) {
      return {
        selected: [],
        reason: "No candidates available",
        strategy: "hash",
        routingDecisionId: `hash-${task.taskId}-${Date.now()}`,
        diagnostics: { candidateIds: [], selectedIds: [] },
      };
    }
    const key =
      this.hashKey === "taskId"
        ? task.taskId
        : this.hashKey === "content"
        ? task.content
        : (task.metadata?.[this.hashKey] as string | undefined) ?? task.taskId;

    const index = hashString(key) % candidates.length;
    const agent = candidates[index]!;
    const candidateIds = candidates.map((c) => c.id);
    const rejectionReasons: Record<string, string> = {};
    for (const c of candidates) {
      if (c.id !== agent.id) {
        rejectionReasons[
          c.id
        ] = `hash of '${key}' maps to index ${index} (agent '${agent.id}')`;
      }
    }
    return {
      selected: [agent],
      reason: `Hash routing: key '${key}' → index ${index} → agent '${agent.id}'`,
      strategy: "hash",
      routingDecisionId: `hash-${task.taskId}-${Date.now()}`,
      diagnostics: {
        candidateIds,
        selectedIds: [agent.id],
        ...(Object.keys(rejectionReasons).length > 0
          ? { rejectionReasons }
          : {}),
      },
    };
  }
}
