/**
 * for_each loop executor — runs body nodes once per item of a resolved
 * array source, with bounded concurrency, ordered prefix flushing,
 * optional collect/attach/accumulator aggregation, and durable resume.
 *
 * @module pipeline/loop-executor/for-each-loop
 */

import type { PipelineForEachItemOutcome } from "@dzupagent/core/pipeline";
import type { LoopNode, PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type {
  NodeExecutor,
  NodeExecutionContext,
  NodeResult,
  PipelineRuntimeEvent,
  LoopMetrics,
} from "../pipeline-runtime-types.js";
import type {
  LoopResumeOptions,
} from "./types.js";
import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import type { LoopEconomicsEvidenceV1 } from "@dzupagent/runtime-contracts/loop-economics-evidence";
import { resolveStatePath, setStatePath } from "./state-path.js";
import {
  advanceCompletedPrefix,
  type ForEachMergeState,
} from "./for-each-merge.js";
import { createItemBudgetLifecycle } from "./for-each-item-budget.js";
import {
  deriveItemReservationId,
  type HeldItemReservation,
} from "./for-each-reservation.js";

// Re-exported for the direct unit test that pins the reservation-id wire format.
export { deriveItemReservationId } from "./for-each-reservation.js";

const FOR_EACH_AGGREGATE_RECEIPT_V1 =
  "dzupagent/for-each-aggregate-receipt/v1" as const;

interface ForEachKnownValue {
  readonly status: "known";
  readonly value?: unknown;
}

interface ForEachAggregateReceiptV1 {
  readonly schema: typeof FOR_EACH_AGGREGATE_RECEIPT_V1;
  readonly loopNodeId: string;
  readonly itemIndex: number;
  readonly itemValue: ForEachKnownValue;
  readonly collectedValue?: ForEachKnownValue;
  readonly finalBodyResult: {
    readonly nodeId: string;
    readonly output: ForEachKnownValue;
  };
}

/**
 * The loop node cannot be one of its own admitted leaf body nodes, so its id is
 * a collision-free slot in the durable `bodyResults` record. Keeping the
 * receipt inside that already-serialized record avoids widening the core
 * checkpoint schema while the checkpoint's root definition digest, loop id,
 * source digest and item-index key bind the receipt to its definition.
 */
function aggregateReceiptResult(
  loopNodeId: string,
  itemIndex: number,
  itemValue: unknown,
  collectedValue: ForEachKnownValue | undefined,
  finalBodyResult: NodeResult
): NodeResult {
  const receipt: ForEachAggregateReceiptV1 = {
    schema: FOR_EACH_AGGREGATE_RECEIPT_V1,
    loopNodeId,
    itemIndex,
    itemValue: { status: "known", value: itemValue },
    ...(collectedValue === undefined ? {} : { collectedValue }),
    finalBodyResult: {
      nodeId: finalBodyResult.nodeId,
      output: { status: "known", value: finalBodyResult.output },
    },
  };
  return { nodeId: loopNodeId, output: receipt, durationMs: 0 };
}

function readAggregateReceipt(
  loopNodeId: string,
  itemIndex: number,
  itemValue: unknown,
  bodyResults: Readonly<Record<string, NodeResult>> | undefined
): ForEachAggregateReceiptV1 | undefined {
  const receiptResult = bodyResults?.[loopNodeId];
  if (receiptResult?.nodeId !== loopNodeId) return undefined;
  const candidate = receiptResult.output;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as Partial<ForEachAggregateReceiptV1>;
  const collected = record.collectedValue;
  const final = record.finalBodyResult;
  if (
    record.schema !== FOR_EACH_AGGREGATE_RECEIPT_V1 ||
    record.loopNodeId !== loopNodeId ||
    record.itemIndex !== itemIndex ||
    record.itemValue?.status !== "known" ||
    (collected !== undefined && collected.status !== "known") ||
    typeof final !== "object" ||
    final === null ||
    typeof final.nodeId !== "string" ||
    final.nodeId.length === 0 ||
    typeof final.output !== "object" ||
    final.output === null ||
    final.output.status !== "known"
  ) {
    return undefined;
  }
  try {
    if (
      canonicalInputDigest(record.itemValue.value) !==
      canonicalInputDigest(itemValue)
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return record as ForEachAggregateReceiptV1;
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
  if (
    bodyNodes.length === 0 ||
    bodyNodes.some((bodyNode) => bodyNode.id === loopNode.id)
  ) {
    return {
      result: {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" for_each body must contain at least one ` +
          "leaf node and cannot contain the loop itself",
      },
      metrics: {
        iterationCount: 0,
        iterationDurations: [],
        converged: false,
        terminationReason: "condition_met",
      },
    };
  }
  // 24-I: concurrency > 1 is admitted. The value must still be a positive
  // integer — a fractional or non-positive value is an authoring error, not a
  // degenerate-but-runnable contract, and silently clamping it would run a
  // pipeline at a concurrency its author never wrote.
  if (
    !Number.isInteger(contract.concurrency) ||
    (contract.concurrency as number) < 1
  ) {
    return {
      result: {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" for_each concurrency must be a positive ` +
          `integer; received ${String(contract.concurrency)}`,
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
  // 24-I: the flag is still read by the worker loop between items, but that is
  // no longer sufficient on its own. At concurrency > 1 up to N-1 items are
  // already mid-flight with reservations outstanding when a breach is
  // observed, and each would keep dispatching body nodes and settling spend
  // past it. `stopDispatch` below propagates the breach INTO those items.
  let budgetBreached = false;

  // 24-I: an internal stop signal, deliberately NOT merged into
  // `context.signal`. Three sites classify an item's terminal outcome as
  // `aborted` by reading `context.signal?.aborted` (see the `recordTerminal`
  // calls below and the post-loop reason); routing a budget breach through
  // that signal would relabel a breach as a host cancellation and lose the
  // distinction 24-G's terminal set exists to record. In-flight items observe
  // this separately and stop as `budget_breached`.
  const dispatchStop = new AbortController();
  const stopDispatch = (): void => {
    if (!dispatchStop.signal.aborted) dispatchStop.abort();
  };
  /**
   * True once dispatch must stop, from either a budget breach or a host
   * abort.
   *
   * The host signal is POLLED here rather than subscribed to with
   * `addEventListener`. This package compiles with `lib: ["ES2023"]` and no
   * DOM lib, so `AbortSignal`'s event methods are not typed; polling composes
   * the two sources with no listener to register, no `once` semantics to get
   * wrong, and nothing to unsubscribe when the loop returns. Every consumer
   * is already a gate check inside a loop, so a poll is exactly as prompt as
   * a callback would be.
   */
  const dispatchHalted = (): boolean =>
    dispatchStop.signal.aborted || context.signal?.aborted === true;

  /**
   * 24-I: the ONLY way to record a breach. Setting `budgetBreached` without
   * halting dispatch is what let in-flight items spend past a ceiling at N>1,
   * so the two are coupled here rather than left to six call sites to
   * remember.
   */
  const breachBudget = (): void => {
    budgetBreached = true;
    stopDispatch();
  };
  let flushQueue = Promise.resolve();

  // F: per-item economic settlement. The `forEach` compile-time contract has
  // no budget field, so the ceiling is host-authored via `itemBudgetCents`.
  // When it is absent, `for_each` takes no reservation and all three helpers
  // are inert — byte-identical to the pre-F behaviour.
  const itemBudgetCents = resume?.itemBudgetCents;
  if (
    itemBudgetCents !== undefined &&
    (resume?.budgetMode !== "strict" ||
      !Number.isSafeInteger(itemBudgetCents) ||
      itemBudgetCents < 0 ||
      resume.reserveIterationBudget === undefined ||
      resume.settleIterationBudget === undefined ||
      resume.releaseIterationBudget === undefined ||
      resume.reconcileIterationBudget === undefined ||
      resume.measureItemCost === undefined)
  ) {
    return {
      result: {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" hard item ceiling requires a strict budget ` +
          "host with a non-negative integer ceiling and reserve/settle/" +
          "release/reconcile/measureItemCost lifecycle",
      },
      metrics: {
        iterationCount: 0,
        iterationDurations: [],
        converged: false,
        terminationReason: "condition_met",
      },
    };
  }
  const {
    reserveItem,
    validateRetainedItemEconomics,
    reconcileUnknownReservation,
    settleItem,
    releaseItem,
    readReconciledSettledCost,
    resolveUnknownRelease,
    resolveUnknownSettlement,
  } = createItemBudgetLifecycle({
    loopNode,
    bodyNodes,
    itemBudgetCents,
    resume,
  });

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
              ...(held.evidence === undefined
                ? {}
                : { evidence: held.evidence }),
            },
          }),
      ...(held !== undefined && held.attempt > 0
        ? { attempt: held.attempt }
        : {}),
    });
  };

  /**
   * Persist the item's exact aggregate contribution at the body-complete
   * boundary. The same frame is first written as `running` before settlement
   * and then as `completed` with settled economics. Consequently a crash on
   * either side of the host call retains enough output to reconcile without
   * dispatching the body again.
   */
  const checkpointAggregateReceipt = async (input: {
    index: number;
    attempt: number;
    outcome: "running" | "completed";
    held: HeldItemReservation | undefined;
    settledCostCents?: number;
    bodyResults: Readonly<Record<string, NodeResult>>;
  }): Promise<void> => {
    await resume?.onItemBodyNodeComplete?.({
      itemIndex: input.index,
      nextBodyNodeIndex: bodyNodes.length,
      bodyResults: input.bodyResults,
      ...(input.attempt > 0 ? { attempt: input.attempt } : {}),
      outcome: input.outcome,
      ...(input.held === undefined
        ? {}
        : {
            economics: {
              reservationId: input.held.reservationId,
              reservedCostCents: input.held.reservedCostCents,
              ...(input.settledCostCents === undefined
                ? {}
                : { settledCostCents: input.settledCostCents }),
              ...(input.held.evidence === undefined
                ? {}
                : { evidence: input.held.evidence }),
            },
          }),
    });
  };

  /**
   * Restore a durably completed item without dispatching its body.
   *
   * Completion is accepted only from the body-complete frame written by this
   * executor and its validated aggregate/output receipt. A missing or corrupt
   * receipt, or any other body cursor, returns `false`; the caller fails closed
   * and never converts uncertain completion into a duplicate effect or charge.
   * The same representation covers single- and multi-body items.
   */
  const restoreSettledItem = async (index: number): Promise<boolean> => {
    const frame = resume?.itemFrames?.[String(index)];
    if (
      frame?.outcome !== "completed" ||
      frame.nextBodyNodeIndex !== bodyNodes.length
    ) {
      return false;
    }
    const receipt = readAggregateReceipt(
      loopNode.id,
      index,
      items[index],
      frame?.bodyResults
    );
    if (receipt === undefined) return false;
    if (contract.collect !== undefined) {
      if (receipt.collectedValue === undefined) return false;
      collected[index] = receipt.collectedValue.value;
    }
    const itemValue = receipt.itemValue.value;
    merge.attachedValues[index] = itemValue;
    merge.accumulatorItems[index] = itemValue;
    results[index] = {
      nodeId: receipt.finalBodyResult.nodeId,
      output: receipt.finalBodyResult.output.value,
      durationMs: 0,
    };
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
    // A completed frame or terminal outcome is a permanent no-redispatch
    // boundary, including when it lies beyond the ordered prefix. Restoration
    // requires the exact durable aggregate receipt; missing/corrupt evidence
    // fails closed. Failed/cancelled/denied outcomes remain retryable only when
    // they carry no settled charge. An outcome_unknown stays blocked unless a
    // body-complete receipt identifies the recoverable settle boundary below.
    const itemResume = resume?.itemFrames?.[String(index)];
    const priorOutcome = resume?.itemOutcomes?.[String(index)];
    const retainedCandidates = [
      itemResume?.economics === undefined
        ? undefined
        : {
            attempt: itemResume.attempt ?? 0,
            economics: itemResume.economics,
          },
      priorOutcome?.economics === undefined
        ? undefined
        : {
            attempt: priorOutcome.attempt ?? 0,
            economics: priorOutcome.economics,
          },
    ].filter((candidate) => candidate !== undefined);
    let retainedEconomicsError: string | undefined;
    if (
      itemBudgetCents !== undefined &&
      resume?.budgetEvidenceMode === "required" &&
      retainedCandidates.length === 0 &&
      ((itemResume?.nextBodyNodeIndex ?? 0) > 0 ||
        priorOutcome?.outcome === "completed")
    ) {
      retainedEconomicsError =
        "evidence-required resume state contains durable work without reservation economics";
    }
    for (const candidate of retainedCandidates) {
      retainedEconomicsError ??= validateRetainedItemEconomics(
        index,
        candidate.attempt,
        candidate.economics
      );
    }
    if (
      retainedEconomicsError === undefined &&
      retainedCandidates.length === 2
    ) {
      try {
        if (
          canonicalInputDigest(retainedCandidates[0]!.economics) !==
          canonicalInputDigest(retainedCandidates[1]!.economics)
        ) {
          retainedEconomicsError =
            "item frame and terminal outcome carry different economics evidence";
        }
      } catch {
        retainedEconomicsError =
          "retained economics evidence is not canonically serializable";
      }
    }
    if (retainedEconomicsError !== undefined) {
      terminalOutcomes.add(index);
      breachBudget();
      firstError ??= {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" item ${index} checkpoint exact economics ` +
          `evidence is invalid: ${retainedEconomicsError}; redispatch is blocked`,
      };
      return;
    }
    if (
      priorOutcome?.outcome !== "completed" &&
      priorOutcome?.economics?.settledCostCents !== undefined
    ) {
      // A failed/cancelled/denied attempt that was nevertheless charged must
      // never become a retry candidate. The terminal set lacks a dedicated
      // "failed-but-charged" tag, so retain its exact economics and stop here.
      terminalOutcomes.add(index);
      breachBudget();
      firstError ??= {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" item ${index} is terminal with a settled ` +
          `charge of ${priorOutcome.economics.settledCostCents} cents; ` +
          "redispatch is blocked",
      };
      return;
    }
    if (
      priorOutcome?.outcome === "outcome_unknown" &&
      itemResume?.nextBodyNodeIndex !== bodyNodes.length
    ) {
      // Without a body-complete receipt the checkpoint does not retain which
      // lifecycle boundary became unobservable. Re-dispatching would guess
      // that an earlier reserve/release left no live money, so keep the item
      // blocked for operator reconciliation. Body-complete settle recovery is
      // the one distinguishable case and continues below.
      terminalOutcomes.add(index);
      breachBudget();
      firstError ??= {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" item ${index} has a durable outcome-unknown ` +
          "reservation without a body-complete receipt; redispatch is blocked",
      };
      return;
    }
    const frameCompleted = itemResume?.outcome === "completed";
    if (priorOutcome?.outcome === "completed" || frameCompleted) {
      terminalOutcomes.add(index);
      if (frameCompleted && priorOutcome?.outcome !== "completed") {
        const economics = itemResume.economics;
        const held =
          economics === undefined
            ? undefined
            : {
                itemIndex: index,
                attempt: itemResume.attempt ?? 0,
                reservationId: economics.reservationId,
                reservedCostCents: economics.reservedCostCents,
                ...(economics.evidence === undefined
                  ? {}
                  : { evidence: economics.evidence }),
              };
        await recordTerminalOutcome(
          index,
          "completed",
          held,
          economics?.settledCostCents
        );
      }
      if (await restoreSettledItem(index)) return;
      // A completed item is never a redispatch candidate. A checkpoint written
      // before aggregate receipts existed may be unreconstructible (notably a
      // single-body collect-from-state item); fail closed rather than repeat
      // its effects or charge it again.
      breachBudget();
      firstError ??= {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" item ${index} is durably completed but its ` +
          "aggregate/output receipt is missing or corrupt; redispatch is blocked",
      };
      return;
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
    // 24-I: true only when THIS item stopped at the dispatch gate rather than
    // because its own body node errored. Both leave `completedBody` false, but
    // they are different terminal outcomes, and at N>1 a body error in one
    // item halts the others — so the halt flag alone cannot classify them.
    let haltedBeforeBody = false;

    // E3 mid-item resume: a crash part-way through this item must not re-run
    // the body nodes that already committed. `itemResume` applies only to the
    // one item the checkpoint was taken in — every later item starts at body
    // node 0 with no retained results.
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
    // Body results retained for a mid-item checkpoint, accumulated as we go.
    const retainedBodyResults: Record<string, NodeResult> = {
      ...((itemResume?.bodyResults ?? {}) as Record<string, NodeResult>),
    };

    const preparedReceipt = readAggregateReceipt(
      loopNode.id,
      index,
      items[index],
      itemResume?.bodyResults
    );
    if (startBodyNodeIndex >= bodyNodes.length) {
      const blockPreparedCompletion = async (
        reason: string,
        outcome: PipelineForEachItemOutcome = "outcome_unknown",
        settledCostCents?: number,
        terminalEvidence?: LoopEconomicsEvidenceV1
      ): Promise<void> => {
        breachBudget();
        firstError ??= {
          nodeId: loopNode.id,
          output: preparedReceipt?.finalBodyResult?.output.value ?? null,
          durationMs: Date.now() - startTime,
          error:
            `Loop "${loopNode.id}" item ${index} has completed body work that ` +
            `cannot be settled safely: ${reason}; redispatch is blocked`,
        };
        const economics = itemResume?.economics;
        await recordTerminalOutcome(
          index,
          outcome,
          economics === undefined
            ? undefined
            : {
                itemIndex: index,
                attempt: resumedAttempt,
                reservationId: economics.reservationId,
                reservedCostCents: economics.reservedCostCents,
                ...((terminalEvidence ?? economics.evidence) === undefined
                  ? {}
                  : { evidence: terminalEvidence ?? economics.evidence }),
              },
          settledCostCents ?? economics?.settledCostCents
        );
        iterationDurations[index] = Date.now() - iterStart;
      };

      if (
        startBodyNodeIndex !== bodyNodes.length ||
        preparedReceipt === undefined
      ) {
        await blockPreparedCompletion(
          "its aggregate/output receipt is missing, corrupt, or has an invalid body cursor"
        );
        return;
      }

      const receiptBodyResults = Object.fromEntries(
        Object.entries(retainedBodyResults).filter(
          ([nodeId]) => nodeId !== loopNode.id
        )
      );
      const economics = itemResume?.economics;
      if (economics === undefined) {
        if (itemBudgetCents !== undefined) {
          await blockPreparedCompletion(
            "the strict ceiling receipt has no reservation economics"
          );
          return;
        }
        await checkpointAggregateReceipt({
          index,
          attempt: resumedAttempt,
          outcome: "completed",
          held: undefined,
          bodyResults: retainedBodyResults,
        });
        await recordTerminalOutcome(index, "completed", undefined);
        if (!(await restoreSettledItem(index))) {
          await blockPreparedCompletion("its durable aggregate could not be restored");
        }
        return;
      }

      let resumedHeld: HeldItemReservation = {
        itemIndex: index,
        attempt: resumedAttempt,
        reservationId: economics.reservationId,
        reservedCostCents: economics.reservedCostCents,
        ...(economics.evidence === undefined
          ? {}
          : { evidence: economics.evidence }),
      };
      const reconciliation = await reconcileUnknownReservation(
        index,
        resumedAttempt,
        "resume of a durable body-complete aggregate receipt",
        "settle",
        resumedHeld
      );

      let settledCostCents: number | undefined;
      let settledEvidence: LoopEconomicsEvidenceV1 | undefined;
      let settlementOverrun: string | undefined;
      if (reconciliation.status === "settled") {
        const settled = readReconciledSettledCost(reconciliation, "settle");
        if ("error" in settled) {
          await blockPreparedCompletion(settled.error);
          return;
        }
        settledCostCents = settled.settledCostCents;
        settledEvidence = settled.evidence;
      } else if (reconciliation.status === "reserved") {
        if (
          !Number.isSafeInteger(reconciliation.reservedCostCents) ||
          reconciliation.reservedCostCents !== economics.reservedCostCents
        ) {
          await blockPreparedCompletion(
            "reconciliation disagreed with the durable reservation amount"
          );
          return;
        }
        if (reconciliation.evidence !== undefined) {
          resumedHeld = { ...resumedHeld, evidence: reconciliation.evidence };
        }
        const settlement = await settleItem(resumedHeld, receiptBodyResults);
        if (settlement !== undefined && "settledCostCents" in settlement) {
          settledCostCents = settlement.settledCostCents;
          settledEvidence = settlement.evidence;
          settlementOverrun = settlement.overrun;
        } else if (settlement !== undefined && "outcomeUnknown" in settlement) {
          const resolved = await resolveUnknownSettlement(
            resumedHeld,
            settlement.actualCostCents,
            settlement.outcomeUnknown,
            settlement.evidence
          );
          if (resolved.status === "blocked") {
            await blockPreparedCompletion(resolved.error);
            return;
          }
          settledCostCents = resolved.settledCostCents;
          settledEvidence = resolved.evidence;
          settlementOverrun = resolved.overrun;
        } else {
          const detail =
            settlement !== undefined && "costUnknown" in settlement
              ? settlement.costUnknown
              : "settlement produced no authoritative receipt";
          await blockPreparedCompletion(detail);
          return;
        }
      } else {
        const detail =
          reconciliation.status === "blocked"
            ? reconciliation.error
            : `reconciliation returned ${reconciliation.status}; ` +
              "completed work is not authoritatively charged";
        await blockPreparedCompletion(detail);
        return;
      }

      if (settledCostCents === undefined) {
        await blockPreparedCompletion(
          "settlement produced no authoritative known cost"
        );
        return;
      }
      if (
        settlementOverrun !== undefined ||
        settledCostCents > economics.reservedCostCents
      ) {
        await blockPreparedCompletion(
          settlementOverrun ??
            `settled ${settledCostCents} cents against a ${economics.reservedCostCents}-cent reservation`,
          "failed",
          settledCostCents,
          settledEvidence
        );
        return;
      }
      const settledHeld =
        settledEvidence === undefined
          ? resumedHeld
          : { ...resumedHeld, evidence: settledEvidence };
      await checkpointAggregateReceipt({
        index,
        attempt: resumedAttempt,
        outcome: "completed",
        held: settledHeld,
        settledCostCents,
        bodyResults: retainedBodyResults,
      });
      await recordTerminalOutcome(
        index,
        "completed",
        settledHeld,
        settledCostCents
      );
      if (!(await restoreSettledItem(index))) {
        await blockPreparedCompletion("its durable aggregate could not be restored");
      }
      return;
    }

    const attempt =
      itemResume?.economics === undefined ? resumedAttempt : resumedAttempt + 1;

    // F: admit this item's ceiling BEFORE its first body node dispatches, so a
    // reservation that cannot be authorized never spends. `held` is the single
    // source of truth for whether a reservation is outstanding, and every one
    // of the three exits below reconciles it exactly once.
    const held = await reserveItem(index, attempt, iterationState);
    // A thrown reserve is reconciled before dispatch. Absent/released proves a
    // clean denial; reserved proves a hold exists and therefore requires the
    // strict host's release lifecycle before denial. Settled, unknown, and
    // conflict cannot authorize body work and remain blocked.
    if (typeof held === "object" && held !== null && "outcomeUnknown" in held) {
      const reconciliation = await reconcileUnknownReservation(
        index,
        attempt,
        held.outcomeUnknown,
        "reserve"
      );
      let reconciledHeld: HeldItemReservation | undefined;
      let blocked: string | undefined;
      if (reconciliation.status === "blocked") {
        blocked = reconciliation.error;
      } else if (reconciliation.status === "settled") {
        const settled = readReconciledSettledCost(reconciliation, "reserve");
        blocked =
          "error" in settled
            ? settled.error
            : `Loop "${loopNode.id}" item ${index} was charged ` +
              `${settled.settledCostCents} cents before its body was admitted; ` +
              "dispatch is blocked";
      } else if (reconciliation.status === "reserved") {
        if (
          !Number.isSafeInteger(reconciliation.reservedCostCents) ||
          reconciliation.reservedCostCents < 0 ||
          reconciliation.reservedCostCents > (itemBudgetCents as number)
        ) {
          blocked =
            `Loop "${loopNode.id}" item ${index} reserve reconciliation ` +
            `reported invalid hold ${String(reconciliation.reservedCostCents)}`;
        } else {
          reconciledHeld = {
            itemIndex: index,
            attempt,
            reservationId: deriveItemReservationId({
              ...(resume?.budgetRunId === undefined
                ? {}
                : { runId: resume.budgetRunId }),
              loopNodeId: loopNode.id,
              itemIndex: index,
              attempt,
            }),
            reservedCostCents: reconciliation.reservedCostCents,
            ...(reconciliation.evidence === undefined
              ? {}
              : { evidence: reconciliation.evidence }),
          };
          const release = await releaseItem(reconciledHeld, "failed");
          if (release !== undefined) {
            const releaseResolution = await resolveUnknownRelease(
              reconciledHeld,
              "failed",
              release.outcomeUnknown
            );
            if (releaseResolution.status !== "released") {
              blocked =
                releaseResolution.status === "blocked"
                  ? releaseResolution.error
                  : `Loop "${loopNode.id}" item ${index} was charged ` +
                    `${releaseResolution.settledCostCents} cents while closing ` +
                    "a reserve that failed before dispatch";
            }
          }
        }
      }

      if (held.malformed === true && blocked === undefined) {
        blocked =
          `Loop "${loopNode.id}" item ${index} reserve returned malformed ` +
          "evidence; reconciliation cannot turn that contradictory response " +
          "into authoritative admission";
      }

      if (blocked !== undefined) {
        breachBudget();
        firstError ??= {
          nodeId: loopNode.id,
          output: null,
          durationMs: Date.now() - startTime,
          error: blocked,
        };
        await recordTerminalOutcome(index, "outcome_unknown", reconciledHeld);
        iterationDurations[index] = Date.now() - iterStart;
        return;
      }

      breachBudget();
      firstError ??= {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" item ${index} budget is unknown: ` +
          "its reservation failed and was reconciled as not outstanding",
      };
      await recordTerminalOutcome(index, "denied", reconciledHeld);
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }

    if (
      typeof held === "object" &&
      held !== null &&
      "deniedHeld" in held
    ) {
      const deniedHeld = held.deniedHeld;
      const release = await releaseItem(deniedHeld, "failed");
      const resolution =
        release === undefined
          ? ({ status: "released" } as const)
          : await resolveUnknownRelease(
              deniedHeld,
              "failed",
              release.outcomeUnknown
            );
      if (resolution.status !== "released") {
        breachBudget();
        firstError ??= {
          nodeId: loopNode.id,
          output: null,
          durationMs: Date.now() - startTime,
          error:
            resolution.status === "blocked"
              ? resolution.error
              : `Loop "${loopNode.id}" item ${index} was charged ` +
                `${resolution.settledCostCents} cents while closing an ` +
                "over-ceiling reservation",
        };
        await recordTerminalOutcome(
          index,
          "outcome_unknown",
          held.retainEvidence === false ? undefined : deniedHeld
        );
        iterationDurations[index] = Date.now() - iterStart;
        return;
      }

      breachBudget();
      firstError ??= {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error:
          held.denialReason ??
          (`Loop "${loopNode.id}" item ${index} reservation of ` +
            `${deniedHeld.reservedCostCents} cents exceeds its ` +
            `${String(itemBudgetCents)}-cent ceiling and was released`),
      };
      await recordTerminalOutcome(
        index,
        "denied",
        held.retainEvidence === false ? undefined : deniedHeld
      );
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }

    for (
      let bodyIndex = startBodyNodeIndex;
      bodyIndex < bodyNodes.length;
      bodyIndex++
    ) {
      const bodyNode = bodyNodes[bodyIndex] as PipelineNode;
      // 24-I: `dispatchHalted` covers a host abort AND a budget breach raised
      // by ANOTHER worker while this item was mid-flight. At concurrency 1 the
      // breach case is unreachable (the only worker is this one), which is why
      // reading `context.signal` alone sufficed before this packet.
      if (dispatchHalted()) {
        completedBody = false;
        haltedBeforeBody = true;
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
                  ...(held.evidence === undefined
                    ? {}
                    : { evidence: held.evidence }),
                },
              }),
        });
      }
    }

    if (!completedBody) {
      // F: exits 1 and 2 — aborted, or a body node failed. The item never
      // completed, so its reservation is returned in full rather than settled.
      // Leaking here is the original defect reproduced one level down.
      // 24-I: an item halted mid-flight by another worker's budget breach was
      // stopped by a signal, not by its own body reporting an error, so it
      // releases as `aborted` exactly like a host cancellation does. Reading
      // `context.signal` alone here would release it as `failed` and tell the
      // host this item's work errored when it never ran.
      const releaseOutcome = await releaseItem(
        held,
        haltedBeforeBody ? "aborted" : "failed"
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
      let releaseSettledCostCents: number | undefined;
      let releaseSettledEvidence: LoopEconomicsEvidenceV1 | undefined;
      if (releaseOutcome !== undefined) {
        const resolution = await resolveUnknownRelease(
          // `releaseItem` returns an unknown marker only when it received a
          // concrete reservation, so this correlation is guaranteed here.
          held as HeldItemReservation,
          haltedBeforeBody ? "aborted" : "failed",
          releaseOutcome.outcomeUnknown
        );
        if (resolution.status === "blocked") {
          releaseUnresolved = true;
          breachBudget();
          firstError = {
            nodeId: loopNode.id,
            output: null,
            durationMs: Date.now() - startTime,
            error: resolution.error,
          };
        } else if (resolution.status === "settled") {
          releaseSettledCostCents = resolution.settledCostCents;
          releaseSettledEvidence = resolution.evidence;
          breachBudget();
          firstError = {
            nodeId: loopNode.id,
            output: null,
            durationMs: Date.now() - startTime,
            error:
              `Loop "${loopNode.id}" item ${index} failed before completion ` +
              `but release reconciliation proves it was charged ` +
              `${resolution.settledCostCents} cents; redispatch is blocked`,
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
          : // 24-I: `haltedBeforeBody` covers a host abort AND a breach raised
          // by another worker. Both stopped this item at the dispatch gate
          // with no body error of its own, which is what `cancelled` means.
          haltedBeforeBody
          ? "cancelled"
          : "failed",
        // The reservation was released rather than settled, so it carries no
        // settled cost — a released reservation charged nothing.
        held === undefined ||
          typeof held === "string" ||
          "outcomeUnknown" in held
          ? undefined
          : releaseSettledEvidence === undefined
            ? held
            : { ...held, evidence: releaseSettledEvidence },
        releaseSettledCostCents
      );
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }

    const collectedValue =
      contract.collect === undefined
        ? undefined
        : {
            status: "known" as const,
            value: collectIterationValue(
              iterationState,
              iterationPreviousResults,
              contract.collect.from
            ),
          };
    const aggregateBodyResults: Record<string, NodeResult> = {
      ...retainedBodyResults,
      [loopNode.id]: aggregateReceiptResult(
        loopNode.id,
        index,
        iterationState[contract.as],
        collectedValue,
        lastBodyResult!
      ),
    };
    // Persist the output receipt BEFORE settlement. If the process dies after
    // the host applies the charge but before the completed checkpoint, resume
    // reconciles this exact reservation and restores this receipt; it never
    // dispatches the item body to rebuild output.
    await checkpointAggregateReceipt({
      index,
      attempt,
      outcome: "running",
      held:
        held === undefined ||
        typeof held === "string" ||
        "outcomeUnknown" in held
          ? undefined
          : held,
      bodyResults: aggregateBodyResults,
    });

    // F: exit 3 — the item completed. Reconcile actual spend against the
    // reservation, releasing the unspent delta. An overrun fails the loop
    // closed (operator decision, 08-16): the authored ceiling was breached.
    const completedHeld = held as HeldItemReservation | undefined;
    let settlement = await settleItem(completedHeld, retainedBodyResults);
    if (
      settlement !== undefined &&
      "costUnknown" in settlement
    ) {
      breachBudget();
      firstError ??= {
        nodeId: loopNode.id,
        output: lastBodyResult?.output ?? null,
        durationMs: Date.now() - startTime,
        error:
          `Loop "${loopNode.id}" item ${index} usage/cost is unknown; ` +
          `settlement was not attempted: ${settlement.costUnknown}`,
      };
      await recordTerminalOutcome(
        index,
        "outcome_unknown",
        completedHeld
      );
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }
    // G2d (prereq 7): the settle call itself was unobservable. The item's work
    // is DONE and was charged, so this is not a release path — refunding could
    // return money the host already took. Only reconciliation can prove the
    // reservation's terminal state, and until it does the loop fails closed.
    // 24-G: narrowed on the marker key rather than on `typeof === "object"`,
    // because a clean settle now also returns an object. Matching on the shape
    // alone would route every successful settlement into reconciliation.
    if (
      settlement !== undefined &&
      "outcomeUnknown" in settlement
    ) {
      const resolution = await resolveUnknownSettlement(
        completedHeld as HeldItemReservation,
        settlement.actualCostCents,
        settlement.outcomeUnknown,
        settlement.evidence
      );
      if (resolution.status === "blocked") {
        breachBudget();
        firstError ??= {
          nodeId: loopNode.id,
          output: lastBodyResult?.output ?? null,
          durationMs: Date.now() - startTime,
          error: resolution.error,
        };
        await recordTerminalOutcome(
          index,
          "outcome_unknown",
          completedHeld
        );
        iterationDurations[index] = Date.now() - iterStart;
        return;
      }
      settlement = {
        settledCostCents: resolution.settledCostCents,
        ...(resolution.evidence === undefined
          ? {}
          : { evidence: resolution.evidence }),
        ...(resolution.overrun === undefined
          ? {}
          : { overrun: resolution.overrun }),
      };
    }
    if (settlement !== undefined && "overrun" in settlement) {
      breachBudget();
      firstError ??= {
        nodeId: loopNode.id,
        output: lastBodyResult?.output ?? null,
        durationMs: Date.now() - startTime,
        error: settlement.overrun,
      };
      // 24-G: the item's body succeeded but it settled past its authored
      // ceiling, which fails the loop closed. It is `failed` rather than
      // `completed`: the work finished, but the item did not complete within
      // the terms it was admitted under, and reporting `completed` would let
      // accounting close over a breach.
      await recordTerminalOutcome(
        index,
        "failed",
        completedHeld === undefined || settlement.evidence === undefined
          ? completedHeld
          : { ...completedHeld, evidence: settlement.evidence },
        settlement.settledCostCents
      );
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }

    const settledCostCents =
      settlement !== undefined && "settledCostCents" in settlement
        ? settlement.settledCostCents
        : undefined;
    const settledHeld =
      completedHeld === undefined ||
      settlement === undefined ||
      !("settledCostCents" in settlement) ||
      settlement.evidence === undefined
        ? completedHeld
        : { ...completedHeld, evidence: settlement.evidence };
    // Persist completion and its exact output before publishing the terminal
    // accounting record. Either record can independently block redispatch;
    // the completed frame additionally restores single-body aggregation.
    await checkpointAggregateReceipt({
      index,
      attempt,
      outcome: "completed",
      held: settledHeld,
      ...(settledCostCents === undefined ? {} : { settledCostCents }),
      bodyResults: aggregateBodyResults,
    });

    // 24-G exit 3. The item completed and settled, so its economics is
    // terminal too — this is the only exit that records a settled cost.
    await recordTerminalOutcome(
      index,
      "completed",
      settledHeld,
      settledCostCents
    );

    results[index] = lastBodyResult;
    if (contract.collect !== undefined) {
      collected[index] = collectedValue?.value;
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
