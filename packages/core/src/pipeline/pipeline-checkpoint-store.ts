/**
 * Pipeline checkpoint store — interfaces for persisting pipeline run state.
 *
 * All types are JSON-serializable (ISO strings instead of Date objects).
 *
 * @module pipeline/pipeline-checkpoint-store
 */

import type {
  PipelineInteractionResumeV1,
  PipelineInteractionScopeV1,
  PipelinePendingInteractionV1,
  PipelineSha256Digest,
} from "@dzupagent/runtime-contracts";
import type { PipelineSchemaVersion } from "./pipeline-definition.js";

// ---------------------------------------------------------------------------
// Checkpoint types
// ---------------------------------------------------------------------------

/**
 * Durable cursor for one predicate-loop node.
 *
 * `iteration` is the number of fully completed iterations. When
 * `nextBodyNodeIndex` is present, the loop is part-way through the next
 * iteration and resumes at that zero-based body-node index. `bodyResults`
 * retains the already-completed body results needed by downstream body nodes
 * and the loop predicate without coupling core to the runtime `NodeResult`
 * type.
 *
 * The optional fields are backward-compatible with iteration-only W3
 * checkpoints. They are omitted for for-each loops, whose ordered-prefix
 * cursor remains iteration-based.
 *
 * `itemFrames` is the E0 exception to that last sentence: a for-each loop's
 * ordered-prefix `iteration` still counts fully-completed items, but a crash
 * part-way through an item would otherwise repeat every body node in it. The
 * frames record progress *within* each in-flight item so E3 can resume
 * mid-item. They are absent for predicate loops and for for-each loops
 * sitting exactly on an item boundary. The singular `itemFrame` is the
 * pre-G1 spelling, still read but no longer written.
 */
export interface PipelineLoopCheckpointState {
  iteration: number;
  nextBodyNodeIndex?: number;
  bodyResults?: Record<string, unknown>;
  /**
   * Mid-item progress for a for-each loop, singular (E3 shape).
   *
   * @deprecated G1 superseded this with {@link itemFrames}, which can hold
   * more than one in-flight item. Retained read-only for checkpoints written
   * before G1: readers normalise it into `itemFrames` keyed by its own
   * `itemIndex`. Writers must emit `itemFrames` instead. A checkpoint must
   * not carry both.
   */
  itemFrame?: PipelineForEachItemFrame;
  /**
   * Mid-item progress for every currently in-flight for-each item (G1),
   * keyed by the item's zero-based index within the resolved source
   * (decimal, no padding — the same string `String(itemIndex)` produces).
   *
   * The singular `itemFrame` it replaces could only ever name one item, so
   * two concurrently in-flight items clobbered each other and an item
   * boundary reached by one erased the live frame of another. Keying by
   * index makes the durable shape *capable* of N>1.
   *
   * 24-I RE-DATED: this previously said `concurrency` "remains pinned to 1 at
   * every admission point, so exactly one key is populated in practice". Both
   * halves are now false — N>1 is admitted and several keys are populated
   * concurrently in a real run. This is a correctness claim readers rely on,
   * not a test comment, so it is corrected rather than merely annotated.
   *
   * Absent for predicate loops and for for-each loops sitting exactly on an
   * item boundary. An empty record is normalised to absent when written.
   */
  itemFrames?: Record<string, PipelineForEachItemFrame>;
  /**
   * Terminal accounting record for every `for_each` item the loop resolved
   * (24-G, doc 27 §8 proof 8), keyed by the item's zero-based index in the
   * same decimal spelling as {@link itemFrames}.
   *
   * Deliberately SEPARATE from `itemFrames` rather than an extra field on it,
   * because the two structures have opposite lifetimes and overloading one
   * with both is what made the terminal set unrecordable before 24-G:
   *
   * - `itemFrames` is a RESUME cursor. Its contract is to be retired once the
   *   ordered prefix passes the item — `retainInFlightItemFrames` drops every
   *   frame with `itemIndex < completedIterations` at each item boundary — and
   *   no frame is written for an item's last body node at all, because doing so
   *   would contradict the ordered-prefix cursor.
   * - `itemOutcomes` is an ACCOUNTING record. It must survive exactly that
   *   retirement, because "what happened to item 7" is a question asked *after*
   *   item 7 is behind the prefix, and most often about a run that stopped.
   *
   * Complete over `0..n-1` once the loop returns: items the loop never reached
   * because it stopped early are recorded `cancelled` rather than left absent,
   * which is what makes "every index has a terminal outcome" assertable at all.
   * Absent entirely for predicate loops and for a for-each loop that has not
   * yet retired an item.
   */
  itemOutcomes?: Record<string, PipelineForEachItemTerminalRecord>;
  /**
   * Scoped canonical-executor frame for a compiler-lowered graph body.
   * Mutually exclusive with the legacy flat-list cursor above.
   */
  bodyGraphState?: PipelineLoopBodyGraphCheckpointState;
  /** Previous completed iteration's final body output (`loop.previous`). */
  previousOutput?: unknown;
  /** Canonical digest of the previous iteration's progress-node output. */
  progressDigest?: `sha256:${string}`;
}

