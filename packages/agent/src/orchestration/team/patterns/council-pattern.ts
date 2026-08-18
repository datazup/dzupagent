/**
 * Council coordination pattern.
 *
 * Proposers contribute candidate answers; a designated judge picks the
 * best one. Delegates to `AgentOrchestrator.debateDetailed`. The judge is selected
 * by matching `policies.governance.judgeModel` against participant
 * `model` fields (falling back to the first participant when no match).
 *
 * `ctx.signal` rides on `debateDetailed`'s options bag. The invocation observer
 * translates real model starts and settled outcomes into participant lifecycle
 * evidence without retaining prompts, messages, or provider data.
 *
 * This keeps a team-run council cancellable: an already-aborted signal rejects
 * before any proposer runs, and an abort mid-flight cancels the in-flight
 * proposer/judge generations. On rejection, only outcomes already observed as
 * terminal are completed; pending and never-started work is omitted.
 *
 * `ctx.eventBus` is deliberately NOT forwarded — `debate` accepts no bus and
 * there is no `council:*`/`debate:*` event taxonomy to emit into. See the
 * pattern report rather than inventing one here.
 */

import { AgentOrchestrator } from "../../orchestrator.js";
import type { DebateInvocationOutcome } from "../../debate-types.js";
import type {
  ResolvedParticipant,
  TeamPattern,
  TeamPatternContext,
  TeamPatternResult,
} from "./team-pattern.js";
import { runSingleParticipant } from "./pattern-utils.js";

/** Default model used when no `governance.judgeModel` policy is set. */
export const DEFAULT_GOVERNANCE_MODEL = "claude-opus-4-7";

interface AggregatedCouncilResult {
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

function aggregateInvocations(
  outcomes: readonly DebateInvocationOutcome[],
  participantByAgentId: ReadonlyMap<string, ResolvedParticipant>
): AggregatedCouncilResult[] {
  const aggregated = new Map<string, AggregatedCouncilResult>();
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
  results: readonly AggregatedCouncilResult[],
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

export const councilPattern: TeamPattern = {
  id: "council",

  async execute(ctx: TeamPatternContext): Promise<TeamPatternResult> {
    const startTime = ctx.startedAt;
    const spawned = ctx.participants;
    if (spawned.length === 0) {
      throw new Error("TeamRuntime[council]: team has no participants");
    }

    // Pick a judge: prefer a participant whose model matches governance.judgeModel,
    // fall back to the first participant. Proposers are the remaining participants.
    const judgeModel =
      ctx.policies.governance?.judgeModel ?? DEFAULT_GOVERNANCE_MODEL;
    if (ctx.policies.governance?.judgeModel !== undefined) {
      ctx.hooks.emitPolicyApplied("governance", "judgeModel");
    }
    const judgeEntry =
      spawned.find((s) => s.participant.model === judgeModel) ?? spawned[0]!;
    const proposers = spawned.filter((s) => s !== judgeEntry);

    if (proposers.length === 0) {
      return runSingleParticipant(judgeEntry, ctx.task, startTime);
    }

    const participantByAgentId = new Map(
      spawned.map((entry) => [entry.spawned.agent.id, entry] as const)
    );
    const observedOutcomes: DebateInvocationOutcome[] = [];
    const invocationObserver = {
      onStart: ({ agentId }: { agentId: string }) => {
        const entry = participantByAgentId.get(agentId);
        if (entry) ctx.hooks.emitParticipantStart(entry.participant);
      },
      onComplete: (outcome: DebateInvocationOutcome) => {
        observedOutcomes.push(outcome);
      },
    };

    try {
      const result = await AgentOrchestrator.debateDetailed(
        proposers.map((p) => p.spawned.agent),
        judgeEntry.spawned.agent,
        ctx.task,
        {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          invocationObserver,
        }
      );

      const durationMs = Date.now() - startTime;
      const participantResults = aggregateInvocations(
        result.invocations,
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
        content: result.content,
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
        pattern: "council",
      };
    } catch (err: unknown) {
      emitParticipantCompletions(
        aggregateInvocations(observedOutcomes, participantByAgentId),
        ctx
      );
      throw err;
    }
  },
};
