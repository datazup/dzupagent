/**
 * Lifecycle event types emitted by `TeamRuntime`.
 *
 * Extracted from `team-runtime.ts` so the dispatcher class stays focused
 * on orchestration. Consumers continue to import these via
 * `team-runtime.ts` for backwards compatibility.
 */

import type { CoordinatorPattern } from "./team-definition.js";
import type { TeamPhase } from "./team-phase.js";

/** Lifecycle events emitted by `TeamRuntime.execute`. */
export type TeamRuntimeEvent =
  | {
      type: "phase_changed";
      teamId: string;
      runId: string;
      from: TeamPhase;
      to: TeamPhase;
      at: Date;
    }
  | {
      type: "participant_started";
      teamId: string;
      runId: string;
      participantId: string;
      role: string;
      at: Date;
    }
  | {
      type: "participant_completed";
      teamId: string;
      runId: string;
      participantId: string;
      role: string;
      success: boolean;
      error?: string;
      durationMs: number;
      at: Date;
    }
  | {
      type: "team_completed";
      teamId: string;
      runId: string;
      durationMs: number;
      at: Date;
    }
  | {
      type: "team_failed";
      teamId: string;
      runId: string;
      error: string;
      at: Date;
    }
  | {
      type: "policy_applied";
      teamId: string;
      runId: string;
      policyGroup: "governance";
      policyField: "judgeModel";
      coordinatorPattern: CoordinatorPattern;
      at: Date;
    }
  | {
      type: "team_consolidation_completed";
      teamId: string;
      runId: string;
      namespace: string;
      at: Date;
    }
  | {
      /**
       * A post-run memory consolidation pass was DECLARED
       * (`memory.consolidateOnComplete: true`) but did not complete.
       *
       * Emitted for the same reason as `team_verdict_evaluated` with
       * `outcome: 'skipped'`: without it, "consolidation ran" and
       * "consolidation never happened" are indistinguishable from the outside,
       * because the success path emits `team_consolidation_completed` and both
       * failure paths previously emitted nothing at all.
       *
       * The two reasons are kept distinct because they need different
       * responses:
       *
       * - `unwired` — the policy asked for consolidation but no
       *   `TeamRuntimeMemoryService` was injected, so nothing could run. This is
       *   a deployment/wiring mistake, and is expected in tests and in any
       *   environment where the team is declared before its store exists.
       * - `failed` — a service WAS wired and threw. This is the more dangerous
       *   case and the reason this event exists at all: a store that rejects on
       *   every run (bad credentials, wrong namespace, disk full) would
       *   otherwise be completely invisible, since the failure is deliberately
       *   swallowed to keep consolidation non-fatal.
       *
       * Run outcomes are unchanged in both cases — consolidation remains a
       * non-critical post-run step. This event is reporting only.
       */
      type: "team_consolidation_skipped";
      teamId: string;
      runId: string;
      namespace: string;
      reason: "unwired" | "failed";
      /**
       * Failure message when `reason: 'failed'`. Absent for `unwired`, where
       * nothing ran and so there is no error to report.
       */
      error?: string;
      at: Date;
    }
  | {
      /**
       * A governance / evaluation acceptance gate was reached on a completed
       * run. `outcome: 'rejected'` is immediately followed by a `team_failed`
       * event.
       *
       * `outcome: 'skipped'` means the policy DECLARED a threshold but the gate
       * could not be applied, so the run passed ungated. This is emitted
       * precisely because that case is otherwise indistinguishable from "the
       * gate ran and passed": a team declaring `governance.minScore: 0.9`
       * against an unwired runtime accepts every run, and without this event
       * nothing anywhere says so. Treat a non-zero rate of skipped verdicts as
       * a misconfiguration to alert on, not as normal operation.
       */
      type: "team_verdict_evaluated";
      teamId: string;
      runId: string;
      gate: "governance" | "evaluation";
      outcome: "passed" | "rejected" | "skipped";
      /**
       * Why a `skipped` verdict was skipped. Absent on passed/rejected, where
       * the gate did run and `score` carries the answer.
       *
       * The two reasons demand different responses, and conflating them is the
       * ambiguity this field exists to remove:
       *
       * - `unwired` — the policy declared a threshold but no scorer service was
       *   injected. A deployment/wiring mistake, and expected in tests or where
       *   a team is declared before its scorer exists. Static: it is true of
       *   every run until someone changes the wiring.
       * - `scorer_failed` — a scorer WAS wired and could not produce a verdict
       *   (model timeout, rate limit, unparseable response) under a failure
       *   policy of `skip`. This is a LIVE dependency outage, and it is the
       *   more urgent case: it appears and disappears with provider health, and
       *   during it every run passes a gate someone is relying on.
       *
       * Without this discriminator a judge outage looks exactly like a gate
       * nobody wired, so the alert for one is muted by the noise of the other.
       */
      reason?: "unwired" | "scorer_failed";
      /**
       * Numeric verdict score in [0, 1] returned by the scorer service.
       *
       * Absent on `outcome: 'skipped'` — no scorer ran, so there is no score.
       * Deliberately left undefined rather than defaulted to 0 or 1, either of
       * which would be a fabricated verdict that dashboards would average in
       * as though a real gate had produced it.
       */
      score?: number;
      at: Date;
    };

/** Callback shape used to stream runtime events to observers. */
export type TeamRuntimeEventEmitter = (event: TeamRuntimeEvent) => void;
