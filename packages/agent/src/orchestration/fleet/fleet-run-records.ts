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
  await knowledge.append(`run:${runId}`, env);
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
