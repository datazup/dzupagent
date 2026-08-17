/**
 * for_each loop executor — runs body nodes once per item of a resolved
 * array source, with bounded concurrency, ordered prefix flushing,
 * optional collect/attach/accumulator aggregation, and durable resume.
 *
 * @module pipeline/loop-executor/for-each-loop
 */

import type {
  LoopNode,
  PipelineForEachItemOutcome,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import type {
  NodeExecutor,
  NodeExecutionContext,
  NodeResult,
  PipelineRuntimeEvent,
  LoopMetrics,
} from "../pipeline-runtime-types.js";
import type { LoopResumeOptions } from "./types.js";
import { resolveStatePath, setStatePath } from "./state-path.js";
import {
  advanceCompletedPrefix,
  type ForEachMergeState,
} from "./for-each-merge.js";

/**
 * F: a reservation held for one in-flight item, carried from the reserve at
 * the item's first body node to whichever of the three exits it reaches.
 */
interface HeldItemReservation {
  readonly reservedCostCents: number;
  readonly itemIndex: number;
  readonly attempt: number;
  /** G2b: deterministic identity presented to settle/release. */
  readonly reservationId: string;
}

/**
 * G2b (doc 27 §8 prereq 5): derive the deterministic reservation ID for one
 * `for_each` item attempt.
 *
 * Mirrors E2's idempotency-key scope segment deliberately — same field order,
 * same `attempt`-omitted-at-zero rule — so an operator reading a ledger row and
 * an execution trace side by side sees the same item named the same way. It is
 * a distinct namespace (`resv:v1:`) rather than the node key itself, because a
 * reservation is per ITEM while an idempotency key is per item BODY NODE;
 * reusing the node key would make N body nodes look like N reservations.
 *
 * Deterministic by construction: a crash-and-replay of the same item attempt
 * derives the identical string, which is exactly what lets a host recognise a
 * replayed reserve instead of opening a second ledger row.
 *
 * Exported for direct unit test: at `concurrency` 1 every observable difference
 * this function makes is also reachable end-to-end, but pinning the format here
 * keeps the wire contract falsifiable independently of the loop.
 */
export function deriveItemReservationId(params: {
  runId?: string;
  loopNodeId: string;
  itemIndex: number;
  attempt: number;
}): string {
  const run = params.runId === undefined ? "" : params.runId;
  const base = `resv:v1:${run}:item:${params.loopNodeId}:${params.itemIndex}`;
  return params.attempt > 0 ? `${base}:attempt:${params.attempt}` : base;
}

type ForEachContract = NonNullable<LoopNode["forEach"]>;

export async function executeForEachLoop(
  loopNode: LoopNode,
  bodyNodes: PipelineNode[],
  nodeExecutor: NodeExecutor,
  context: NodeExecutionContext,
  onEvent?: (event: PipelineRuntimeEvent) => void,
  resume?: LoopResumeOptions
): Promise<{ result: NodeResult; metrics: LoopMetrics }> {
  const startTime = Date.now();
  const contract = loopNode.forEach as ForEachContract;
  if (contract.concurrency !== 1) {
    return {
      result: {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" for_each concurrency must be 1 until ` +
          "a durable per-item frame and economic settlement protocol are admitted",
      },
      metrics: {
        iterationCount: 0,
        iterationDurations: [],
        converged: false,
        terminationReason: "condition_met",
      },
    };
  }
  const resolvedItems = resolveStatePath(context.state, contract.source);
  if (!Array.isArray(resolvedItems.value)) {
    const totalDuration = Date.now() - startTime;
    return {
      result: {
        nodeId: loopNode.id,
        output: null,
        durationMs: totalDuration,
        error: `Loop "${loopNode.id}" for_each source "${contract.source}" did not resolve to an array`,
      },
      metrics: {
        iterationCount: 0,
        iterationDurations: [],
        converged: false,
        terminationReason: "condition_met",
      },
    };
  }

  const items = resolvedItems.value;
  if (items.length === 0) {
    if (contract.collect !== undefined) {
      setStatePath(context.state, contract.collect.into, []);
    }
    if (contract.accumulator !== undefined) {
      setStatePath(
        context.state,
        contract.accumulator.key,
        initialAccumulatorValue(context.state, contract.accumulator)
      );
    }
    onEvent?.(forEachAggregateEvent(loopNode.id, 0, true, contract));
    const totalDuration = Date.now() - startTime;
    return {
      result: {
        nodeId: loopNode.id,
        output: forEachOutput(contract, [], [], [], null),
        durationMs: totalDuration,
      },
      metrics: {
        iterationCount: 0,
        iterationDurations: [],
        converged: true,
        terminationReason: "condition_met",
      },
    };
  }

  const concurrency = Math.max(
    1,
    Math.min(Math.floor(contract.concurrency), items.length)
  );
  const startIndex = Math.min(
    Math.max(0, resume?.startIteration ?? 0),
    items.length
  );
  const iterationDurations = new Array<number>(items.length);
  for (let i = 0; i < startIndex; i++) {
    iterationDurations[i] = 0;
  }
  const collected = new Array<unknown>(items.length);
  if (contract.collect !== undefined) {
    const existingCollect = resolveStatePath(
      context.state,
      contract.collect.into
    );
    if (Array.isArray(existingCollect.value)) {
      for (
        let i = 0;
        i < Math.min(startIndex, existingCollect.value.length);
        i++
      ) {
        collected[i] = existingCollect.value[i];
      }
    }
  }
  const enrichedItems = [...items];
  const initialAccumulator =
    contract.accumulator !== undefined
      ? initialAccumulatorValue(context.state, contract.accumulator)
      : [];
  if (contract.accumulator !== undefined) {
    setStatePath(context.state, contract.accumulator.key, initialAccumulator);
  }
  const results = new Array<NodeResult | undefined>(items.length);
  // The ordered-prefix merge state, owned by `for-each-merge.ts`. Grouped into
  // one object so the merge algorithm is drivable as a unit against completion
  // patterns the exact-1 admission gate makes unreachable end-to-end
  // (doc 27 §8 proofs 2 and 3).
  const merge: ForEachMergeState = {
    completed: new Array<boolean>(items.length).fill(false),
    flushedPrefix: startIndex,
    collected,
    enrichedItems,
    attachedValues: new Array<unknown>(items.length),
    accumulatorItems: new Array<unknown>(items.length),
    accumulatorValues: initialAccumulator,
  };
  const completed = merge.completed;
  let nextIndex = startIndex;
  let firstError: NodeResult | undefined;
  // F: a breached monetary ceiling stops the loop regardless of
  // `contract.failFast`, unlike a body error, which `failFast` lets the author
  // tolerate. `failFast` is a policy about FAILURES; an authored budget ceiling
  // is a hard admission gate, so honouring `failFast` here would keep spending
  // past the breach.
  //
  // SCOPE: this flag is read by the worker loop BETWEEN items, which stops
  // dispatch exactly because `concurrency` is pinned to 1 above — one worker,
  // no item in flight when the check runs. At concurrency > 1 (packet 24-G)
  // that is no longer sufficient: up to N-1 items would already be mid-flight
  // with reservations outstanding and would settle spend past the breach.
  // Admitting concurrency therefore requires propagating this into in-flight
  // items (an internal AbortController composed with `context.signal`), not
  // just relaxing the guard.
  let budgetBreached = false;
  let flushQueue = Promise.resolve();

  // F: per-item economic settlement. The `forEach` compile-time contract has
  // no budget field, so the ceiling is host-authored via `itemBudgetCents`.
  // When it is absent, `for_each` takes no reservation and all three helpers
  // are inert — byte-identical to the pre-F behaviour.
  const itemBudgetCents = resume?.itemBudgetCents;
  const reserveItem = async (
    index: number,
    attempt: number,
    state: Record<string, unknown>
  ): Promise<
    HeldItemReservation | undefined | "denied" | { outcomeUnknown: string }
  > => {
    if (itemBudgetCents === undefined) return undefined;
    const reserve = resume?.reserveIterationBudget;
    const reservationId = deriveItemReservationId({
      ...(resume?.budgetRunId === undefined
        ? {}
        : { runId: resume.budgetRunId }),
      loopNodeId: loopNode.id,
      itemIndex: index,
      attempt,
    });
    let reservation;
    try {
      reservation =
        reserve === undefined
          ? ({ status: "unknown" } as const)
          : await reserve({
              loopNodeId: loopNode.id,
              iteration: index + 1,
              budgetCents: itemBudgetCents,
              bodyNodeIds: bodyNodes.map(({ id }) => id),
              state,
              itemIndex: index,
              ...(attempt > 0 ? { attempt } : {}),
              reservationId,
            });
    } catch (error) {
      // G2b (prereq 6): a THROWN reserve is not an answered "unknown". The call
      // may have created the reservation before the transport failed, so its
      // existence is genuinely unknown and neither releasing nor redispatching
      // is safe. Hand it to reconciliation rather than collapsing it into the
      // clean-denial path, which would leak the reservation forever.
      return {
        outcomeUnknown: error instanceof Error ? error.message : String(error),
      };
    }
    if (
      reservation.status === "unknown" ||
      !Number.isFinite(reservation.reservedCostCents) ||
      reservation.reservedCostCents < 0 ||
      reservation.reservedCostCents > itemBudgetCents
    ) {
      return "denied";
    }
    return {
      reservedCostCents: reservation.reservedCostCents,
      itemIndex: index,
      attempt,
      reservationId,
    };
  };

  /**
   * G2b/G2d: resolve an outcome-unknown reservation. Returns an error string
   * when the item must stay blocked — i.e. whenever the host cannot PROVE the
   * outcome. Only an explicit `released`/`absent` answer clears it.
   *
   * G2d (doc 27 §8 prereq 7) widened this from the reserve boundary alone to
   * every lifecycle boundary that can leave a reservation unaccounted. A
   * `settle` or `release` that THROWS is the same class of fact as a thrown
   * `reserve`: the call may have been applied before the transport failed, so
   * the reservation's terminal state is genuinely unknown. `boundary` names
   * which call went unobserved so an operator reading the failure knows what
   * to look for in the ledger.
   */
  const reconcileUnknownReservation = async (
    index: number,
    attempt: number,
    reason: string,
    boundary: "reserve" | "settle" | "release"
  ): Promise<string | undefined> => {
    const reservationId = deriveItemReservationId({
      ...(resume?.budgetRunId === undefined
        ? {}
        : { runId: resume.budgetRunId }),
      loopNodeId: loopNode.id,
      itemIndex: index,
      attempt,
    });
    const reconcile = resume?.reconcileIterationBudget;
    const blocked =
      `Loop "${loopNode.id}" item ${index} reservation ${reservationId} is ` +
      `outcome-unknown after its ${boundary} could not be observed and was ` +
      `not reconciled: ${reason}`;
    if (reconcile === undefined) return blocked;
    let outcome;
    try {
      outcome = await reconcile({
        loopNodeId: loopNode.id,
        iteration: index + 1,
        itemIndex: index,
        ...(attempt > 0 ? { attempt } : {}),
        reservationId,
        budgetCents: itemBudgetCents as number,
        reason,
        boundary,
      });
    } catch (error) {
      // A reconcile that itself fails proves nothing — stay blocked.
      return (
        `${blocked} (reconciliation failed: ` +
        `${error instanceof Error ? error.message : String(error)})`
      );
    }
    // `released` and `absent` are the only two proofs. `unknown` — and any
    // unrecognised status — leaves the item blocked, fail-closed.
    if (outcome.status === "released" || outcome.status === "absent") {
      return undefined;
    }
    // 24-H (proof 6, conflict half): a conflict blocks exactly like an unknown,
    // but it is the opposite epistemic state and must not be reported as one.
    // "could not be observed" sends an operator hunting a transport fault; the
    // host in fact observed the reservation perfectly and knows who owns it.
    // Reporting the holder is the entire value the status adds over `unknown` —
    // without it this is a relabelling that earns nothing.
    if (outcome.status === "conflict") {
      return (
        `Loop "${loopNode.id}" item ${index} reservation ${reservationId} is ` +
        `held by another writer "${outcome.heldBy}" after its ${boundary}: ` +
        `${reason}`
      );
    }
    return blocked;
  };

  /**
   * Settle a completed item's reservation.
   *
   * Returns an error string when the settled amount overruns its reservation,
   * or (G2d) an `outcomeUnknown` marker when the settle call itself could not
   * be observed. `undefined` means the item settled cleanly.
   */
  const settleItem = async (
    held: HeldItemReservation | undefined,
    bodyResults: Readonly<Record<string, NodeResult>>
  ): Promise<
    | string
    | undefined
    | { outcomeUnknown: string }
    // 24-G: a clean settle now reports what was ACTUALLY settled, so the
    // terminal record carries the real charged amount rather than re-deriving
    // it from the reservation. Re-deriving would silently report the reserved
    // amount whenever an extractor returned something smaller.
    | { settledCostCents: number }
  > => {
    if (held === undefined) return undefined;
    // Absent an extractor, actual spend is treated as the full reservation:
    // conservative, never under-charges, and never reports a false overrun.
    const extract = resume?.extractItemCostCents;
    let actualCostCents = held.reservedCostCents;
    if (extract !== undefined) {
      let total = 0;
      for (const [nodeId, result] of Object.entries(bodyResults)) {
        const cost = extract(nodeId, result);
        if (cost !== undefined && Number.isFinite(cost) && cost > 0) {
          total += Math.round(cost);
        }
      }
      actualCostCents = total;
    }
    try {
      await resume?.settleIterationBudget?.({
        loopNodeId: loopNode.id,
        iteration: held.itemIndex + 1,
        itemIndex: held.itemIndex,
        ...(held.attempt > 0 ? { attempt: held.attempt } : {}),
        reservationId: held.reservationId,
        reservedCostCents: held.reservedCostCents,
        actualCostCents,
      });
    } catch (error) {
      // G2d (prereq 7): the item's WORK completed, but whether its reservation
      // was settled is now unknown — the host may have applied the settlement
      // before the transport failed. Releasing would refund money already
      // charged; assuming success would leave a reservation outstanding
      // forever. Only reconciliation can prove which, so hand it over rather
      // than letting the throw escape the loop unclassified.
      return {
        outcomeUnknown: error instanceof Error ? error.message : String(error),
      };
    }
    return actualCostCents > held.reservedCostCents
      ? `Loop "${loopNode.id}" item ${held.itemIndex} settled ${actualCostCents} cents, ` +
          `exceeding its ${held.reservedCostCents}-cent reservation`
      : { settledCostCents: actualCostCents };
  };

  /**
   * Return an unspent reservation whose work never completed.
   *
   * G2d (prereq 7): returns an `outcomeUnknown` marker when the release call
   * could not be observed. A thrown release is not proof the reservation is
   * still held — the host may have returned it before the transport failed —
   * so redispatching or declaring the item terminally settled would both be
   * guesses. `undefined` means the reservation was returned cleanly.
   */
  const releaseItem = async (
    held: HeldItemReservation | undefined,
    reason: "aborted" | "failed"
  ): Promise<{ outcomeUnknown: string } | undefined> => {
    if (held === undefined) return undefined;
    try {
      await resume?.releaseIterationBudget?.({
        loopNodeId: loopNode.id,
        iteration: held.itemIndex + 1,
        itemIndex: held.itemIndex,
        ...(held.attempt > 0 ? { attempt: held.attempt } : {}),
        reservationId: held.reservationId,
        reservedCostCents: held.reservedCostCents,
        reason,
      });
    } catch (error) {
      return {
        outcomeUnknown: error instanceof Error ? error.message : String(error),
      };
    }
    return undefined;
  };

  // 24-G: every index that reaches a terminal state, recorded here so the
  // never-dispatched tail can be completed once the worker loop stops. Held
  // loop-locally as well as reported, because "which indices are still absent"
  // is only answerable against the whole set.
  const terminalOutcomes = new Set<number>();

  /**
   * 24-G: record one item's terminal classification.
   *
   * Every exit of `runIteration` routes through here rather than writing a
   * frame, because a frame is an IN-FLIGHT record that `retainInFlightItemFrames`
   * retires at the next item boundary — which is exactly when a terminal
   * outcome becomes the only remaining evidence about the item.
   */
  const recordTerminalOutcome = async (
    index: number,
    outcome: PipelineForEachItemOutcome,
    held: HeldItemReservation | undefined,
    settledCostCents?: number
  ): Promise<void> => {
    terminalOutcomes.add(index);
    await resume?.onItemTerminalOutcome?.({
      itemIndex: index,
      outcome,
      ...(held === undefined
        ? {}
        : {
            economics: {
              reservationId: held.reservationId,
              reservedCostCents: held.reservedCostCents,
              ...(settledCostCents === undefined ? {} : { settledCostCents }),
            },
          }),
      ...(held !== undefined && held.attempt > 0
        ? { attempt: held.attempt }
        : {}),
    });
  };

  /**
   * 24-H: mark an already-settled item complete without dispatching it.
   *
   * Returns `false` when the item's aggregate contribution CANNOT be
   * reconstructed, in which case nothing is mutated and the caller must
   * dispatch the item normally. That gate is the whole subtlety of this packet,
   * and it is not a defensive nicety — it is reachable and covered:
   *
   * - A multi-body-node item leaves a mid-item frame (written at every body
   *   node except the last), which survives prefix retirement for exactly the
   *   items this path handles (`itemIndex >= completedIterations`). Its
   *   `collect.from` resolves against the retained results, so the value is
   *   recoverable and the skip is safe.
   * - A SINGLE-body-node item leaves NO frame at all — the frame write is gated
   *   on `bodyIndex < bodyNodes.length - 1`, which is never true when there is
   *   one node. If `collect.from` names something only that node produced, the
   *   value is genuinely gone, and skipping would flush `undefined` into the
   *   aggregate: `['a', 'b', 'c', undefined]`.
   *
   * That second case is precisely the hole 24-G predicted. It was wrong that the
   * hole is unavoidable, and this packet was wrong to assume it never occurs —
   * both shapes are real, and which one applies is a property of the flow
   * document, not of the loop. So recoverability is TESTED rather than assumed:
   * skip when the value can be rebuilt, re-run when it cannot. Re-running is the
   * pre-24-H behaviour, double charge included, which is strictly better than a
   * silently corrupted aggregate.
   *
   * No terminal outcome is recorded on the skip path: the previous run already
   * recorded `completed` for this index, and re-recording would overwrite that
   * run's settled economics with an attempt that never opened a ledger row.
   */
  const restoreSettledItem = async (index: number): Promise<boolean> => {
    const itemState = {
      ...context.state,
      [contract.as]: items[index],
    };
    let restoredValue: unknown;
    if (contract.collect !== undefined) {
      const retained = new Map<string, NodeResult>();
      const frame = resume?.itemFrames?.[String(index)];
      for (const [nodeId, result] of Object.entries(frame?.bodyResults ?? {})) {
        retained.set(nodeId, result as NodeResult);
      }
      const resolved = resolveStatePath(itemState, contract.collect.from);
      const fromResults = retained.get(contract.collect.from)?.output;
      // `collectIterationValue` falls back to `undefined` when neither source
      // has the path, which is indistinguishable from a genuinely-undefined
      // collected value. Resolve the two sources explicitly instead so an
      // unrecoverable value is a REFUSAL to skip rather than a silent hole.
      if (!resolved.found && fromResults === undefined) return false;
      restoredValue = resolved.found ? resolved.value : fromResults;
    }
    if (contract.collect !== undefined) collected[index] = restoredValue;
    merge.attachedValues[index] = itemState[contract.as];
    merge.accumulatorItems[index] = itemState[contract.as];
    // A skipped item consumed no wall-clock this run. Recording 0 rather than
    // leaving it undefined keeps it counted by `completedIterations`, which
    // filters on `!== undefined` — an omitted duration would under-report the
    // loop's completed-item count.
    iterationDurations[index] = 0;
    completed[index] = true;
    // Serialized through the same queue as a dispatched completion, so the
    // ordered prefix advances in one place regardless of how an item completed.
    flushQueue = flushQueue.then(flushCompletedPrefix);
    await flushQueue;
    return true;
  };

  const runIteration = async (index: number): Promise<void> => {
    // 24-H: THE READER — the first consumer of the terminal set that makes a
    // scheduling decision, and the reason 24-G's record is load-bearing rather
    // than merely observable.
    //
    // 24-G built a reader here and DELETED it, because disabling it killed
    // zero tests: `nextIndex` starts at `startIndex`, so the worker loop never
    // dispatches an item BELOW the ordered prefix, and the cursor subsumed the
    // skip entirely. This reader is not that one. It covers the case the
    // cursor provably cannot reach — an item that completed OUT OF ORDER, past
    // the prefix (index 3 completing after index 2 failed). The prefix stops at
    // 2; index 3 is dispatched again on every resume.
    //
    // What that re-dispatch costs is MONEY, not correctness of the aggregate.
    // 24-F advances `attempt` whenever a resumed frame carries economics, so
    // the replay reserves under a DIFFERENT id than the settled attempt
    // (`…:item:3` then `…:item:3:attempt:1`) and no host-side idempotency key
    // can collapse the two. The item settles twice for one unit of work.
    //
    // Skipping is CONDITIONAL on the item's aggregate contribution still being
    // reconstructible — `restoreSettledItem` returns false when it is not, and
    // the item then falls through and is dispatched normally. Both shapes are
    // real: a multi-body-node item keeps a retained frame holding its results,
    // while a single-body-node item leaves no frame at all and its collected
    // value can be genuinely unrecoverable. Skipping unconditionally would fix
    // the double charge by corrupting the aggregate to `[a, b, c, undefined]`,
    // which is a strictly worse trade. See `restoreSettledItem`.
    //
    // Gated on `completed` alone, never on `isTerminalItemOutcome`: a `failed`,
    // `cancelled` or `denied` item released its reservation and genuinely owes
    // another attempt, and `outcome_unknown` is not terminal at all. Only a
    // `completed` item was charged, and only a charged item must not be charged
    // again. Absence stays unprovable — an item with no record is dispatched
    // normally, so pre-24-G checkpoints keep resuming unchanged.
    const priorOutcome = resume?.itemOutcomes?.[String(index)];
    if (priorOutcome?.outcome === "completed") {
      if (await restoreSettledItem(index)) return;
    }

    const iteration = index + 1;
    const iterStart = Date.now();
    onEvent?.({
      type: "pipeline:loop_iteration",
      nodeId: loopNode.id,
      iteration,
      maxIterations: items.length,
    });

    const iterationState = {
      ...context.state,
      [contract.as]: items[index],
    };
    const iterationPreviousResults = new Map(context.previousResults);
    let lastBodyResult: NodeResult | undefined;
    let completedBody = true;

    // E3 mid-item resume: a crash part-way through this item must not re-run
    // the body nodes that already committed. `itemResume` applies only to the
    // one item the checkpoint was taken in — every later item starts at body
    // node 0 with no retained results.
    const itemResume = resume?.itemFrames?.[String(index)];
    const startBodyNodeIndex = itemResume?.nextBodyNodeIndex ?? 0;
    // Restore predecessors' outputs rather than re-executing to rebuild them.
    if (itemResume?.bodyResults !== undefined) {
      for (const [nodeId, result] of Object.entries(itemResume.bodyResults)) {
        iterationPreviousResults.set(nodeId, result as NodeResult);
      }
    }
    // The attempt counter makes a re-dispatch of this item distinguishable
    // from its first attempt in both the ledger and the derived key.
    //
    // 24-F: a resumed frame that durably recorded a reservation proves a
    // PREVIOUS attempt already opened a ledger row under the id this attempt
    // number derives. Reusing the number would re-present that exact id to the
    // host, so a host treating it as an idempotency key would silently reuse
    // the dead attempt's row — charging the new work against a reservation
    // that was already released, or double-opening one that was not. Advancing
    // the counter is what makes the replay distinguishable.
    //
    // Gated on `economics` rather than on the frame alone: without a budget
    // host no reservation exists, nothing durable can collide, and advancing
    // would needlessly change the item's idempotency keys on every resume.
    const resumedAttempt = itemResume?.attempt ?? 0;
    const attempt =
      itemResume?.economics === undefined ? resumedAttempt : resumedAttempt + 1;
    // Body results retained for a mid-item checkpoint, accumulated as we go.
    const retainedBodyResults: Record<string, NodeResult> = {
      ...((itemResume?.bodyResults ?? {}) as Record<string, NodeResult>),
    };

    // F: admit this item's ceiling BEFORE its first body node dispatches, so a
    // reservation that cannot be authorized never spends. `held` is the single
    // source of truth for whether a reservation is outstanding, and every one
    // of the three exits below reconciles it exactly once.
    const held = await reserveItem(index, attempt, iterationState);
    // G2b exit 0 — the reserve threw, so whether the host holds a reservation
    // is unknown. Reconciliation is the only thing that can clear it; until it
    // does, the item neither releases nor redispatches and the loop stops.
    if (typeof held === "object" && held !== null && "outcomeUnknown" in held) {
      const blocked = await reconcileUnknownReservation(
        index,
        attempt,
        held.outcomeUnknown,
        "reserve"
      );
      if (blocked !== undefined) {
        budgetBreached = true;
        firstError ??= {
          nodeId: loopNode.id,
          output: null,
          durationMs: Date.now() - startTime,
          error: blocked,
        };
        // 24-G exit 0. The reservation's state could not be proven, so this is
        // `outcome_unknown` and NOT terminal — `isTerminalItemOutcome` excludes
        // it deliberately, because accounting must not close over an
        // outstanding ledger row. It is still recorded: an unproven reservation
        // is the one an operator most needs a durable pointer to, and leaving
        // it absent would erase the only trace of the stranded row.
        //
        // No economics is attached: `held` is the marker object here, not a
        // reservation, so there is no id or amount the loop can honestly claim.
        await recordTerminalOutcome(index, "outcome_unknown", undefined);
        iterationDurations[index] = Date.now() - iterStart;
        return;
      }
      // Reconciliation PROVED the reservation is gone (released or never
      // created), so nothing is outstanding for this item. It is now a clean
      // denial: the item still must not dispatch unpriced, but the loop is no
      // longer blocked on an unresolved reservation.
      budgetBreached = true;
      firstError ??= {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" item ${index} budget is unknown: ` +
          "its reservation failed and was reconciled as not outstanding",
      };
      // 24-G exit 0b. Reconciliation proved nothing is outstanding, so unlike
      // the branch above this IS terminal — the item never dispatched and holds
      // no reservation.
      await recordTerminalOutcome(index, "denied", undefined);
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }
    if (held === "denied") {
      // The ceiling was authored but no authoritative reservation exists.
      // Fail closed: an unpriced item must not dispatch.
      budgetBreached = true;
      firstError ??= {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" item ${index} budget is unknown: ` +
          "no authoritative conservative reservation is available",
      };
      // 24-G exit 0b. A denied item never dispatched and opened no ledger row,
      // so it carries no economics. Recording a zero-cent reservation here
      // would assert a row that does not exist.
      await recordTerminalOutcome(index, "denied", undefined);
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }

    for (
      let bodyIndex = startBodyNodeIndex;
      bodyIndex < bodyNodes.length;
      bodyIndex++
    ) {
      const bodyNode = bodyNodes[bodyIndex] as PipelineNode;
      if (context.signal?.aborted) {
        completedBody = false;
        break;
      }
      let bodyResult: NodeResult;
      try {
        bodyResult = await nodeExecutor(bodyNode.id, bodyNode, {
          ...context,
          state: iterationState,
          previousResults: iterationPreviousResults,
          // E3: item identity reaches key derivation here. `attempt` is
          // omitted at 0 so a first-attempt key keeps the shortest scoped
          // form rather than gaining an `:attempt:0` segment.
          executionScope: {
            loopNodeId: loopNode.id,
            itemIndex: index,
            bodyNodeId: bodyNode.id,
            ...(attempt > 0 ? { attempt } : {}),
          },
        });
      } catch (error) {
        bodyResult = {
          nodeId: bodyNode.id,
          output: null,
          durationMs: Date.now() - iterStart,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      iterationPreviousResults.set(bodyNode.id, bodyResult);
      lastBodyResult = bodyResult;

      if (bodyResult.error) {
        firstError ??= {
          nodeId: loopNode.id,
          output: bodyResult.output,
          durationMs: Date.now() - startTime,
          error: `Loop body node "${bodyNode.id}" failed: ${bodyResult.error}`,
        };
        completedBody = false;
        break;
      }

      // Persist mid-item progress ONLY while the item is still in flight. The
      // last body node completing the item is an item boundary, and its cursor
      // is the ordered-prefix `iteration` advanced by `flushCompletedPrefix` —
      // emitting a frame there would contradict that cursor and break the
      // exact `toEqual({ iteration: n })` boundary pins.
      retainedBodyResults[bodyNode.id] = bodyResult;
      if (bodyIndex < bodyNodes.length - 1) {
        await resume?.onItemBodyNodeComplete?.({
          itemIndex: index,
          nextBodyNodeIndex: bodyIndex + 1,
          bodyResults: retainedBodyResults,
          ...(attempt > 0 ? { attempt } : {}),
          // 24-F: the item is mid-body with a reservation outstanding. Both
          // facts are process-local until written here, which is why a crash
          // at this exact point used to strand the ledger row.
          outcome: "running",
          ...(held === undefined ||
          typeof held === "string" ||
          "outcomeUnknown" in held
            ? {}
            : {
                economics: {
                  reservationId: held.reservationId,
                  reservedCostCents: held.reservedCostCents,
                },
              }),
        });
      }
    }

    if (!completedBody) {
      // F: exits 1 and 2 — aborted, or a body node failed. The item never
      // completed, so its reservation is returned in full rather than settled.
      // Leaking here is the original defect reproduced one level down.
      const releaseOutcome = await releaseItem(
        held,
        context.signal?.aborted === true ? "aborted" : "failed"
      );
      // G2d (prereq 7): a release that could not be observed leaves this item
      // in a non-terminal settlement state. Reconcile is the only proof; until
      // it answers, the loop stops rather than reporting a clean failure over
      // an unaccounted reservation.
      //
      // This OVERWRITES `firstError` rather than using `??=`, unlike every
      // other exit. The body error that triggered this release is already
      // recorded, but an unaccounted reservation is the strictly more severe
      // fact: a failed item is an expected outcome the author can handle,
      // whereas money in an unknown state is an operator-visible integrity
      // breach. Reporting the body error here would hide it.
      let releaseUnresolved = false;
      if (releaseOutcome !== undefined) {
        const blocked = await reconcileUnknownReservation(
          index,
          attempt,
          releaseOutcome.outcomeUnknown,
          "release"
        );
        if (blocked !== undefined) {
          releaseUnresolved = true;
          budgetBreached = true;
          firstError = {
            nodeId: loopNode.id,
            output: null,
            durationMs: Date.now() - startTime,
            error: blocked,
          };
        }
      }
      // 24-G exits 1 and 2. `aborted` and `failed` are kept distinct for the
      // same reason `denied` is: a cancelled item was stopped by a signal
      // while a failed one ran and its body reported an error, and an operator
      // reconciling work against spend needs to tell those apart.
      //
      // An unresolvable release outranks both. The item's work did stop, but
      // its reservation's state is unproven, and reporting a clean `failed`
      // over money in an unknown state is precisely what G2d fails closed on.
      // This mirrors the `firstError` overwrite directly above.
      await recordTerminalOutcome(
        index,
        releaseUnresolved
          ? "outcome_unknown"
          : context.signal?.aborted === true
          ? "cancelled"
          : "failed",
        // The reservation was released rather than settled, so it carries no
        // settled cost — a released reservation charged nothing.
        held === undefined ||
          typeof held === "string" ||
          "outcomeUnknown" in held
          ? undefined
          : held
      );
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }

    // F: exit 3 — the item completed. Reconcile actual spend against the
    // reservation, releasing the unspent delta. An overrun fails the loop
    // closed (operator decision, 08-16): the authored ceiling was breached.
    const overrun = await settleItem(held, retainedBodyResults);
    // G2d (prereq 7): the settle call itself was unobservable. The item's work
    // is DONE and was charged, so this is not a release path — refunding could
    // return money the host already took. Only reconciliation can prove the
    // reservation's terminal state, and until it does the loop fails closed.
    // 24-G: narrowed on the marker key rather than on `typeof === "object"`,
    // because a clean settle now also returns an object. Matching on the shape
    // alone would route every successful settlement into reconciliation.
    if (
      typeof overrun === "object" &&
      overrun !== null &&
      "outcomeUnknown" in overrun
    ) {
      const blocked = await reconcileUnknownReservation(
        index,
        attempt,
        overrun.outcomeUnknown,
        "settle"
      );
      if (blocked !== undefined) {
        budgetBreached = true;
        firstError ??= {
          nodeId: loopNode.id,
          output: lastBodyResult?.output ?? null,
          durationMs: Date.now() - startTime,
          error: blocked,
        };
        iterationDurations[index] = Date.now() - iterStart;
        return;
      }
      // Reconciliation PROVED the reservation is no longer outstanding, so the
      // item is terminally settled despite the unobservable call. Its work
      // completed successfully, so it counts as a completed item — fall
      // through to the normal completion path below.
    }
    if (typeof overrun === "string") {
      budgetBreached = true;
      firstError ??= {
        nodeId: loopNode.id,
        output: lastBodyResult?.output ?? null,
        durationMs: Date.now() - startTime,
        error: overrun,
      };
      // 24-G: the item's body succeeded but it settled past its authored
      // ceiling, which fails the loop closed. It is `failed` rather than
      // `completed`: the work finished, but the item did not complete within
      // the terms it was admitted under, and reporting `completed` would let
      // accounting close over a breach.
      await recordTerminalOutcome(
        index,
        "failed",
        held === undefined ||
          typeof held === "string" ||
          "outcomeUnknown" in held
          ? undefined
          : held
      );
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }

    // 24-G exit 3. The item completed and settled, so its economics is
    // terminal too — this is the only exit that records a settled cost.
    await recordTerminalOutcome(
      index,
      "completed",
      held === undefined || typeof held === "string" || "outcomeUnknown" in held
        ? undefined
        : held,
      typeof overrun === "object" &&
        overrun !== null &&
        "settledCostCents" in overrun
        ? overrun.settledCostCents
        : undefined
    );

    results[index] = lastBodyResult;
    if (contract.collect !== undefined) {
      collected[index] = collectIterationValue(
        iterationState,
        iterationPreviousResults,
        contract.collect.from
      );
    }
    merge.attachedValues[index] = iterationState[contract.as];
    merge.accumulatorItems[index] = iterationState[contract.as];
    iterationDurations[index] = Date.now() - iterStart;
    completed[index] = true;
    flushQueue = flushQueue.then(flushCompletedPrefix);
    await flushQueue;
  };

  const flushCompletedPrefix = async (): Promise<void> => {
    // The merge itself is synchronous and lives in `for-each-merge.ts`; only
    // the publish-and-checkpoint tail below is async. A zero return means the
    // cursor did not move, and no checkpoint may be written for it.
    const retired = advanceCompletedPrefix(merge, contract);
    if (retired === 0) return;

    if (contract.collect !== undefined) {
      setStatePath(
        context.state,
        contract.collect.into,
        collected.slice(0, merge.flushedPrefix)
      );
    }
    if (contract.attachAs !== undefined) {
      setStatePath(context.state, contract.source, merge.enrichedItems);
    }
    if (contract.accumulator !== undefined) {
      setStatePath(
        context.state,
        contract.accumulator.key,
        merge.accumulatorValues
      );
    }
    await resume?.onIterationComplete?.(merge.flushedPrefix);
  };

  const workers = Array.from({ length: concurrency }, async () => {
    while (
      !(contract.failFast === true && firstError !== undefined) &&
      !budgetBreached &&
      !context.signal?.aborted
    ) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await runIteration(index);
    }
  });
  await Promise.all(workers);
  await flushQueue;
  await flushCompletedPrefix();

  // 24-G (doc 27 §8 proof 8): complete the terminal set.
  //
  // The worker loop stops on `failFast`/`budgetBreached`/`aborted`, leaving
  // every index at or beyond `nextIndex` never visited — no frame, no outcome,
  // `iterationDurations` left undefined. Those items were ABSENT rather than
  // terminal, which is why "every index in 0..n-1 has a terminal outcome" was
  // not assertable at all: absence is indistinguishable from a producer that
  // simply failed to write.
  //
  // `cancelled` is the vocabulary for "terminal for this run, but it never
  // ran". These items took no reservation, so they carry no economics —
  // recording one would assert a ledger row that was never opened.
  //
  // Ordered by index so the durable record reads in source order regardless of
  // the order items were abandoned in.
  for (let index = 0; index < items.length; index++) {
    if (terminalOutcomes.has(index)) continue;
    // Items behind the resumed start index were settled by an earlier run,
    // which already recorded their outcomes. Re-recording them here would
    // overwrite a `completed` with a `cancelled` on every resume.
    if (index < startIndex) continue;
    await recordTerminalOutcome(index, "cancelled", undefined);
  }

  const completedIterations = iterationDurations.filter(
    (duration): duration is number => duration !== undefined
  ).length;

  if (firstError !== undefined) {
    const partialCollected = collected.filter(
      (_value, index) => completed[index] === true
    );
    const partialEnrichedItems = enrichedItems.filter(
      (_value, index) => completed[index] === true
    );
    return {
      result: {
        ...firstError,
        output: forEachOutput(
          contract,
          partialCollected,
          partialEnrichedItems,
          merge.accumulatorValues,
          firstError.output
        ),
      },
      metrics: {
        iterationCount: completedIterations,
        iterationDurations: iterationDurations.filter(
          (duration): duration is number => duration !== undefined
        ),
        converged: false,
        terminationReason: "condition_met",
      },
    };
  }

  if (context.signal?.aborted) {
    return {
      result: {
        nodeId: loopNode.id,
        output: forEachOutput(
          contract,
          collected.slice(0, completedIterations),
          enrichedItems,
          merge.accumulatorValues,
          null
        ),
        durationMs: Date.now() - startTime,
      },
      metrics: {
        iterationCount: completedIterations,
        iterationDurations: iterationDurations.filter(
          (duration): duration is number => duration !== undefined
        ),
        converged: false,
        terminationReason: "cancelled",
      },
    };
  }

  if (contract.collect !== undefined) {
    setStatePath(context.state, contract.collect.into, collected);
  }
  if (contract.attachAs !== undefined) {
    setStatePath(context.state, contract.source, enrichedItems);
  }
  if (contract.accumulator !== undefined) {
    setStatePath(
      context.state,
      contract.accumulator.key,
      merge.accumulatorValues
    );
  }
  for (const result of results) {
    if (result !== undefined)
      context.previousResults.set(result.nodeId, result);
  }
  onEvent?.(forEachAggregateEvent(loopNode.id, items.length, false, contract));

  const totalDuration = Date.now() - startTime;
  return {
    result: {
      nodeId: loopNode.id,
      output: forEachOutput(
        contract,
        collected,
        enrichedItems,
        merge.accumulatorValues,
        results[results.length - 1]?.output ?? null
      ),
      durationMs: totalDuration,
    },
    metrics: {
      iterationCount: items.length,
      iterationDurations,
      converged: true,
      terminationReason: "condition_met",
    },
  };
}

function collectIterationValue(
  state: Record<string, unknown>,
  previousResults: Map<string, NodeResult>,
  from: string
): unknown {
  const resolved = resolveStatePath(state, from);
  if (resolved.found) return resolved.value;
  return previousResults.get(from)?.output;
}

function forEachOutput(
  contract: ForEachContract,
  collected: unknown[],
  enrichedItems: unknown[],
  accumulatorValues: unknown[],
  fallback: unknown
): unknown {
  if (contract.collect !== undefined) return collected;
  if (contract.attachAs !== undefined) return enrichedItems;
  if (contract.accumulator !== undefined) return accumulatorValues;
  return fallback;
}

function initialAccumulatorValue(
  state: Record<string, unknown>,
  accumulator: NonNullable<ForEachContract["accumulator"]>
): unknown[] {
  const existing = resolveStatePath(state, accumulator.key);
  if (Array.isArray(existing.value)) return [...existing.value];
  if (Array.isArray(accumulator.initialValue)) {
    return [...accumulator.initialValue];
  }
  if (accumulator.initialValue === undefined) return [];
  return [accumulator.initialValue];
}

function forEachAggregateEvent(
  nodeId: string,
  count: number,
  empty: boolean,
  contract: ForEachContract
): PipelineRuntimeEvent {
  const aggregateKeys = forEachAggregateKeys(contract);
  return {
    type: "pipeline:for_each_aggregate",
    nodeId,
    ...(contract.collect !== undefined
      ? { aggregateKey: contract.collect.into }
      : {}),
    ...(aggregateKeys.length > 0 ? { aggregateKeys } : {}),
    source: contract.source,
    ...(contract.attachAs !== undefined ? { attachAs: contract.attachAs } : {}),
    ...(contract.accumulator !== undefined
      ? { accumulatorKey: contract.accumulator.key }
      : {}),
    count,
    order: "input",
    empty,
  };
}

function forEachAggregateKeys(contract: ForEachContract): string[] {
  const keys: string[] = [];
  if (contract.collect !== undefined) keys.push(contract.collect.into);
  if (contract.attachAs !== undefined) {
    keys.push(`${contract.source}.${contract.attachAs}`);
  }
  if (contract.accumulator !== undefined) keys.push(contract.accumulator.key);
  return keys;
}
