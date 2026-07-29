/**
 * Post-run memory consolidation helper for `TeamRuntime`.
 *
 * Hosts can wire a custom `consolidate` callback or a `ConsolidationStore`
 * directly; this helper picks the right path, tolerates failures (memory
 * consolidation must never abort a successful run), and emits the
 * `team_consolidation_completed` lifecycle event on success.
 */

import {
  ConsolidationEngine,
  type ConsolidationStore,
} from "@dzupagent/memory";
import type { TeamPolicies } from "./team-policy.js";
import type { TeamRuntimeEventEmitter } from "./team-runtime-events.js";

/** Service port for post-run consolidation — see `TeamRuntimeOptions.memory`. */
export interface TeamRuntimeMemoryService {
  consolidate?(teamId: string, namespace: string): Promise<void>;
  /** Optional backing store; the runtime uses `ConsolidationEngine` if set. */
  store?: ConsolidationStore;
}

export interface ConsolidationContext {
  teamId: string;
  runId: string;
  policies: TeamPolicies;
  memory: TeamRuntimeMemoryService | undefined;
  emitEvent: TeamRuntimeEventEmitter;
}

/**
 * Run the consolidation pass when both the policy enables it and a memory
 * service is configured. Failures are swallowed because consolidation is a
 * non-critical post-run cleanup step.
 *
 * Swallowed does NOT mean unreported. When the policy declares consolidation
 * but it does not complete — either because no service is wired or because a
 * wired service threw — the runtime emits `team_consolidation_skipped` with the
 * reason. This mirrors the `skipped` verdict-gate signal: a declared-but-
 * unperformed step must not be indistinguishable from a performed one. Run
 * outcomes are unchanged; only the reporting is.
 */
export async function consolidateIfEnabled(
  ctx: ConsolidationContext
): Promise<void> {
  const { policies, memory } = ctx;
  if (policies.memory?.consolidateOnComplete !== true) return;

  const namespace = ctx.teamId;

  // Declared but unwired: nothing can run. Announce it rather than returning
  // silently — a host that wrote `consolidateOnComplete: true` and forgot to
  // inject a memory service would otherwise see identical clean runs forever.
  if (!memory?.consolidate && !memory?.store) {
    emitSkipped(ctx, namespace, "unwired");
    return;
  }

  try {
    if (memory.consolidate) {
      await memory.consolidate(ctx.teamId, namespace);
    } else if (memory.store) {
      await new ConsolidationEngine().consolidate(
        ctx.teamId,
        namespace,
        memory.store
      );
    }
    ctx.emitEvent({
      type: "team_consolidation_completed",
      teamId: ctx.teamId,
      runId: ctx.runId,
      namespace,
      at: new Date(),
    });
  } catch (err: unknown) {
    // Consolidation is non-fatal — never abort the run on failure. But a store
    // that throws on every run is a real outage, so report it instead of
    // discarding the error entirely (the original behaviour).
    emitSkipped(
      ctx,
      namespace,
      "failed",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Report a declared consolidation pass that did not complete.
 *
 * Emitting must never itself abort the run: this helper is called from the
 * catch block of a step whose whole contract is to be non-fatal, so a throwing
 * observer would convert a swallowed consolidation failure into a failed run —
 * exactly the outcome the swallow exists to prevent.
 */
function emitSkipped(
  ctx: ConsolidationContext,
  namespace: string,
  reason: "unwired" | "failed",
  error?: string
): void {
  try {
    ctx.emitEvent({
      type: "team_consolidation_skipped",
      teamId: ctx.teamId,
      runId: ctx.runId,
      namespace,
      reason,
      ...(error === undefined ? {} : { error }),
      at: new Date(),
    });
  } catch {
    // A misbehaving observer must not fail the run.
  }
}
