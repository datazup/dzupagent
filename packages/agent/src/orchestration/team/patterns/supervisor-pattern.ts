/**
 * Supervisor coordination pattern.
 *
 * A manager agent delegates to specialists via `AgentOrchestrator.supervisor`.
 * The participant whose role is `supervisor` is selected as the manager (or
 * the first participant when no role matches); the remaining participants
 * are exposed to the manager as tools.
 *
 * `ctx.signal` / `ctx.eventBus` are forwarded onto `SupervisorConfig`, which
 * already declares both. That makes a team-run supervision cancellable (the
 * runner fails fast on an already-aborted signal and threads it into every
 * `generate`) and lets it emit the same routing diagnostics a direct
 * `AgentOrchestrator.supervisor` call does.
 */

import { AgentOrchestrator } from "../../orchestrator.js";
import type { SpecialistInvocationOutcome } from "../../supervisor-types.js";
import { omitUndefined } from "../../../utils/exact-optional.js";
import type {
  TeamPattern,
  TeamPatternContext,
  TeamPatternResult,
} from "./team-pattern.js";
import { runSingleParticipant } from "./pattern-utils.js";

export const supervisorPattern: TeamPattern = {
  id: "supervisor",

  async execute(ctx: TeamPatternContext): Promise<TeamPatternResult> {
    const startTime = ctx.startedAt;
    const spawned = ctx.participants;
    const managerEntry =
      spawned.find((s) => s.participant.role === "supervisor") ?? spawned[0];
    if (!managerEntry) {
      throw new Error("TeamRuntime[supervisor]: team has no participants");
    }
    const specialists = spawned.filter((s) => s !== managerEntry);

    if (specialists.length === 0) {
      return runSingleParticipant(managerEntry, ctx.task, startTime);
    }

    ctx.hooks.emitParticipantStart(managerEntry.participant);
    const specialistById = new Map(
      specialists.map((entry) => [entry.spawned.agent.id, entry] as const)
    );
    const invocationOutcomes: SpecialistInvocationOutcome[] = [];
    const invocationObserver = {
      onStart: ({ specialistId }: { specialistId: string }) => {
        const entry = specialistById.get(specialistId);
        if (entry) ctx.hooks.emitParticipantStart(entry.participant);
      },
      onComplete: (outcome: SpecialistInvocationOutcome) => {
        invocationOutcomes.push(outcome);
      },
    };

    let result;
    try {
      // `omitUndefined` keeps unset runtime plumbing genuinely absent, so a run
      // with neither signal nor bus produces exactly the three-field config
      // this call used before.
      result = await AgentOrchestrator.supervisor(
        omitUndefined({
          manager: managerEntry.spawned.agent,
          specialists: specialists.map((s) => s.spawned.agent),
          task: ctx.task,
          signal: ctx.signal,
          eventBus: ctx.eventBus,
          invocationObserver,
        })
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      ctx.hooks.emitParticipantComplete(
        managerEntry.participant,
        false,
        durationMs,
        message
      );
      emitSpecialistCompletions(
        aggregateInvocations(invocationOutcomes, specialistById),
        ctx
      );
      throw err;
    }

    const durationMs = Date.now() - startTime;
    const specialistResults = aggregateInvocations(
      invocationOutcomes,
      specialistById
    );
    ctx.hooks.emitParticipantComplete(
      managerEntry.participant,
      true,
      durationMs
    );
    emitSpecialistCompletions(specialistResults, ctx);

    return {
      content: result.content,
      agentResults: [
        {
          agentId: managerEntry.spawned.agent.id,
          role: managerEntry.spawned.role,
          content: result.content,
          success: true,
          durationMs,
        },
        ...specialistResults.map(({ entry, success, durationMs, error }) => ({
          agentId: entry.spawned.agent.id,
          role: entry.spawned.role,
          content: "",
          success,
          durationMs,
          ...(error !== undefined ? { error } : {}),
        })),
      ],
      durationMs,
      pattern: "supervisor" as const,
      // Surface the routing decision on the run record when a routing policy
      // narrowed specialist selection (W7 routing-decision tracing). Omitted
      // for direct selection so the field stays absent rather than undefined.
      ...(result.routingDecisionId !== undefined
        ? { routingDecisionId: result.routingDecisionId }
        : {}),
    };
  },
};

type SpecialistEntry = TeamPatternContext["participants"][number];

interface AggregatedSpecialistResult {
  entry: SpecialistEntry;
  success: boolean;
  durationMs: number;
  error?: string;
}

function aggregateInvocations(
  outcomes: SpecialistInvocationOutcome[],
  specialistById: ReadonlyMap<string, SpecialistEntry>
): AggregatedSpecialistResult[] {
  const aggregated = new Map<string, AggregatedSpecialistResult>();
  for (const outcome of outcomes.toSorted(
    (a, b) => a.invocationIndex - b.invocationIndex
  )) {
    const entry = specialistById.get(outcome.specialistId);
    if (!entry) continue;
    const current = aggregated.get(outcome.specialistId);
    if (!current) {
      aggregated.set(outcome.specialistId, {
        entry,
        success: outcome.success,
        durationMs: outcome.durationMs,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      });
      continue;
    }

    current.durationMs += outcome.durationMs;
    if (!outcome.success) {
      current.success = false;
      if (current.error === undefined && outcome.error !== undefined) {
        current.error = outcome.error;
      }
    }
  }
  return [...aggregated.values()];
}

function emitSpecialistCompletions(
  results: AggregatedSpecialistResult[],
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