/**
 * Durable progress inside one in-flight `for_each` item.
 *
 * The ordered-prefix cursor (`PipelineLoopCheckpointState.iteration`) only
 * advances when an item is *fully* complete, so it cannot express "item 7 got
 * through two of its four body nodes". Without that, a crash mid-item re-runs
 * body nodes that already committed their side effects.
 *
 * Retaining `bodyResults` mirrors the predicate-loop cursor: downstream body
 * nodes in the same item read their predecessors' outputs, so a mid-item resume
 * has to restore them rather than re-execute to rebuild them.
 */
export interface PipelineForEachItemFrame {
  /** Zero-based index of the in-flight item within the resolved source. */
  itemIndex: number;
  /**
   * Zero-based index of the next body node to dispatch for this item.
   * Body nodes before it completed successfully and are retained below.
   */
  nextBodyNodeIndex: number;
  /**
   * Successful body results for this item, keyed by body node id. Restored
   * into the item's `previousResults` on resume so downstream body nodes see
   * their predecessors without re-execution.
   */
  bodyResults?: Record<string, unknown>;
  /**
   * Attempt counter for this item, incremented per re-dispatch. Feeds the
   * execution scope so a retry derives a distinct idempotency key.
   */
  attempt?: number;
  /**
   * Durable lifecycle state of this item (24-F, doc 27 §8 prereq 2).
   *
   * Before 24-F a frame existed *only* while an item was mid-body and still in
   * flight, so "what happened to item 7" had no durable answer: a failed,
   * denied, aborted or settled item returned early and left no frame at all.
   * That is why doc 27 §8 proof 5's outcome sub-part was unrepresentable
   * rather than merely unwritten — there was no field to corrupt, so there was
   * nothing to reject.
   *
   * Monotonic: an item advances `reserved → running → {completed | failed |
   * cancelled | denied | outcome_unknown}` and never moves backwards. The
   * terminal members are terminal for the *attempt*; a re-dispatch opens a new
   * attempt rather than reopening a settled one. {@link isTerminalItemOutcome}
   * is the single reader of that classification.
   *
   * Optional for backward compatibility: a checkpoint written before 24-F
   * carries no outcome, and absence must stay UNPROVABLE rather than be read
   * as agreement — an absent outcome means "this checkpoint predates the
   * field", never "this item is running". Every guard here follows that rule
   * so pre-24-F checkpoints keep resuming.
   */
  outcome?: PipelineForEachItemOutcome;
  /**
   * Durable per-item economics (24-F, doc 27 §8 proof 5's economics sub-part).
   *
   * Reservation identity and settled cost existed only in loop-local memory,
   * so a crash lost the link between an item and the ledger row it opened, and
   * a corrupted economics field could not be rejected because none was stored.
   * Absent when the host authored no `itemBudgetCents` ceiling, in which case
   * `for_each` takes no reservation at all and there is genuinely nothing to
   * record.
   */
  economics?: PipelineForEachItemEconomics;
}

