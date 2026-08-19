import { createHash } from "node:crypto";
import { isContractPayload } from "@dzupagent/agent-types/fleet";
import type {
  ContractPayload,
  DecisionPayload,
  KnowledgeEnvelope,
  ReconciliationPlan,
  TaskStatePayload,
} from "@dzupagent/agent-types/fleet";

export class FleetReconciliationError extends Error {
  constructor(message: string) {
    super(`Fleet reconciliation rejected: ${message}`);
    this.name = "FleetReconciliationError";
  }
}

export interface ContractProposalRecord {
  envelope: KnowledgeEnvelope;
  payload: ContractPayload;
}

export interface ValidatedReconciliationPlan {
  ratifiedSource: ContractProposalRecord | null;
  rejectedSources: ContractProposalRecord[];
  pauseTaskIds: string[];
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => entry === undefined ? null : canonicalValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = canonicalValue(entry);
    }
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

export function canonicalReconciliationJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
    hash.update(";");
  }
  return hash.digest("hex");
}

export function reconciliationDecisionIdentity(
  runId: string,
  surface: string,
  proposalIds: readonly string[]
): string {
  return `reconciliation-${digest([runId, surface, ...proposalIds])}`;
}

export function buildReconciliationDecisionEnvelope(args: {
  runId: string;
  surface: string;
  proposalIds: string[];
  policyId: string;
  plan: ReconciliationPlan;
  createdAt: string;
}): KnowledgeEnvelope {
  const identity = reconciliationDecisionIdentity(
    args.runId,
    args.surface,
    args.proposalIds
  );
  const payload: DecisionPayload = {
    decisionKind: "reconciliation",
    inputs: [args.surface, ...args.proposalIds],
    outcome: args.plan,
    policyId: args.policyId,
  };
  return {
    id: identity,
    runId: args.runId,
    repo: null,
    kind: "decision",
    key: identity,
    version: 1,
    authorWorkerId: null,
    parentId: null,
    createdAt: args.createdAt,
    supersededAt: null,
    payload,
    tags: ["reconciliation"],
  };
}

export function parseReconciliationDecision(
  entry: KnowledgeEnvelope
): { surface: string; proposalIds: string[]; plan: ReconciliationPlan } | null {
  if (entry.kind !== "decision") return null;
  const payload = entry.payload as Partial<DecisionPayload>;
  if (
    payload.decisionKind !== "reconciliation"
    || !Array.isArray(payload.inputs)
    || typeof payload.inputs[0] !== "string"
  ) {
    return null;
  }
  const proposalIds = payload.inputs.slice(1);
  if (!proposalIds.every((id): id is string => typeof id === "string")) {
    throw new FleetReconciliationError(
      `decision ${entry.id} has non-string proposal inputs`
    );
  }
  if (proposalIds.length === 0) {
    throw new FleetReconciliationError(
      `decision ${entry.id} has no proposal inputs`
    );
  }
  if (payload.outcome === null || typeof payload.outcome !== "object") {
    throw new FleetReconciliationError(
      `decision ${entry.id} has a malformed outcome`
    );
  }
  return {
    surface: payload.inputs[0],
    proposalIds,
    plan: payload.outcome as ReconciliationPlan,
  };
}

function assertPlanShape(plan: ReconciliationPlan): void {
  if (
    !Array.isArray(plan.rejectIds)
    || !plan.rejectIds.every((id) => typeof id === "string")
    || !Array.isArray(plan.pauseTasks)
    || !plan.pauseTasks.every((id) => typeof id === "string")
    || typeof plan.escalate !== "boolean"
  ) {
    throw new FleetReconciliationError("policy returned a malformed action plan");
  }
  if (plan.ratified !== null && !isContractPayload(plan.ratified)) {
    throw new FleetReconciliationError("ratified payload is malformed");
  }
}

function assertUnique(label: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new FleetReconciliationError(`${label} contains duplicate IDs`);
  }
}

