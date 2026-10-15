/**
 * Knowledge-envelope writers for fleet run bookkeeping.
 *
 * Task-state and decision envelopes are the run's durable audit trail. They are
 * written from several places in the supervisor (the control surface, the
 * dispatch loop, the escalation path), so the envelope shapes live here rather
 * than being spelled out at each call site.
 *
 * @module orchestration/fleet/fleet-run-records
 */
import { ulid } from "ulidx";
import { KnowledgeCollisionError } from "@dzupagent/agent-types/fleet";
import type {
  KnowledgeEnvelope,
  KnowledgeStore,
  TaskState,
  TaskStatePayload,
} from "@dzupagent/agent-types/fleet";

/** Decision envelope kinds the supervisor records. */
export type DecisionKind =
  | "assignment"
  | "reconciliation"
  | "escalation"
  | "budget-exhausted";

/** Record a control-driven task state transition (pause, cancel, reassign). */
export async function writeTaskControlState(
  knowledge: KnowledgeStore,
  runId: string,
  taskId: string,
  state: TaskState,
  blockedReason: string
): Promise<void> {
  const payload: TaskStatePayload = { taskId, state, blockedReason };
  const env: KnowledgeEnvelope = {
    id: ulid(),
    runId,
    repo: null,
    kind: "task-state",
    key: taskId,
    version:
      Date.now() * 1000 +
      (Math.abs(taskId.charCodeAt(taskId.length - 1)) % 1000),
    authorWorkerId: null,
    parentId: null,
    createdAt: new Date().toISOString(),
    supersededAt: null,
    payload,
    tags: ["control"],
  };
  // A worker's task-state write in the same millisecond can derive the same
  // version (RepoAgent uses the same clock-based scheme). Step past it the way
  // RepoAgent does rather than failing the control operation.
  const scope = `run:${runId}`;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      await knowledge.append(scope, env);
      return;
    } catch (error) {
      if (!(error instanceof KnowledgeCollisionError) || attempt === 999) {
        throw error;
      }
      env.version += 1;
    }
  }
}

/** Record a policy decision and the inputs it was asked about. */
export async function writeDecision(
  knowledge: KnowledgeStore,
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
  await knowledge.append(`run:${runId}`, env);
}