/**
 * Terminal accounting record for one `for_each` item (24-G).
 *
 * Distinct from {@link PipelineForEachItemFrame} because it answers a different
 * question at a different time. A frame answers "where do I resume this item?"
 * and is retired the moment the ordered prefix passes it; this record answers
 * "what finally happened to this item, and what did it cost?" and must outlive
 * exactly that retirement.
 *
 * It carries no body cursor for the same reason: a terminal item has nowhere to
 * resume to, so `nextBodyNodeIndex`/`bodyResults` would be dead weight on every
 * checkpoint. Keeping the two records disjoint is what lets `itemFrames` stay
 * strictly in-flight and hold its exact boundary pins.
 */
export interface PipelineForEachItemTerminalRecord {
  /** Zero-based index of the item within the resolved source. */
  itemIndex: number;
  /**
   * The item's final state for this run.
   *
   * Usually terminal per {@link isTerminalItemOutcome}, but deliberately typed
   * as the full vocabulary so `outcome_unknown` is recordable: an item holding
   * an unproven reservation is precisely the one an operator most needs a
   * durable pointer to, and refusing to record it because it is not terminal
   * would erase the only trace of a stranded ledger row.
   */
  outcome: PipelineForEachItemOutcome;
  /**
   * Economics as of the terminal state. Absent when the host authored no
   * ceiling, and equally when the item never dispatched — a `cancelled` or
   * `denied` item opened no ledger row, and recording a zero reservation for
   * it would assert one that never existed.
   */
  economics?: PipelineForEachItemEconomics;
  /**
   * Attempt this record describes; omitted at 0, matching the frame and
   * reservation-id conventions so a record, its frame, and its ledger row all
   * name the same attempt the same way.
   */
  attempt?: number;
}

/**
 * Durable lifecycle state of one `for_each` item attempt.
 *
 * `denied` and `outcome_unknown` are distinct from `failed` on purpose. A
 * `failed` item ran and its body reported an error; a `denied` item never
 * dispatched because its ceiling could not be authorized; an
 * `outcome_unknown` item holds a reservation whose terminal state the host
 * could not prove. Collapsing the last into `failed` would report a clean
 * failure over money in an unknown state — the exact fact G2d fails closed on.
 */
export type PipelineForEachItemOutcome =
  | "reserved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "denied"
  | "outcome_unknown";

/** Every value {@link PipelineForEachItemOutcome} admits, for validation. */
export const PIPELINE_FOR_EACH_ITEM_OUTCOMES: readonly PipelineForEachItemOutcome[] =
  [
    "reserved",
    "running",
    "completed",
    "failed",
    "cancelled",
    "denied",
    "outcome_unknown",
  ];

/**
 * True when an outcome is terminal for its attempt.
 *
 * `outcome_unknown` is deliberately NOT terminal: the item's reservation state
 * is unproven, so treating it as settled would let accounting close over an
 * outstanding ledger row. Reconciliation must resolve it first.
 */
export function isTerminalItemOutcome(
  outcome: PipelineForEachItemOutcome
): boolean {
  return (
    outcome === "completed" ||
    outcome === "failed" ||
    outcome === "cancelled" ||
    outcome === "denied"
  );
}

/**
 * Durable economics for one `for_each` item attempt.
 *
 * `reservationId` is the deterministic id `deriveItemReservationId` produces,
 * so an operator can join a stranded checkpoint to its ledger row, and a
 * resume can prove the reservation it is about to reconcile is the one this
 * item actually opened.
 */
export interface PipelineForEachItemEconomics {
  /** Deterministic reservation id this item's attempt opened. */
  reservationId: string;
  /** Integer cents admitted by the host for this item, `>= 0`. */
  reservedCostCents: number;
  /**
   * Integer cents actually settled, `>= 0`. Absent until the item settles —
   * a reserved-but-unsettled item has no actual spend yet, which is different
   * from having settled zero.
   */
  settledCostCents?: number;
}

