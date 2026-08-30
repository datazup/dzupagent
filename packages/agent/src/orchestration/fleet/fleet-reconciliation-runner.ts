/**
 * Supervisor-side contract reconciliation for a fleet run.
 *
 * Reconciles proposed contract envelopes that appeared since the last safe run
 * boundary: it first replays any decision already recorded in the knowledge
 * store (closing the decision-written/action-partial crash window), then groups
 * the remaining unresolved proposals by surface and asks the policy for a plan.
 * Decision and action envelopes are deterministic, so re-running over a
 * partially applied plan converges instead of duplicating work.
 *
 * Split out of `fleet-supervisor.ts`, which keeps run lifecycle, dispatch and
 * budget enforcement. The pure envelope-identity and plan-validation helpers
 * this builds on live in `fleet-reconciliation.ts`.
 *
 * @module orchestration/fleet/fleet-reconciliation-runner
 */
import { isContractPayload } from "@dzupagent/agent-types/fleet";
import type {
  DecisionPayload,
  FleetPolicy,
  KnowledgeEnvelope,
  KnowledgeStore,
  ReconciliationPlan,
  RepoAgentRef,
  RepoRef,
  TaskStatePayload,
} from "@dzupagent/agent-types/fleet";
import type { RepoAgent } from "./repo-agent.js";
import {
  FleetReconciliationError,
  actionEnvelopeMatches,
  buildContractTransitionEnvelope,
  buildReconciliationDecisionEnvelope,
  buildTaskPauseEnvelope,
  canonicalReconciliationJson,
  parseReconciliationDecision,
  reconciliationDecisionMatches,
  validateReconciliationPlan,
  type ContractProposalRecord,
  type ValidatedReconciliationPlan,
} from "./fleet-reconciliation.js";

/** One repo agent enrolled in the active run. */
export interface RepoAgentSlot {
  agent: RepoAgent;
  repo: RepoRef;
  ref: RepoAgentRef;
}

/** Cross-pass reconciliation bookkeeping retained for the life of one run. */
export interface ReconciliationRunState {
  observedContractIds: Set<string>;
  observedDecisionIds: Set<string>;
  pausedTaskIds: Set<string>;
  settledTaskIds: Set<string>;
  knownTaskIds: Set<string>;
}

/**
 * Supervisor capabilities the reconciliation pass needs. Escalation is narrowed
 * to the one case this module raises — a contract conflict — so the runner
 * cannot reach the supervisor's other decision kinds.
 */
export interface ReconciliationRunnerDeps {
  knowledge: KnowledgeStore;
  /** Returns true when the policy handed the conflict off to a human. */
  escalateContractConflict: (
    runId: string,
    policy: FleetPolicy,
    extraInputs: unknown[]
  ) => Promise<boolean>;
}

/**
 * Reconciles proposed contract envelopes that have appeared since the last
 * safe run boundary. Query order determines both surface and proposal order.
 * Deterministic decision and action envelopes make completed work replay-safe
 * and resume a partially applied plan before any new policy callback.
 */
