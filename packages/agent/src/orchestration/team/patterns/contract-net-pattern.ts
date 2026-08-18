/**
 * Contract-net coordination pattern.
 *
 * Specialists bid on a CFP, the configured award strategy selects a winner,
 * and the winner executes. Delegates to `ContractNetManager.executeDetailed`
 * so team lifecycle evidence reflects actual bid/execution model calls.
 *
 * The negotiation is configured from two places, split by whether the knob is
 * expressible as data:
 *   - `policies.contractNet` — declarative (`maxCostCents`,
 *     `requiredCapabilities`, `bidDeadlineMs`, `retryOnNoBids`), validated and
 *     scoped to this pattern by `validateTeamPolicies`.
 *   - `ctx.signal` / `ctx.eventBus` / `ctx.contractNet.strategy` — live objects
 *     forwarded from `TeamRuntimeOptions`, so a team-run negotiation is
 *     cancellable and emits `contractnet:*` events like a direct manager call.
 *
 * Every field is optional; supplying none reproduces the pre-policy behaviour
 * exactly.
 */

import { ContractNetManager } from "../../contract-net/contract-net-manager.js";
import type { ContractNetInvocationOutcome } from "../../contract-net/contract-net-types.js";
import { omitUndefined } from "../../../utils/exact-optional.js";
import type {
  ResolvedParticipant,
  TeamPattern,
  TeamPatternContext,
  TeamPatternResult,
} from "./team-pattern.js";
import { runSingleParticipant } from "./pattern-utils.js";

interface AggregatedContractNetResult {
  entry: ResolvedParticipant;
  success: boolean;
  durationMs: number;
  content: string;
  error?: string;
}

function addFiniteDuration(total: number, next: number): number {
  const finiteNext = Number.isFinite(next) && next >= 0 ? next : 0;
  const sum = total + finiteNext;
  return Number.isFinite(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

function assertUniqueSpawnedAgentIds(
  entries: readonly ResolvedParticipant[]
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const agentId = entry.spawned.agent.id;
    if (seen.has(agentId)) {
      throw new Error(
        `TeamRuntime[contract_net]: duplicate spawned agent id "${agentId}"`
      );
    }
    seen.add(agentId);
  }
}

function aggregateInvocations(
  outcomes: readonly ContractNetInvocationOutcome[],
  participantByAgentId: ReadonlyMap<string, ResolvedParticipant>
): AggregatedContractNetResult[] {
  const aggregated = new Map<string, AggregatedContractNetResult>();
  for (const outcome of outcomes.toSorted(
    (left, right) => left.invocationIndex - right.invocationIndex
  )) {
    const entry = participantByAgentId.get(outcome.agentId);
    if (!entry) continue;
    const current = aggregated.get(outcome.agentId);
    if (!current) {
      aggregated.set(outcome.agentId, {
        entry,
        success: outcome.success,
        durationMs: addFiniteDuration(0, outcome.durationMs),
        content: outcome.content ?? "",
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      });
      continue;
    }

    current.durationMs = addFiniteDuration(
      current.durationMs,
      outcome.durationMs
    );
    if (outcome.success && outcome.content !== undefined) {
      current.content = outcome.content;
    }
    if (!outcome.success) {
      current.success = false;
      if (current.error === undefined && outcome.error !== undefined) {
        current.error = outcome.error;
      }
    }
  }
  return [...aggregated.values()];
}

function emitParticipantCompletions(
  results: readonly AggregatedContractNetResult[],
  ctx: TeamPatternContext
): void {
  for (const result of results) {
    ctx.hooks.emitParticipantComplete(
      result.entry.participant,
      result.success,
      result.durationMs,
      result.error
    );
  }
}

export const contractNetPattern: TeamPattern = {
  id: "contract_net",

  async execute(ctx: TeamPatternContext): Promise<TeamPatternResult> {
    const startTime = ctx.startedAt;
    const spawned = ctx.participants;
    const managerEntry =
      spawned.find((s) => s.participant.role === "supervisor") ?? spawned[0];
    if (!managerEntry) {
      throw new Error("TeamRuntime[contract_net]: team has no participants");
    }
    const specialists = spawned.filter((s) => s !== managerEntry);
    if (specialists.length === 0) {
      return runSingleParticipant(managerEntry, ctx.task, startTime);
    }

    assertUniqueSpawnedAgentIds(spawned);
    const participantByAgentId = new Map(
      specialists.map((entry) => [entry.spawned.agent.id, entry] as const)
    );
    const startedParticipants = new Set<string>();
    const observedOutcomes: ContractNetInvocationOutcome[] = [];
    const invocationObserver = {
      onStart: ({ agentId }: { agentId: string }) => {
        const entry = participantByAgentId.get(agentId);
        if (!entry || startedParticipants.has(agentId)) return;
        startedParticipants.add(agentId);
        ctx.hooks.emitParticipantStart(entry.participant);
      },
      onComplete: (outcome: ContractNetInvocationOutcome) => {
        observedOutcomes.push(outcome);
      },
    };

    // Thread the full ContractNetConfig surface the manager supports.
    //
    // Declarative knobs come from `policies.contractNet` (validated + scoped to
    // this pattern by `validateTeamPolicies`); `signal` / `eventBus` /
    // `strategy` are runtime plumbing carried on the context rather than
    // policy. `omitUndefined` keeps an unset field genuinely absent so the
    // manager falls back to its own defaults — a run with no contract-net
    // policy and no runtime plumbing produces exactly the two-field config
    // this call used before.
    const policy = ctx.policies.contractNet;
    try {
      const detailed = await ContractNetManager.executeDetailed(
        omitUndefined({
          specialists: specialists.map((s) => s.spawned.agent),
          task: ctx.task,
          maxCostCents: policy?.maxCostCents,
          requiredCapabilities: policy?.requiredCapabilities,
          bidDeadlineMs: policy?.bidDeadlineMs,
          retryOnNoBids: policy?.retryOnNoBids,
          strategy: ctx.contractNet?.strategy,
          signal: ctx.signal,
          eventBus: ctx.eventBus,
          invocationObserver,
        })
      );

      const durationMs = Date.now() - startTime;
      const participantResults = aggregateInvocations(
        detailed.invocations,
        participantByAgentId
      );
      emitParticipantCompletions(participantResults, ctx);
      const resultByEntry = new Map(
        participantResults.map((participantResult) => [
          participantResult.entry,
          participantResult,
        ])
      );

      return {
        content: detailed.result.result ?? "",
        agentResults: spawned.flatMap((entry) => {
          const participantResult = resultByEntry.get(entry);
          if (!participantResult) return [];
          return [
            {
              agentId: entry.spawned.agent.id,
              role: entry.spawned.role,
              content: participantResult.content,
              success: participantResult.success,
              durationMs: participantResult.durationMs,
              ...(participantResult.error !== undefined
                ? { error: participantResult.error }
                : {}),
            },
          ];
        }),
        durationMs,
        pattern: "contract-net",
      };
    } catch (error: unknown) {
      emitParticipantCompletions(
        aggregateInvocations(observedOutcomes, participantByAgentId),
        ctx
      );
      throw error;
    }
  },
};