export interface PipelineLoopBodyGraphCheckpointState {
  /** True when the body graph reached a normal or terminal exit. */
  completed: boolean;
  /** Next body node to dispatch for an in-progress traversal. */
  nextNodeId?: string;
  /**
   * Durable classified boundary reached by the scoped traversal.
   *
   * Optional for backward compatibility with graph checkpoints written before
   * nested control outcomes were retained. A suspended outcome deliberately
   * keeps `completed=false` and omits `nextNodeId`: the owning outer checkpoint
   * carries the loop suspension marker, and resume first persists the exact
   * post-suspension cursor before dispatching it.
   */
  outcome?: PipelineLoopBodyGraphCheckpointOutcome;
  /** Scoped nodes already completed in this body iteration. */
  completedNodeIds: string[];
  /** Body-only node results required by downstream graph nodes. */
  nodeResults: Record<string, unknown>;
  /** Stable keys already assigned inside the scoped executor. */
  nodeIdempotencyKeys: Record<string, string>;
  /** Mid-fork progress retained by the canonical fork scheduler. */
  forkState?: Record<
    string,
    {
      branches: Record<
        string,
        {
          stateDelta: Record<string, unknown>;
          nodeResults: Record<string, unknown>;
        }
      >;
    }
  >;
}

/** Durable control boundary for a compiler-bounded loop-body traversal. */
export type PipelineLoopBodyGraphCheckpointOutcome =
  | { kind: "normal"; exitNodeId: string }
  | { kind: "suspended"; exitNodeId: string }
  | { kind: "terminal"; exitNodeId: string };

/**
 * Run-level binding to the exact artifact a checkpoint was produced from.
 *
 * `pipelineId` names a definition but does not pin its *content*, so an
 * ordinary resume cannot today prove the checkpoint it is restoring belongs to
 * the same compiled pipeline — or, for a `for_each` loop, to the same item
 * source. Restoring a checkpoint under a changed definition silently admits
 * source replacement and item reordering.
 *
 * This binding is the E0 contract that closes that hole. It is declared here
 * and carried on the checkpoint; enforcement (rejecting a mismatched resume)
 * lands with the resume work in E3, so this stays optional for backward
 * compatibility with checkpoints written before it existed.
 */
export interface PipelineCheckpointSourceBinding {
  /**
   * Canonical digest of the compiled pipeline artifact this run executes.
   * Same value space as the interaction cursor's `definitionDigest`, hoisted
   * to the run so every resume — not only an interaction resume — can check it.
   */
  definitionDigest: PipelineSha256Digest;
  /**
   * Per-loop digest of the resolved `for_each` item source, keyed by loop node
   * id. Recorded when the loop's items are resolved, so a resume can prove the
   * retained ordered prefix still refers to the same items in the same order.
   * Loops whose source has not yet been resolved are absent.
   */
  loopSourceDigests?: Record<string, PipelineSha256Digest>;
}

/**
 * Identity of one durable unit of loop work.
 *
 * A predicate loop's cursor is a single `iteration` counter, which is enough
 * because its body advances strictly in order. A `for_each` item is not the
 * same shape: it has an index into a resolved source, and its body is a list of
 * nodes that can each fail independently. Without an explicit scope, an
 * idempotency key derived from `(runId, nodeId)` alone repeats across every
 * item, and a crash part-way through an item cannot be distinguished from a
 * crash before it.
 *
 * This is the frame E1 (CAS persistence) versions and E2 (item-scoped
 * idempotency) folds into the key space. E0 only declares it.
 */
export interface PipelineExecutionScope {
  /** Loop node this scope belongs to. */
  loopNodeId: string;
  /** Zero-based index into the resolved `for_each` source. */
  itemIndex: number;
  /** Body node being executed within the item, when scoped to one. */
  bodyNodeId?: string;
  /**
   * Attempt counter for this exact (loop, item, body node) triple. Starts at 0
   * and increments per re-dispatch, so a retry is distinguishable from the
   * first attempt in both the ledger and the derived idempotency key.
   */
  attempt?: number;
}

/**
 * Policy for a node whose durable ledger is unreachable at dispatch.
 *
 * Today the runtime always degrades open: it logs
 * `effect: "idempotency_disabled_for_node"`, synthesizes a lease with
 * `fenceToken: 0`, and proceeds — trading exactly-once for liveness. That is
 * defensible for idempotent work and wrong for chargeable per-item work, where
 * a retried run can double-execute a side effect.
 *
 * Making it a policy value rather than a hardcoded branch lets the choice be
 * made per run instead of per build. E0 declares it and does NOT change the
 * current behavior: `"degrade-open"` remains the default, so absence is exactly
 * today's semantics. Flipping any lane to `"strict"` is an E2 decision.
 */
