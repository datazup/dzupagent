import { randomUUID } from "node:crypto";
import { OrchestrationError } from "../orchestration-error.js";
import type { OrchestrationPattern } from "../orchestration-error.js";
import type {
  AgentSpec,
  AgentTask,
  RoutingDecision,
} from "../routing-policy-types.js";

/** Mint a unique decision identity independently from stable task identity. */
export function createRoutingDecisionId(
  strategy: string,
  taskId: string
): string {
  const safeStrategy = strategy.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `${safeStrategy || "routing"}-${taskId}-${randomUUID()}`;
}

/**
 * Fail closed on invalid policy output, canonicalize selected candidates, and
 * ensure every accepted invocation has a unique observable decision identity.
 */
export function normalizeRoutingDecision(
  task: AgentTask,
  candidates: readonly AgentSpec[],
  decision: RoutingDecision,
  pattern: OrchestrationPattern
): RoutingDecision {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selectedIds = decision.selected.map((candidate) => candidate.id);
  const foreignIds = selectedIds.filter((id) => !candidatesById.has(id));

  if (foreignIds.length > 0) {
    throw new OrchestrationError(
      `Routing policy selected candidate(s) outside the admitted candidate set: ${foreignIds.join(", ")}`,
      pattern,
      { taskId: task.taskId, foreignIds }
    );
  }

  if (candidates.length > 0 && selectedIds.length === 0) {
    throw new OrchestrationError(
      "Routing policy must select at least one candidate when candidates are available",
      pattern,
      { taskId: task.taskId, candidateIds: candidates.map((candidate) => candidate.id) }
    );
  }

  const canonicalSelected = [
    ...new Map(
      selectedIds.map((id) => [id, candidatesById.get(id)!])
    ).values(),
  ];
  const routingDecisionId = decision.routingDecisionId?.trim()
    ? decision.routingDecisionId
    : createRoutingDecisionId(decision.strategy, task.taskId);
  return {
    ...decision,
    selected: canonicalSelected,
    routingDecisionId,
  };
}