export async function runContractReconciliation(
  rd: ReconciliationRunnerDeps,
  runId: string,
  policy: FleetPolicy,
  repoAgents: Map<string, RepoAgentSlot>,
  state: ReconciliationRunState
): Promise<boolean> {
  const scope = `run:${runId}`;
  const entries: KnowledgeEnvelope[] = [];
  for await (const entry of rd.knowledge.query({ scope })) {
    entries.push(entry);
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const resolvedProposalIds = new Set<string>();
  for (const entry of entries) {
    if (
      entry.kind === "contract"
      && isContractPayload(entry.payload)
      && entry.payload.status !== "proposed"
      && entry.parentId !== null
    ) {
      resolvedProposalIds.add(entry.parentId);
    }
  }

  // Resume already-recorded decisions before looking for new proposal
  // groups. This closes the decision-written/action-partial crash window.
  for (const entry of entries) {
    const replay = parseReconciliationDecision(entry);
    if (!replay) continue;
    if (entry.runId !== runId) {
      throw new FleetReconciliationError(
        `decision ${entry.id} belongs to run ${entry.runId}, not ${runId}`
      );
    }
    for (const proposalId of replay.proposalIds) {
      resolvedProposalIds.add(proposalId);
    }
    if (state.observedDecisionIds.has(entry.id)) continue;

    const decisionPayload = entry.payload as DecisionPayload;
    if (decisionPayload.policyId !== policy.id) {
      throw new FleetReconciliationError(
        `decision ${entry.id} belongs to policy ${decisionPayload.policyId}, not ${policy.id}`
      );
    }
    const expectedDecision = buildReconciliationDecisionEnvelope({
      runId,
      surface: replay.surface,
      proposalIds: replay.proposalIds,
      policyId: policy.id,
      plan: replay.plan,
      createdAt: entry.createdAt,
    });
    if (!reconciliationDecisionMatches(entry, expectedDecision)) {
      throw new FleetReconciliationError(
        `decision ${entry.id} does not match its deterministic identity`
      );
    }
    const proposals = replay.proposalIds.map((proposalId) => {
      const proposal = entriesById.get(proposalId);
      if (
        !proposal
        || proposal.kind !== "contract"
        || proposal.runId !== runId
        || !isContractPayload(proposal.payload)
        || proposal.payload.status !== "proposed"
        || proposal.payload.surface !== replay.surface
      ) {
        throw new FleetReconciliationError(
          `decision ${entry.id} references invalid proposal ${proposalId}`
        );
      }
      return { envelope: proposal, payload: proposal.payload };
    });
    const validated = validateReconciliationPlan({
      surface: replay.surface,
      proposals,
      plan: replay.plan,
      knownTaskIds: state.knownTaskIds,
      settledTaskIds: state.settledTaskIds,
    });
    await applyReconciliationPlan(
  rd,
      scope,
      entry,
      replay.plan,
      validated,
      state.pausedTaskIds
    );
    state.observedDecisionIds.add(entry.id);

    if (replay.plan.escalate) {
      const escalationInputs = [
        "contract-conflict",
        "reconciliation",
        replay.surface,
        ...replay.proposalIds,
      ];
      const priorEscalation = entries.find((candidate) => {
        if (candidate.kind !== "decision") return false;
        const payload = candidate.payload as DecisionPayload;
        return (
          payload.decisionKind === "escalation"
          && canonicalReconciliationJson(payload.inputs)
            === canonicalReconciliationJson(escalationInputs)
        );
      });
      if (priorEscalation) {
        const outcome = (priorEscalation.payload as DecisionPayload).outcome;
        if (
          outcome !== null
          && typeof outcome === "object"
          && (outcome as { kind?: unknown }).kind === "human-handoff"
        ) {
          return true;
        }
      } else {
        const handedOff = await rd.escalateContractConflict(runId, policy, ["reconciliation", replay.surface, ...replay.proposalIds]);
        if (handedOff) return true;
      }
    }
  }

  const groups = new Map<
    string,
    { records: ContractProposalRecord[]; envelopeIds: string[] }
  >();

  for (const entry of entries) {
    if (state.observedContractIds.has(entry.id)) continue;
    state.observedContractIds.add(entry.id);
    if (
      entry.kind !== "contract" ||
      entry.runId !== runId ||
      !isContractPayload(entry.payload) ||
      entry.payload.status !== "proposed" ||
      resolvedProposalIds.has(entry.id)
    ) {
      continue;
    }

    const group = groups.get(entry.payload.surface);
    if (group) {
      group.records.push({ envelope: entry, payload: entry.payload });
      group.envelopeIds.push(entry.id);
    } else {
      groups.set(entry.payload.surface, {
        records: [{ envelope: entry, payload: entry.payload }],
        envelopeIds: [entry.id],
      });
    }
  }

  for (const [surface, group] of groups) {
    const fleet = [...repoAgents.values()].map((slot) => slot.ref);
    const plan = await policy.onContractChange(
      {
        surface,
        proposalIds: [...group.envelopeIds],
        proposals: group.records.map((record) => record.payload),
      },
      fleet
    );
    const validated = validateReconciliationPlan({
      surface,
      proposals: group.records,
      plan,
      knownTaskIds: state.knownTaskIds,
      settledTaskIds: state.settledTaskIds,
    });
    const decision = await writeReconciliationDecision(
  rd,
      runId,
      policy.id,
      surface,
      group.envelopeIds,
      plan,
    );
    state.observedDecisionIds.add(decision.id);
    await applyReconciliationPlan(
  rd,
      scope,
      decision,
      plan,
      validated,
      state.pausedTaskIds
    );

    if (plan.escalate) {
      const handedOff = await rd.escalateContractConflict(runId, policy, ["reconciliation", surface, ...group.envelopeIds]);
      if (handedOff) return true;
    }
  }

  return false;
}

async function writeReconciliationDecision(
  rd: ReconciliationRunnerDeps,
  runId: string,
  policyId: string,
  surface: string,
  proposalIds: string[],
  plan: ReconciliationPlan
): Promise<KnowledgeEnvelope> {
  const scope = `run:${runId}`;
  const expected = buildReconciliationDecisionEnvelope({
    runId,
    surface,
    proposalIds: [...proposalIds],
    policyId,
    plan,
    createdAt: new Date().toISOString(),
  });
  const existing = await rd.knowledge.read(
    scope,
    "decision",
    expected.key
  );
  if (existing) {
    if (!reconciliationDecisionMatches(existing, expected)) {
      throw new FleetReconciliationError(
        `decision identity ${expected.id} already contains different bytes`
      );
    }
    return existing;
  }
  await rd.knowledge.append(scope, expected);
  return expected;
}

async function applyReconciliationPlan(
  rd: ReconciliationRunnerDeps,
  scope: string,
  decision: KnowledgeEnvelope,
  plan: ReconciliationPlan,
  validated: ValidatedReconciliationPlan,
  pausedTaskIds: Set<string>
): Promise<void> {
  if (validated.ratifiedSource) {
    const expected = buildContractTransitionEnvelope({
      parent: validated.ratifiedSource,
      status: "ratified",
      payload: plan.ratified!,
      decision,
    });
    await appendReconciliationAction(rd, scope, expected, validated.ratifiedSource.envelope);
  }

  for (const rejected of validated.rejectedSources) {
    const expected = buildContractTransitionEnvelope({
      parent: rejected,
      status: "rejected",
      payload: { ...rejected.payload, status: "rejected" },
      decision,
    });
    await appendReconciliationAction(rd, scope, expected, rejected.envelope);
  }

  for (const taskId of validated.pauseTaskIds) {
    const current = await rd.knowledge.read(
      scope,
      "task-state",
      taskId
    );
    const identityProbe = buildTaskPauseEnvelope({
      taskId,
      current: null,
      decision,
    });
    if (
      current
      && current.id === identityProbe.id
      && canonicalReconciliationJson(current.payload)
        === canonicalReconciliationJson(identityProbe.payload)
    ) {
      pausedTaskIds.add(taskId);
      continue;
    }
    if (current) {
      const payload = current.payload as TaskStatePayload;
      if (payload.state !== "queued") {
        throw new FleetReconciliationError(
          `queued-only pause cannot replace task ${taskId} state ${payload.state}`
        );
      }
    }
    const expected = buildTaskPauseEnvelope({ taskId, current, decision });
    await rd.knowledge.append(scope, expected);
    pausedTaskIds.add(taskId);
  }
}

async function appendReconciliationAction(
  rd: ReconciliationRunnerDeps,
  scope: string,
  expected: KnowledgeEnvelope,
  parent: KnowledgeEnvelope
): Promise<void> {
  const current = await rd.knowledge.read(
    scope,
    expected.kind,
    expected.key
  );
  if (current && actionEnvelopeMatches(current, expected)) return;
  if (current && current.id !== parent.id) {
    throw new FleetReconciliationError(
      `action ${expected.id} conflicts with current ${expected.kind}/${expected.key}@${current.version}`
    );
  }
  await rd.knowledge.append(scope, expected);
}
