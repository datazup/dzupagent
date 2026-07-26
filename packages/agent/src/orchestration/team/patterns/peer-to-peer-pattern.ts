/**
 * Peer-to-peer coordination pattern.
 *
 * Parallel fan-out across all resolved participants, then merge the
 * successful contributions. Concurrency is bounded by
 * `policies.execution.maxParallelParticipants` (default 5). Failures
 * are non-fatal and surface as `success=false` agent results.
 *
 * Cancellation: the fan-out runs through `runConcurrently`, the shared
 * signal-aware bounded runner, rather than the local
 * `mapSettledWithConcurrency`. It has the same allSettled shape and
 * order-preserving contract but hands each task factory a signal, which
 * `runMemberAgent` threads into `agent.generate`. An already-aborted signal
 * fails the run fast before any participant is spawned; an abort mid-flight
 * cancels in-flight generations and surfaces per-participant as
 * `success=false`, so every participant that got a `participant_started`
 * still gets a matching `participant_completed`.
 *
 * `ctx.eventBus` is not forwarded — this pattern drives `agent.generate`
 * directly with no sub-protocol that accepts a bus, and there is no
 * `peer:*` event taxonomy to emit into.
 */

import { HumanMessage } from "@langchain/core/messages";
import { concatMerge, type MergeStrategyFn } from "../../merge-strategies.js";
import { runConcurrently } from "../../concurrency-runner.js";
import { OrchestrationError } from "../../orchestration-error.js";
import type { TeamRunResult } from "../team-workspace.js";
import type {
  TeamPattern,
  TeamPatternContext,
  TeamPatternResult,
} from "./team-pattern.js";
import {
  DEFAULT_MAX_PARALLEL_PARTICIPANTS,
  runMemberAgent,
} from "./pattern-utils.js";

export const peerToPeerPattern: TeamPattern = {
  id: "peer_to_peer",

  async execute(ctx: TeamPatternContext): Promise<TeamPatternResult> {
    const startTime = ctx.startedAt;
    const spawned = ctx.participants;
    if (spawned.length === 0) {
      throw new Error("TeamRuntime[peer_to_peer]: team has no participants");
    }

    // Fail fast before any participant is started, so an already-aborted run
    // emits no participant lifecycle events at all (rather than a start with a
    // synthetic failed complete). Mirrors the supervisor/contract-net guards.
    if (ctx.signal?.aborted) {
      throw new OrchestrationError(
        "peer_to_peer aborted before execution",
        "parallel"
      );
    }

    for (const s of spawned) ctx.hooks.emitParticipantStart(s.participant);

    const merge: MergeStrategyFn = concatMerge;
    const results: TeamRunResult["agentResults"] = [];
    const concurrency =
      ctx.policies.execution?.maxParallelParticipants ??
      DEFAULT_MAX_PARALLEL_PARTICIPANTS;

    const settled = await runConcurrently(
      spawned.map((entry) => async (signal?: AbortSignal) => {
        const t0 = Date.now();
        const res = await runMemberAgent(
          entry.spawned.agent,
          [new HumanMessage(ctx.task)],
          ctx.policies.execution,
          signal
        );
        return {
          agentId: entry.spawned.agent.id,
          role: entry.spawned.role,
          content: res.content,
          durationMs: Date.now() - t0,
        };
      }),
      concurrency,
      ctx.signal ? { signal: ctx.signal } : undefined
    );

    const successContents: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      const entry = spawned[i]!;
      if (outcome.status === "fulfilled") {
        results.push({ ...outcome.value, success: true });
        successContents.push(outcome.value.content);
        ctx.hooks.emitParticipantComplete(
          entry.participant,
          true,
          outcome.value.durationMs
        );
      } else {
        const msg =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        results.push({
          agentId: entry.spawned.agent.id,
          role: entry.spawned.role,
          content: "",
          success: false,
          error: msg,
          durationMs: 0,
        });
        ctx.hooks.emitParticipantComplete(entry.participant, false, 0, msg);
      }
    }

    const merged =
      successContents.length > 0 ? await merge(successContents) : "";

    return {
      content: merged,
      agentResults: results,
      durationMs: Date.now() - startTime,
      pattern: "peer-to-peer",
    };
  },
};