export type PipelineLedgerUnavailablePolicy = "degrade-open" | "strict";

/**
 * Snapshot of a pipeline run's state at a point in time.
 *
 * Checkpoints are versioned — each save increments the version number
 * so callers can load any prior version or the latest.
 */
export interface PipelineCheckpoint {
  /** Unique run identifier (one pipeline definition can have many runs) */
  pipelineRunId: string;
  /** Pipeline definition ID this run belongs to */
  pipelineId: string;
  /** Monotonically increasing version number for this run */
  version: number;
  /** Schema version for forward compatibility */
  schemaVersion: PipelineSchemaVersion;
  /**
   * Exact artifact/source this checkpoint was produced from. Optional for
   * backward compatibility; absence means "unbound", which resume must treat
   * as unprovable rather than as agreement.
   */
  sourceBinding?: PipelineCheckpointSourceBinding;
  /** IDs of nodes that have completed execution */
  completedNodeIds: string[];
  /**
   * Stable idempotency key per completed node (`nodeId` → key).
   *
   * The key is deterministic for a given `(pipelineRunId, nodeId)`, so a node's
   * external effects can be deduplicated by a downstream store even if the
   * process crashed after the effect ran but before this checkpoint persisted.
   * Optional for backward compatibility with checkpoints written before this
   * field existed; absence is treated as "no recorded keys".
   */
  nodeIdempotencyKeys?: Record<string, string>;
  /**
   * Per-loop-node iteration cursor (W3 durable loop resume).
   *
   * Maps a loop node's ID to the number of fully-completed iterations. On
   * resume the loop restarts at `iteration` (skipping completed iterations)
   * rather than from zero, so a crash mid-loop does not re-run earlier
   * iterations. An entry is removed once its loop completes. Optional for
   * backward compatibility; absence means "no loop is mid-flight".
   */
  loopState?: Record<string, PipelineLoopCheckpointState>;
  /**
   * Per-fork branch progress for durable fork/branch resume (W4).
   *
   * Maps a fork node's `forkId` to the branches that have fully completed,
   * each with the state delta and node results it produced. On resume,
   * completed branches are restored from here (not re-run) and only
   * unfinished branches re-execute; the final merge combines restored +
   * freshly-run results in deterministic outgoing-edge order. An entry is
   * removed once the fork's join completes. Optional for backward
   * compatibility; absence means "no fork is mid-flight". `nodeResults` is
   * the JSON-serialized form of a `NodeResult` map (`nodeId` -> result);
   * this module intentionally avoids importing `NodeResult` to keep the
   * checkpoint store free of runtime-contracts coupling.
   */
  forkState?: Record<
    string,
    {
      branches: Record<
        string,
        {
          stateDelta: Record<string, unknown>;
          nodeResults: Record<string, unknown>;
        }
      >;
    }
  >;
  /** Arbitrary state accumulated during execution */
  state: Record<string, unknown>;
  /** If the pipeline is currently suspended, the node it suspended at */
  suspendedAtNodeId?: string;
  /** Exact pending external decision. Ordinary resume cannot consume it. */
  pendingInteraction?: PipelinePendingInteractionV1;
  /** Immutable committed interaction receipts retained for replay/conflict checks. */
  interactionReceipts?: Record<string, PipelineInteractionResumeV1>;
  /**
   * Post-consumption cursor committed atomically with the receipt and state
   * update. It remains safe to replay because completed-node state suppresses
   * an already committed successor prefix.
   */
  interactionResumeCursor?: PipelineInteractionResumeCursor;
  /** Budget tracking state */
  budgetState?: {
    tokensUsed: number;
    costCents: number;
  };
  /** Number of recovery attempts consumed in this run (persisted to enforce limits across restarts) */
  recoveryAttemptsUsed?: number;
  /** Runtime events embedded in this checkpoint when requested by policy. */
  events?: PipelineCheckpointEventRecord[];
  /** Execution-log snapshot embedded in this checkpoint when requested by policy. */
  executionLog?: PipelineCheckpointExecutionLog;
  /** Provider session handles captured from node results when requested by policy. */
  providerSessionRefs?: PipelineCheckpointProviderSessionRef[];
  /** ISO-8601 timestamp of when this checkpoint was created */
  createdAt: string;
}