export function validateReconciliationPlan(args: {
  surface: string;
  proposals: ContractProposalRecord[];
  plan: ReconciliationPlan;
  knownTaskIds: ReadonlySet<string>;
  settledTaskIds: ReadonlySet<string>;
}): ValidatedReconciliationPlan {
  const { surface, proposals, plan, knownTaskIds, settledTaskIds } = args;
  assertPlanShape(plan);
  assertUnique(
    "proposalIds",
    proposals.map((proposal) => proposal.envelope.id)
  );
  assertUnique("rejectIds", plan.rejectIds);
  assertUnique("pauseTasks", plan.pauseTasks);

  const proposalsById = new Map(
    proposals.map((proposal) => [proposal.envelope.id, proposal])
  );
  let ratifiedSource: ContractProposalRecord | null = null;
  if (plan.ratified !== null) {
    if (plan.ratified.status !== "ratified" || plan.ratified.surface !== surface) {
      throw new FleetReconciliationError(
        "ratified payload must target the current surface with ratified status"
      );
    }
    const ratifiedBytes = canonicalReconciliationJson(plan.ratified);
    ratifiedSource = proposals.find((proposal) => (
      canonicalReconciliationJson({
        ...proposal.payload,
        status: "ratified",
      }) === ratifiedBytes
    )) ?? null;
    if (!ratifiedSource) {
      throw new FleetReconciliationError(
        "ratified payload does not exactly select a current proposal"
      );
    }
  }

  const rejectedSources = plan.rejectIds.map((id) => {
    const proposal = proposalsById.get(id);
    if (!proposal) {
      throw new FleetReconciliationError(
        `rejectIds references proposal ${id} outside the current group`
      );
    }
    if (proposal === ratifiedSource) {
      throw new FleetReconciliationError(
        `proposal ${id} cannot be ratified and rejected by one plan`
      );
    }
    return proposal;
  });

  for (const taskId of plan.pauseTasks) {
    if (!knownTaskIds.has(taskId)) {
      throw new FleetReconciliationError(
        `pauseTasks references unknown task ${taskId}`
      );
    }
    if (settledTaskIds.has(taskId)) {
      throw new FleetReconciliationError(
        `pauseTasks references already settled task ${taskId}`
      );
    }
  }

  return {
    ratifiedSource,
    rejectedSources,
    pauseTaskIds: [...plan.pauseTasks],
  };
}

export function reconciliationDecisionMatches(
  existing: KnowledgeEnvelope,
  expected: KnowledgeEnvelope
): boolean {
  return (
    existing.id === expected.id
    && existing.runId === expected.runId
    && existing.kind === "decision"
    && existing.key === expected.key
    && existing.version === expected.version
    && canonicalReconciliationJson(existing.payload)
      === canonicalReconciliationJson(expected.payload)
  );
}

export function buildContractTransitionEnvelope(args: {
  parent: ContractProposalRecord;
  status: "ratified" | "rejected";
  payload: ContractPayload;
  decision: KnowledgeEnvelope;
}): KnowledgeEnvelope {
  const id = `contract-${digest([
    args.decision.id,
    args.parent.envelope.id,
    args.status,
  ])}`;
  return {
    id,
    runId: args.decision.runId,
    repo: args.parent.envelope.repo,
    kind: "contract",
    key: args.parent.envelope.key,
    version: args.parent.envelope.version + 1,
    authorWorkerId: null,
    parentId: args.parent.envelope.id,
    createdAt: args.decision.createdAt,
    supersededAt: null,
    payload: args.payload,
    tags: ["reconciliation", args.status],
  };
}

export function buildTaskPauseEnvelope(args: {
  taskId: string;
  current: KnowledgeEnvelope | null;
  decision: KnowledgeEnvelope;
}): KnowledgeEnvelope {
  const payload: TaskStatePayload = {
    taskId: args.taskId,
    state: "blocked",
    blockedReason: "paused by contract reconciliation",
  };
  return {
    id: `task-pause-${digest([args.decision.id, args.taskId])}`,
    runId: args.decision.runId,
    repo: null,
    kind: "task-state",
    key: args.taskId,
    version: (args.current?.version ?? 0) + 1,
    authorWorkerId: null,
    parentId: args.current?.id ?? args.decision.id,
    createdAt: args.decision.createdAt,
    supersededAt: null,
    payload,
    tags: ["reconciliation", "pause"],
  };
}

export function actionEnvelopeMatches(
  existing: KnowledgeEnvelope,
  expected: KnowledgeEnvelope
): boolean {
  return (
    existing.id === expected.id
    && existing.runId === expected.runId
    && existing.kind === expected.kind
    && existing.key === expected.key
    && existing.version === expected.version
    && existing.parentId === expected.parentId
    && canonicalReconciliationJson(existing.payload)
      === canonicalReconciliationJson(expected.payload)
  );
}
