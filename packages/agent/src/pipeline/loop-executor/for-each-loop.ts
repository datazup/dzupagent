/**
 * for_each loop executor — runs body nodes once per item of a resolved
 * array source, with bounded concurrency, ordered prefix flushing,
 * optional collect/attach/accumulator aggregation, and durable resume.
 *
 * @module pipeline/loop-executor/for-each-loop
 */

import type { LoopNode, PipelineNode } from "@dzupagent/core/pipeline";
import type {
  NodeExecutor,
  NodeExecutionContext,
  NodeResult,
  PipelineRuntimeEvent,
  LoopMetrics,
} from "../pipeline-runtime-types.js";
import type { LoopResumeOptions } from "./types.js";
import { resolveStatePath, setStatePath } from "./state-path.js";

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
  let accumulatorValues =
    contract.accumulator !== undefined
      ? initialAccumulatorValue(context.state, contract.accumulator)
      : [];
  if (contract.accumulator !== undefined) {
    setStatePath(context.state, contract.accumulator.key, accumulatorValues);
  }
  const results = new Array<NodeResult | undefined>(items.length);
  const completed = new Array<boolean>(items.length).fill(false);
  const attachedValues = new Array<unknown>(items.length);
  const accumulatorItems = new Array<unknown>(items.length);
  let nextIndex = startIndex;
  let flushedPrefix = startIndex;
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
    return outcome.status === "released" || outcome.status === "absent"
      ? undefined
      : blocked;
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
  ): Promise<string | undefined | { outcomeUnknown: string }> => {
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
        outcomeUnknown:
          error instanceof Error ? error.message : String(error),
      };
    }
    return actualCostCents > held.reservedCostCents
      ? `Loop "${loopNode.id}" item ${held.itemIndex} settled ${actualCostCents} cents, ` +
          `exceeding its ${held.reservedCostCents}-cent reservation`
      : undefined;
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
        outcomeUnknown:
          error instanceof Error ? error.message : String(error),
      };
    }
    return undefined;
  };

  const runIteration = async (index: number): Promise<void> => {
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
    const attempt = itemResume?.attempt ?? 0;
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
      if (releaseOutcome !== undefined) {
        const blocked = await reconcileUnknownReservation(
          index,
          attempt,
          releaseOutcome.outcomeUnknown,
          "release"
        );
        if (blocked !== undefined) {
          budgetBreached = true;
          firstError = {
            nodeId: loopNode.id,
            output: null,
            durationMs: Date.now() - startTime,
            error: blocked,
          };
        }
      }
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
    if (typeof overrun === "object" && overrun !== null) {
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
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }

    results[index] = lastBodyResult;
    if (contract.collect !== undefined) {
      collected[index] = collectIterationValue(
        iterationState,
        iterationPreviousResults,
        contract.collect.from
      );
    }
    attachedValues[index] = iterationState[contract.as];
    accumulatorItems[index] = iterationState[contract.as];
    iterationDurations[index] = Date.now() - iterStart;
    completed[index] = true;
    flushQueue = flushQueue.then(flushCompletedPrefix);
    await flushQueue;
  };

  const flushCompletedPrefix = async (): Promise<void> => {
    let advanced = false;
    while (completed[flushedPrefix]) {
      if (contract.attachAs !== undefined) {
        enrichedItems[flushedPrefix] = attachIterationValue(
          enrichedItems[flushedPrefix],
          contract.attachAs,
          attachedValues[flushedPrefix]
        );
      }
      if (contract.accumulator !== undefined) {
        accumulatorValues = appendAccumulatorValue(
          accumulatorValues,
          accumulatorItems[flushedPrefix],
          contract.accumulator.window
        );
      }
      flushedPrefix++;
      advanced = true;
    }

    if (!advanced) return;

    if (contract.collect !== undefined) {
      setStatePath(
        context.state,
        contract.collect.into,
        collected.slice(0, flushedPrefix)
      );
    }
    if (contract.attachAs !== undefined) {
      setStatePath(context.state, contract.source, enrichedItems);
    }
    if (contract.accumulator !== undefined) {
      setStatePath(context.state, contract.accumulator.key, accumulatorValues);
    }
    await resume?.onIterationComplete?.(flushedPrefix);
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
          accumulatorValues,
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
          accumulatorValues,
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
    setStatePath(context.state, contract.accumulator.key, accumulatorValues);
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
        accumulatorValues,
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

function appendAccumulatorValue(
  values: unknown[],
  value: unknown,
  window?: number
): unknown[] {
  const next = [...values, value];
  return window === undefined ? next : next.slice(-window);
}

function attachIterationValue(
  item: unknown,
  attachAs: string,
  value: unknown
): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return item;
  }
  return { ...(item as Record<string, unknown>), [attachAs]: value };
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
