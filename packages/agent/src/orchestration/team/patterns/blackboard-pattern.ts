/**
 * Blackboard coordination pattern.
 *
 * Participants share a workspace and iterate in rounds. On each round every
 * participant reads the workspace, produces a contribution, and writes it
 * back under its own key. The runtime supplies the workspace via
 * `TeamPatternContext.workspace`.
 *
 * Cancellation: `ctx.signal` is threaded into every participant `generate` and
 * checked at the top of both loops. An already-aborted signal rejects before
 * any participant is started. An abort mid-flight stops scheduling further
 * rounds/participants rather than burning the remaining `maxRounds` — the
 * partial workspace is discarded and the run rejects, matching the other
 * patterns' fail-loud behaviour. Because the per-participant `catch` records
 * `lastError`, participants that were already started still get a matching
 * `participant_completed` with `success=false`.
 *
 * `ctx.eventBus` is not forwarded: this pattern calls `agent.generate`
 * directly, with no sub-protocol accepting a bus and no `blackboard:*` event
 * taxonomy to emit into.
 */

import { HumanMessage } from "@langchain/core/messages";
import { omitUndefined } from "../../../utils/exact-optional.js";
import type {
  TeamPattern,
  TeamPatternContext,
  TeamPatternResult,
} from "./team-pattern.js";
import {
  DEFAULT_BLACKBOARD_CONTEXT_MAX_ENTRY_CHARS,
  DEFAULT_BLACKBOARD_CONTEXT_MAX_SERIALIZED_CHARS,
  compactText,
  formatCompactedWorkspaceContext,
  type ResolvedBlackboardContextPolicy,
} from "./pattern-utils.js";
import type { TeamPolicies } from "../team-policy.js";
import type { SharedWorkspace } from "../team-workspace.js";

const DEFAULT_MAX_ROUNDS = 3;

function resolveBlackboardContextPolicy(
  policies: TeamPolicies
): ResolvedBlackboardContextPolicy {
  const configured = policies.memory?.blackboardContext;
  const maxSerializedChars =
    configured?.maxSerializedChars ??
    DEFAULT_BLACKBOARD_CONTEXT_MAX_SERIALIZED_CHARS;
  const maxEntryChars =
    configured?.maxEntryChars ??
    Math.min(DEFAULT_BLACKBOARD_CONTEXT_MAX_ENTRY_CHARS, maxSerializedChars);
  return {
    maxSerializedChars,
    maxEntryChars,
    overflowBehavior: configured?.overflowBehavior ?? "compact",
  };
}

function prepareBlackboardContribution(
  value: string,
  policy: ResolvedBlackboardContextPolicy
): string {
  if (value.length <= policy.maxEntryChars) return value;
  if (policy.overflowBehavior === "reject") {
    throw new Error(
      `TeamRuntime[blackboard]: contribution exceeds maxEntryChars (${value.length}/${policy.maxEntryChars})`
    );
  }
  return compactText(value, policy.maxEntryChars);
}

function formatBoundedBlackboardContext(
  workspace: SharedWorkspace,
  policy: ResolvedBlackboardContextPolicy
): string {
  const fullContext = workspace.formatAsContext();
  if (fullContext.length <= policy.maxSerializedChars) return fullContext;
  if (policy.overflowBehavior === "reject") {
    throw new Error(
      `TeamRuntime[blackboard]: shared context exceeds maxSerializedChars (${fullContext.length}/${policy.maxSerializedChars})`
    );
  }
  return formatCompactedWorkspaceContext(workspace, policy);
}

export const blackboardPattern: TeamPattern = {
  id: "blackboard",

  async execute(ctx: TeamPatternContext): Promise<TeamPatternResult> {
    const startTime = ctx.startedAt;
    const spawned = ctx.participants;
    if (spawned.length === 0) {
      throw new Error("TeamRuntime[blackboard]: team has no participants");
    }
    // Fail fast before any participant is started, so an already-aborted run
    // emits no participant lifecycle events at all.
    if (ctx.signal?.aborted) {
      throw new Error("TeamRuntime[blackboard]: aborted before execution");
    }

    const workspace = ctx.workspace;
    const maxRounds = DEFAULT_MAX_ROUNDS;
    const timings = new Map<string, number>();
    const contextPolicy = resolveBlackboardContextPolicy(ctx.policies);

    await workspace.set("task", ctx.task, "__runtime__");
    await workspace.set("round", "0", "__runtime__");
    for (const s of spawned) {
      ctx.hooks.emitParticipantStart(s.participant);
      timings.set(s.spawned.agent.id, 0);
    }

    for (let round = 0; round < maxRounds; round++) {
      await workspace.set("round", String(round + 1), "__runtime__");
      for (const entry of spawned) {
        const t0 = Date.now();
        const context = formatBoundedBlackboardContext(
          workspace,
          contextPolicy
        );
        const prompt = [
          `You are participating in a collaborative blackboard session (round ${
            round + 1
          }).`,
          "",
          `## Task`,
          ctx.task,
          "",
          context,
          "",
          `Write your contribution. Focus on your role as "${entry.participant.role}".`,
          `Your output will be stored in the shared workspace under key "${entry.spawned.agent.id}".`,
        ].join("\n");

        try {
          // Stop scheduling further participants/rounds once cancelled rather
          // than burning the remaining `maxRounds` on a doomed run. Thrown
          // inside the try so `lastError` is recorded and this participant
          // still gets its `participant_completed`; re-raised after the loops.
          if (ctx.signal?.aborted) {
            throw new Error(
              "TeamRuntime[blackboard]: aborted during execution"
            );
          }
          const result = await entry.spawned.agent.generate(
            [new HumanMessage(prompt)],
            ctx.signal ? { signal: ctx.signal } : undefined
          );
          const contribution = prepareBlackboardContribution(
            result.content,
            contextPolicy
          );
          entry.spawned.lastResult = contribution;
          await workspace.set(
            entry.spawned.agent.id,
            contribution,
            entry.spawned.agent.id
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          entry.spawned.lastError = message;
        }
        timings.set(
          entry.spawned.agent.id,
          (timings.get(entry.spawned.agent.id) ?? 0) + (Date.now() - t0)
        );
        if (ctx.signal?.aborted) break;
      }
      if (ctx.signal?.aborted) break;
    }

    const durationMs = Date.now() - startTime;
    for (const s of spawned) {
      ctx.hooks.emitParticipantComplete(
        s.participant,
        s.spawned.lastError === undefined,
        timings.get(s.spawned.agent.id) ?? 0,
        s.spawned.lastError
      );
    }

    // Emit the lifecycle completions above (so no participant is left with a
    // start and no complete) and only then surface the cancellation. A
    // cancelled run must not return a partial workspace as if it succeeded.
    if (ctx.signal?.aborted) {
      throw new Error("TeamRuntime[blackboard]: aborted during execution");
    }

    return {
      content: formatBoundedBlackboardContext(workspace, contextPolicy),
      agentResults: spawned.map((s) =>
        omitUndefined({
          agentId: s.spawned.agent.id,
          role: s.spawned.role,
          content: s.spawned.lastResult ?? "",
          success: s.spawned.lastError === undefined,
          error: s.spawned.lastError,
          durationMs: timings.get(s.spawned.agent.id) ?? 0,
        })
      ),
      durationMs,
      pattern: "blackboard",
    };
  },
};