export interface PipelineInteractionResumeCursor {
  interactionId: string;
  /** Exact immutable receipt committed with this cursor. */
  receiptHash: PipelineSha256Digest;
  /** Exact pipeline artifact digest against which routing was selected. */
  definitionDigest: PipelineSha256Digest;
  nodeId: string;
  scope: PipelineInteractionScopeV1;
  /** Exact interaction successor selected by the response, if non-terminal. */
  selectedSuccessorNodeId?: string;
  /** Exact top-level node from which canonical execution resumes. */
  nextNodeId?: string;
}

export type PipelineCheckpointEventRecord = Record<string, unknown> & {
  type: string;
};

export interface PipelineCheckpointExecutionLog {
  storeRef?: string;
  eventHistory: "compact" | "full";
  events: PipelineCheckpointEventRecord[];
}

export interface PipelineCheckpointProviderSessionRef {
  /** Node that produced this provider session reference. */
  nodeId: string;
  provider: string;
  sessionId: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Lightweight summary of a checkpoint version — returned by listVersions().
 */
export interface PipelineCheckpointSummary {
  /** Run ID */
  pipelineRunId: string;
  /** Checkpoint version number */
  version: number;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** Number of completed nodes at this version */
  completedNodeCount: number;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

/**
 * Outcome of a compare-and-set checkpoint write.
 *
 * A conflict is an ordinary, expected result — not an error — so it is
 * reported rather than thrown. `observedVersion` lets a caller decide whether
 * to reload and retry or to abandon the write.
 */
export interface PipelineCheckpointCommitReceipt {
  /** True when this write won; false when another writer held the version. */
  committed: boolean;
  /**
   * The store's newest version for this run after the attempt. On a successful
   * commit this is the version just written; on a conflict it is the version
   * that was found instead of `expectedVersion`.
   */
  observedVersion: number;
}

/**
 * Persistence interface for pipeline checkpoints.
 *
 * Implementations may store data in-memory, on disk, or in a database.
 * All methods are async to support any backend.
 */
export interface PipelineCheckpointStore {
  /** Save a checkpoint (creates or updates by pipelineRunId + version) */
  save(checkpoint: PipelineCheckpoint): Promise<void>;

  /**
   * Save a checkpoint only if the store's current newest version for this run
   * is exactly `expectedVersion`, returning a receipt describing what happened.
   *
   * `save` above returns `Promise<void>`: the writer increments its own local
   * version counter and has no way to learn that another writer already claimed
   * that version. Two writers for one run therefore silently clobber each
   * other. This is the compare-and-set seam that closes it.
   *
   * Optional so existing store implementations remain valid. E1 implements it
   * for the in-memory, Redis, and Postgres stores and moves the writer onto it;
   * until then callers fall back to `save`. A store that does not implement it
   * cannot be used for exactly-once per-item work.
   *
   * Implementations must NOT throw on a version conflict — report it as
   * `{ committed: false }` so the caller can reload and retry.
   */
  saveIfVersion?(
    checkpoint: PipelineCheckpoint,
    expectedVersion: number
  ): Promise<PipelineCheckpointCommitReceipt>;

  /** Load the latest checkpoint for a run (undefined if no checkpoint exists) */
  load(pipelineRunId: string): Promise<PipelineCheckpoint | undefined>;

  /** Load a specific version of a checkpoint */
  loadVersion(
    pipelineRunId: string,
    version: number
  ): Promise<PipelineCheckpoint | undefined>;

  /** List all checkpoint versions for a run, ordered by version ascending */
  listVersions(pipelineRunId: string): Promise<PipelineCheckpointSummary[]>;

  /** Delete all checkpoints for a run */
  delete(pipelineRunId: string): Promise<void>;

  /** Optional: prune old versions for one run, keeping the newest `keepLatest` versions */
  pruneVersions?(pipelineRunId: string, keepLatest: number): Promise<number>;

  /** Prune checkpoints older than maxAgeMs; returns the number of pruned checkpoints */
  prune(maxAgeMs: number): Promise<number>;
}
