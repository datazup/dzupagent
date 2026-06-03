import { ulid } from "ulidx";
import { ForgeError } from "@dzupagent/core/events";
import type {
  FleetRunResult,
  FleetRunSpec,
  KnowledgeEnvelope,
  RepoAgentResult,
  RepoRef,
  Executor,
  KnowledgeStore,
  FleetPolicy,
  FleetSupervisorApi,
  RepoAgentRef,
} from "@dzupagent/agent-types/fleet";
import { RepoAgent } from "./repo-agent.js";

export interface FleetSupervisorDeps {
  knowledge: KnowledgeStore;
  executorFor: (repo: RepoRef) => Executor;
}

type DecisionKind =
  | "assignment"
  | "reconciliation"
  | "escalation"
  | "budget-exhausted";

interface RepoAgentSlot {
  agent: RepoAgent;
  repo: RepoRef;
  ref: RepoAgentRef;
}

/**
 * FleetSupervisor drives a FleetRunSpec to completion. For fan-out scenarios
 * every repo runs the task in parallel; otherwise the injected FleetPolicy
 * assigns each task to a single worker. Assignment decisions are mirrored into
 * the shared KnowledgeStore.
 *
 * Mid-run control (pause/cancel/reassign) is **not implemented** in Phase 1a.
 * These methods throw a {@link ForgeError} (`CAPABILITY_NOT_FOUND`,
 * non-recoverable) rather than silently no-op'ing, so a policy that depends on
 * them fails loudly instead of believing the fleet can be drained or rebalanced.
 * Real implementations land in Phase 1b.
 */
export class FleetSupervisor implements FleetSupervisorApi {
  constructor(private readonly deps: FleetSupervisorDeps) {}

  async run(spec: FleetRunSpec, policy: FleetPolicy): Promise<FleetRunResult> {
    await this.seed(spec);

    const repoAgents = new Map<string, RepoAgentSlot>();
    for (const repo of spec.repos) {
      const ref: RepoAgentRef = {
        workerId: `w-${ulid()}`,
        repo: repo.name,
        busy: false,
      };
      const agent = new RepoAgent({
        runId: spec.runId,
        repo,
        executor: this.deps.executorFor(repo),
        knowledge: this.deps.knowledge,
        workerId: ref.workerId,
      });
      repoAgents.set(repo.name, { agent, repo, ref });
    }

    const outcomes: RepoAgentResult[] = [];
    const isFanOut =
      spec.scenario === "audit-fanout" || policy.id === "fan-out";

    if (isFanOut) {
      for (const task of spec.tasks) {
        const runs = [...repoAgents.values()].map(async ({ agent, ref }) => {
          ref.busy = true;
          try {
            const result = await agent.dispatch(task);
            outcomes.push(result);
            return result;
          } finally {
            ref.busy = false;
          }
        });
        await Promise.all(runs);
      }
    } else {
      for (const task of spec.tasks) {
        const fleet: RepoAgentRef[] = [...repoAgents.values()].map(
          (v) => v.ref
        );
        const assignment = await policy.assignTask(
          task,
          fleet,
          this.deps.knowledge
        );
        const target = [...repoAgents.values()].find(
          (v) => v.ref.workerId === assignment.workerId
        );
        if (!target) {
          throw new Error(
            `Policy assigned unknown worker ${assignment.workerId}`
          );
        }
        await this.writeDecision(
          spec.runId,
          "assignment",
          policy.id,
          [task.id, assignment.workerId],
          assignment.rationale
        );
        target.ref.busy = true;
        try {
          const result = await target.agent.dispatch(task);
          outcomes.push(result);
          await policy.onWorkerComplete(result, this);
        } finally {
          target.ref.busy = false;
        }
      }
    }

    const allOk = outcomes.every((o) => o.state === "completed");
    return {
      runId: spec.runId,
      status: allOk ? "completed" : "failed",
      finishedAt: new Date().toISOString(),
      taskOutcomes: outcomes,
    };
  }

  async pauseTask(taskId: string, reason: string): Promise<void> {
    throw this.unimplementedControl("pauseTask", taskId, { reason });
  }
  async cancelTask(taskId: string, reason: string): Promise<void> {
    throw this.unimplementedControl("cancelTask", taskId, { reason });
  }
  async reassign(taskId: string): Promise<void> {
    throw this.unimplementedControl("reassign", taskId);
  }

  /**
   * Build a non-recoverable error for the Phase-1b fleet control surface so
   * callers fail loudly instead of relying on a silent no-op.
   */
  private unimplementedControl(
    operation: "pauseTask" | "cancelTask" | "reassign",
    taskId: string,
    extra: Record<string, unknown> = {}
  ): ForgeError {
    return new ForgeError({
      code: "CAPABILITY_NOT_FOUND",
      message: `FleetSupervisor.${operation} is not implemented (Phase 1b).`,
      recoverable: false,
      suggestion:
        "Mid-run fleet control (pause/cancel/reassign) is not available in Phase 1a. " +
        "Do not depend on it from a FleetPolicy yet.",
      context: { operation, taskId, ...extra },
    });
  }

  private async seed(spec: FleetRunSpec): Promise<void> {
    for (const entry of spec.seedKnowledge ?? []) {
      await this.deps.knowledge.append(`run:${spec.runId}`, entry);
    }
  }

  private async writeDecision(
    runId: string,
    decisionKind: DecisionKind,
    policyId: string,
    inputs: unknown[],
    outcome: unknown
  ): Promise<void> {
    const env: KnowledgeEnvelope = {
      id: ulid(),
      runId,
      repo: null,
      kind: "decision",
      key: `${decisionKind}-${ulid()}`,
      version: 1,
      authorWorkerId: null,
      parentId: null,
      createdAt: new Date().toISOString(),
      supersededAt: null,
      payload: { decisionKind, inputs, outcome, policyId },
      tags: [],
    };
    await this.deps.knowledge.append(`run:${runId}`, env);
  }
}
