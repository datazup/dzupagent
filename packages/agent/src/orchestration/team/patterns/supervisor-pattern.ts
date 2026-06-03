/**
 * Supervisor coordination pattern.
 *
 * A manager agent delegates to specialists via `AgentOrchestrator.supervisor`.
 * The participant whose role is `supervisor` is selected as the manager (or
 * the first participant when no role matches); the remaining participants
 * are exposed to the manager as tools.
 */

import { AgentOrchestrator } from "../../orchestrator.js";
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
    for (const s of specialists) ctx.hooks.emitParticipantStart(s.participant);

    try {
      const result = await AgentOrchestrator.supervisor({
        manager: managerEntry.spawned.agent,
        specialists: specialists.map((s) => s.spawned.agent),
        task: ctx.task,
      });

      const durationMs = Date.now() - startTime;
      ctx.hooks.emitParticipantComplete(
        managerEntry.participant,
        true,
        durationMs
      );
      for (const s of specialists) {
        ctx.hooks.emitParticipantComplete(s.participant, true, durationMs);
      }

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
          ...specialists.map((s) => ({
            agentId: s.spawned.agent.id,
            role: s.spawned.role,
            content: "",
            success: true,
            durationMs,
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      ctx.hooks.emitParticipantComplete(
        managerEntry.participant,
        false,
        durationMs,
        message
      );
      for (const s of specialists) {
        ctx.hooks.emitParticipantComplete(
          s.participant,
          false,
          durationMs,
          message
        );
      }
      throw err;
    }
  },
};
