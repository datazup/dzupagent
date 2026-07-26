/**
 * Team checkpoint types — enable suspend/resume across team runs.
 *
 * A `TeamCheckpoint` captures enough state to resume a team after a human
 * approval, process restart, or long-running async step. `ResumeContract`
 * is the handshake that pairs a checkpoint with the resume call.
 *
 * Resume is enforced along the **participant** dimension only: `planResume`
 * validates the checkpoint's `teamId` binding and narrows the participant set
 * via `skipCompletedParticipants`. The **phase** dimension
 * (`TeamCheckpoint.phase`, `ResumeContract.resumeFromPhase`) is scoped out of
 * in-repo enforcement because `TeamRuntime` phases are emitted markers rather
 * than a driveable state machine, and `checkpointId` / `checkpointedAt` are
 * host-storage metadata the runtime cannot resolve. See each field's docs.
 */

import type { TeamPhase } from "./team-phase.js";

/** Serializable snapshot of a team run at a specific phase. */
export interface TeamCheckpoint {
  /** ID of the team this checkpoint belongs to. */
  teamId: string;
  /** ID of the specific run being checkpointed. */
  runId: string;
  /**
   * The phase that was active when the snapshot was taken.
   *
   * SCOPED OUT of in-repo TeamRuntime enforcement: `TeamRuntime` cannot re-enter
   * a run at an arbitrary phase, so there is nothing for a recorded phase to
   * restore. `executeTeamRun` creates a fresh `TeamPhaseModel` per call
   * (`createPhaseModel` — always `initializing`) as a *local*; it is never a
   * parameter and never escapes the function, so no caller can seed it. The
   * phase sequence is a hard-coded straight line whose transitions only emit
   * `phase_changed` events and OTel span events — `transitionPhase` returns
   * `void` and no code anywhere branches on a phase value. Recording the phase
   * is therefore an *observability* concern: it lets a host label, filter, or
   * display the checkpoint (and correlate it with the emitted `phase_changed`
   * stream), which is exactly what a host that owns checkpoint storage needs.
   * See {@link ResumeContract.resumeFromPhase} for why it cannot drive resume.
   */
  phase: TeamPhase;
  /** Participant IDs whose work is already finished and persisted. */
  completedParticipantIds: string[];
  /** Participant IDs whose work still needs to run. */
  pendingParticipantIds: string[];
  /** Shared context (blackboard state, intermediate outputs, etc.). */
  sharedContext: Record<string, unknown>;
  /**
   * When the snapshot was taken.
   *
   * SCOPED OUT of in-repo TeamRuntime enforcement: the runtime has no staleness
   * policy, expiry window, or ordering rule that this timestamp could feed. It
   * neither creates checkpoints nor stores them — `resume()` accepts whatever
   * `TeamCheckpoint` the caller hands it, and every timing decision the runtime
   * *does* make (`execution.timeoutMs`, breaker `resetAfterMs`) is measured from
   * the start of the current run, not from a prior checkpoint. Expiring or
   * ordering checkpoints is therefore a consuming-app concern, owned by whoever
   * backs checkpoint storage; this field is the metadata they need to do it.
   */
  checkpointedAt: Date;
}

/** Handshake used when resuming a checkpointed team run. */
export interface ResumeContract {
  /**
   * ID of the checkpoint to resume from.
   *
   * SCOPED OUT of in-repo TeamRuntime enforcement: this names a record in the
   * *host's* checkpoint store, and `TeamCheckpoint` carries no corresponding
   * field to validate it against. The runtime neither creates, stores, nor
   * looks up checkpoints — `resume()` is handed an already-materialized
   * snapshot, so by the time this value is visible the lookup it identifies has
   * already happened. It is deliberately not the same identity as
   * `TeamCheckpoint.runId` (which names the *run* that was suspended, not the
   * snapshot record), so cross-checking the two would reject correct callers.
   * Verifying that a contract names the snapshot it was issued for is therefore
   * a consuming-app concern, owned by whoever backs checkpoint storage; the
   * runtime enforces the binding it *can* see, `teamId`, in `planResume`.
   */
  checkpointId: string;
  /**
   * Phase at which to re-enter the run.
   *
   * SCOPED OUT of in-repo TeamRuntime enforcement: there is no phase-driven
   * dispatcher for this to seek into. `executeTeamRun` runs a fixed straight
   * line in which phases are *markers around* an indivisible unit of work, not
   * a partition of it — `planning` and `executing` transition back-to-back with
   * no code between them, `completing` wraps nothing, and the entire run is one
   * `pattern.execute()` call nested inside `executing`. So the only phase that
   * owns work is `executing`, which is already where every resume begins;
   * "skipping to" it is a no-op and skipping past it is incoherent, because
   * `evaluating` feeds `applyVerdictGates` the `result` that only
   * `pattern.execute()` can produce. Honouring this field would require a
   * phase→work map the runtime does not have, and inventing one would mean
   * guessing which work each phase owns.
   *
   * Resume narrows work along the *participant* dimension instead
   * ({@link ResumeContract.skipCompletedParticipants}), which is the dimension
   * the runtime can actually act on. A host that models finer-grained,
   * genuinely resumable stages owns that mapping itself; the field is kept so
   * such a host can round-trip its intent through the contract.
   */
  resumeFromPhase: TeamPhase;
  /** If true, participants listed as completed will not re-run. */
  skipCompletedParticipants: boolean;
}
