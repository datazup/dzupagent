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
  LoopBodyGraphCheckpointState,
} from "./types.js";
import type { ForEachEconomicsV2Preparation } from "./budget-types.js";
import {
  ForEachItemEconomicsV2Custody,
  createForEachV2LeafExecutor,
} from "./for-each-item-economics-v2.js";
import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import { resolveStatePath, setStatePath } from "./state-path.js";
import type { ForEachMergeState } from "./for-each-merge.js";
import { createItemBudgetLifecycle } from "./for-each-item-budget.js";
import { fenceForEachGraphOperations } from "./for-each-graph.js";
import type { HeldItemReservation } from "./for-each-reservation.js";

import {
  aggregateReceiptResult,
  collectIterationValue,
  readAggregateReceipt,
  type ForEachContract,
} from "./for-each-aggregate-receipt.js";
import {
  createForEachItemCustody,
  type ForEachRunContext,
} from "./for-each-run-context.js";
import {
  blockRetainedItem,
  settlePreparedCompletion,
} from "./for-each-item-resume.js";
import { admitItemReservation } from "./for-each-item-admission.js";
import {
  releaseIncompleteItem,
  settleCompletedItem,
} from "./for-each-item-exits.js";
import { createForEachPrefixFlush } from "./for-each-flush.js";

// Re-exported for the direct unit test that pins the reservation-id wire format.
export { deriveItemReservationId } from "./for-each-reservation.js";

export async function executeForEachLoop(
  loopNode: LoopNode,
  bodyNodes: PipelineNode[],
  nodeExecutor: NodeExecutor,
  context: NodeExecutionContext,
  onEvent?: (event: PipelineRuntimeEvent) => void,
  resume?: LoopResumeOptions
): Promise<{ result: NodeResult; metrics: LoopMetrics }> {
  const startTime = Date.now();
  if (loopNode.bodyGraph !== undefined && (resume?.scheduleBodyGraph === undefined || resume.onItemBodyNodeComplete === undefined || resume.graphDefinitionDigest === undefined)) {
    throw new Error(`Loop "${loopNode.id}" requires the canonical item graph scheduler and checkpoint writer`);
  }
  // DSL-V2-HOST-BRIDGE-20260918: the V1 exact profile stays denied for graph
  // bodies; the strict V2 profile serves them. Neither record is ever read as
  // the other: a retained V1 record under the V2 profile, or a V2 record
  // under any other profile, blocks before reservation or dispatch.
  const v2Mode = resume?.budgetEvidenceMode === "required-v2";
  const retainedEconomics = [
    ...Object.values(resume?.itemFrames ?? {}),
    ...Object.values(resume?.itemOutcomes ?? {}),
  ].map((item) => item.economics);
  if (loopNode.bodyGraph !== undefined && (
    resume?.budgetEvidenceMode === "required" ||
    retainedEconomics.some((economics) => economics?.evidence !== undefined)
  )) {
    throw new Error(`Loop "${loopNode.id}" conditional items require V2 selected/skipped-leaf economics; V1 exact-evidence execution is not admitted`);
  }
  if (!v2Mode && retainedEconomics.some((economics) => economics?.evidenceV2 !== undefined)) {
    throw new Error(`Loop "${loopNode.id}" retains V2 selected/skipped-leaf economics that this host profile cannot serve; downgrade is denied`);
  }
  let economicsV2: ForEachEconomicsV2Preparation | undefined;
  if (v2Mode) {
    if (loopNode.bodyGraph === undefined) {
      throw new Error(`Loop "${loopNode.id}" V2 selected/skipped-leaf economics admits only a compiler-lowered graph body`);
    }
    const readiness = resume?.economicsV2;
    if (readiness === undefined || resume?.dispatchLeafV2 === undefined || resume.itemBudgetCents === undefined) {
      throw new Error(`Loop "${loopNode.id}" V2 host profile requires a prepared leaf inventory, a dispatchLeaf authority and a hard item ceiling`);
    }
    if (readiness.status === "denied") {
      throw new Error(`Loop "${loopNode.id}" V2 admission denied: ${readiness.error}`);
    }
    if (readiness.preparation.inventory.definitionDigest !== resume.graphDefinitionDigest) {
      throw new Error(`Loop "${loopNode.id}" V2 leaf inventory does not bind the executing definition`);
    }
    economicsV2 = readiness.preparation;
  }
  const graphFence = loopNode.bodyGraph === undefined ? undefined : fenceForEachGraphOperations(resume!);
  if (graphFence) resume = graphFence.options;
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
    graphFence?.failed === true || dispatchStop.signal.aborted || context.signal?.aborted === true;

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
  const lifecycle = createItemBudgetLifecycle({
    loopNode,
    bodyNodes,
    itemBudgetCents,
    resume,
    ...(economicsV2 === undefined ? {} : { economicsV2 }),
  });
  const {
    reserveItem,
    reconcileUnknownReservation,
    releaseItem,
    resolveUnknownRelease,
  } = lifecycle;

  // DSL-V2-HOST-BRIDGE-20260918: per-item V2 custody (selections and leaf
  // outcomes), keyed by item index, owned by `for-each-run-context.ts`.
  const itemCustody = createForEachItemCustody(economicsV2);
  const { custodies, itemEconomics, heldFrom, restoreCustody } = itemCustody;

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
    settledCostCents?: number,
    attemptedWithoutHold?: number
  ): Promise<void> => {
    terminalOutcomes.add(index);
    await resume?.onItemTerminalOutcome?.({
      itemIndex: index,
      outcome,
      ...(held === undefined
        ? {}
        : { economics: itemEconomics(held, index, settledCostCents) }),
      ...((held?.attempt ?? attemptedWithoutHold ?? 0) > 0
        ? { attempt: held?.attempt ?? attemptedWithoutHold! }
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
        : { economics: itemEconomics(input.held, input.index, input.settledCostCents) }),
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
  const restoreSettledItem = async (
    index: number,
    frame = resume?.itemFrames?.[String(index)]
  ): Promise<boolean> => {
    if (
      frame?.outcome !== "completed" ||
      frame.nextBodyNodeIndex !== bodyNodes.length
    ) {
      return false;
    }
    const receipt = readAggregateReceipt(
      loopNode.id,
      index,
      frame?.graph === undefined ? items[index] : frame.graph.state[contract.as],
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

  // DZUPAGENT-CODE-H-11: the item boundary helpers receive exactly the values
  // and closures they previously captured from this function.
  const run: ForEachRunContext = {
    ...itemCustody,
    loopNode,
    bodyNodes,
    contract,
    items,
    resume,
    startTime,
    itemBudgetCents,
    v2Mode,
    economicsV2,
    lifecycle,
    iterationDurations,
    terminalOutcomes,
    breachBudget,
    fail: (error) => {
      firstError ??= error;
    },
    failOverride: (error) => {
      firstError = error;
    },
    recordTerminalOutcome,
    checkpointAggregateReceipt,
    restoreSettledItem,
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
    if (await blockRetainedItem(run, index, itemResume, priorOutcome)) return;

    const iteration = index + 1;
    const iterStart = Date.now();
    onEvent?.({
      type: "pipeline:loop_iteration",
      nodeId: loopNode.id,
      iteration,
      maxIterations: items.length,
    });

    const iterationState = loopNode.bodyGraph === undefined
      ? { ...context.state, [contract.as]: items[index] }
      : structuredClone(itemResume?.graph?.state ?? { ...context.state, [contract.as]: items[index] });
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

    if (startBodyNodeIndex >= bodyNodes.length) {
      await settlePreparedCompletion(run, {
        index,
        itemResume,
        startBodyNodeIndex,
        resumedAttempt,
        retainedBodyResults,
        iterStart,
      });
      return;
    }

    let resumedGraphHold: HeldItemReservation | undefined;
    let retryReleasedGraph = false;
    if (itemResume?.graph !== undefined && itemResume.economics !== undefined) {
      const economics = itemResume.economics;
      // V2: the terminal record of this same attempt is written after its last
      // frame and is therefore the custody of record.
      const latest =
        v2Mode &&
        priorOutcome?.economics?.evidenceV2 !== undefined &&
        (priorOutcome.attempt ?? 0) === resumedAttempt
          ? priorOutcome.economics
          : economics;
      const retained: HeldItemReservation = heldFrom(index, resumedAttempt, latest);
      const reconciliation = await reconcileUnknownReservation(
        index, resumedAttempt, "resume of a durable selected item graph", "reserve", retained,
      );
      retryReleasedGraph = reconciliation.status === "released" &&
        (priorOutcome?.outcome === "failed" || priorOutcome?.outcome === "cancelled" || priorOutcome?.outcome === "denied") &&
        (priorOutcome.economics !== undefined || priorOutcome.outcome === "denied") &&
        priorOutcome.economics?.settledCostCents === undefined &&
        economics.settledCostCents === undefined;
      if (!retryReleasedGraph) {
        if (reconciliation.status !== "reserved" ||
            reconciliation.reservedCostCents !== economics.reservedCostCents ||
            reconciliation.evidence !== undefined) {
          throw new Error(`Loop "${loopNode.id}" item ${index} cannot resume its selected graph: original reservation is not an unchanged authoritative hold or a proven released retryable attempt`);
        }
        if (v2Mode) {
          // The retained custody must agree with the retained frame (§3.4
          // rows 1–2): a recorded selection the frame does not show, a
          // transition the authored structure does not admit, or a leaf whose
          // outcome contradicts the frame blocks the unit here.
          const custody = restoreCustody(index, latest);
          const custodyError = custody === undefined
            ? "the selected graph carries no V2 record"
            : custody.applyFrame(itemResume.graph.frame as LoopBodyGraphCheckpointState);
          if (custodyError !== undefined) {
            throw new Error(`Loop "${loopNode.id}" item ${index} cannot resume its selected graph: V2 leaf custody is inconsistent: ${custodyError}`);
          }
        }
        // Continuing a checkpointed branch is the same attempt. Re-reserving
        // under a new identity leaks the old hold and changes effect identities.
        resumedGraphHold = retained;
      }
    }
    const attempt = resumedGraphHold !== undefined || itemResume?.economics === undefined
      ? resumedAttempt
      : Math.max(resumedAttempt, retryReleasedGraph ? (priorOutcome?.attempt ?? 0) : 0) + 1;

    // F: admit this item's ceiling BEFORE its first body node dispatches, so a
    // reservation that cannot be authorized never spends. `held` is the single
    // source of truth for whether a reservation is outstanding, and every one
    // of the three exits below reconciles it exactly once.
    const held = resumedGraphHold ?? await reserveItem(index, attempt, iterationState);
    const admission = await admitItemReservation(run, {
      index,
      attempt,
      held,
      retryReleasedGraph,
      iterStart,
    });
    if (admission.terminal) return;
    const admittedHeld: HeldItemReservation | undefined = admission.held;
    // DSL-V2-HOST-BRIDGE-20260918: a fresh admission (first attempt, or a
    // retry of a released attempt) opens its custody here. A retry may
    // continue a retained frame only if that frame recorded no leaf: a
    // completed leaf node without an outcome under this admission would be
    // work charged to a released reservation, which is denied rather than
    // re-admitted.
    let custody: ForEachItemEconomicsV2Custody | undefined = custodies.get(index);
    let custodyBlocked: string | undefined;
    if (v2Mode && admittedHeld !== undefined && custody === undefined) {
      if (admittedHeld.economicsV2 === undefined || economicsV2 === undefined) {
        custodyBlocked = "the reservation carries no V2 record";
      } else {
        custody = new ForEachItemEconomicsV2Custody(economicsV2.inventory, admittedHeld.economicsV2.evidence);
        custodies.set(index, custody);
        const frame = itemResume?.graph?.frame as LoopBodyGraphCheckpointState | undefined;
        custodyBlocked = frame === undefined ? undefined : custody.applyFrame(frame);
      }
      if (custodyBlocked !== undefined) {
        const release = await releaseItem(admittedHeld, "failed");
        const resolution = release === undefined
          ? ({ status: "released" } as const)
          : await resolveUnknownRelease(admittedHeld, "failed", release.outcomeUnknown);
        breachBudget();
        firstError ??= {
          nodeId: loopNode.id, output: null, durationMs: Date.now() - startTime,
          error: resolution.status === "blocked"
            ? resolution.error
            : `Loop "${loopNode.id}" item ${index} cannot adopt its retained progress under a fresh V2 admission: ${custodyBlocked}; redispatch is blocked`,
        };
        await recordTerminalOutcome(index, resolution.status === "released" ? "failed" : "outcome_unknown", admittedHeld);
        iterationDurations[index] = Date.now() - iterStart;
        return;
      }
    }

    if (loopNode.bodyGraph !== undefined && admittedHeld?.evidence !== undefined) {
      completedBody = false;
      firstError ??= { nodeId: loopNode.id, output: null, durationMs: Date.now() - startTime,
        error: "Conditional items require V2 selected/skipped-leaf economics; V1 exact evidence was returned by the reservation host" };
    } else if (loopNode.bodyGraph !== undefined) {
      if (retryReleasedGraph && admittedHeld !== undefined) {
        // Publish the fresh reservation and retire the old terminal outcome
        // together before retry effects. If reserve's acknowledgement or this
        // checkpoint is lost, the same next-attempt identity is reconciled or
        // replayed; no completed node or recorded branch needs to run again.
        await resume!.onItemBodyNodeComplete!({
          itemIndex: index, nextBodyNodeIndex: itemResume!.nextBodyNodeIndex,
          bodyResults: retainedBodyResults, graph: itemResume!.graph!,
          attempt, outcome: "running", mandatory: true,
          economics: itemEconomics(admittedHeld, index),
        });
      }
      const leafExecutor = custody === undefined
        ? undefined
        : createForEachV2LeafExecutor({
            custody,
            dispatchLeaf: resume!.dispatchLeafV2!,
            execute: nodeExecutor,
          });
      const graphResult = await resume!.scheduleBodyGraph!({
        iteration,
        ...(leafExecutor === undefined ? {} : { nodeExecutor: leafExecutor }),
        context: {
          ...context, state: iterationState, previousResults: iterationPreviousResults,
          executionScope: { loopNodeId: loopNode.id, itemIndex: index, bodyNodeId: loopNode.bodyGraph.entryNodeId, ...(attempt > 0 ? { attempt } : {}) },
          // The scoped kernel checks this signal before every node, including
          // a sibling's fail-fast or budget stop.
          signal: {
            get aborted() { return dispatchHalted(); },
            addEventListener: (type, listener) => context.signal?.addEventListener?.(type, listener),
            removeEventListener: (type, listener) => context.signal?.removeEventListener?.(type, listener),
          },
        },
        ...(itemResume?.graph === undefined ? {} : { resumeState: itemResume.graph.frame as LoopBodyGraphCheckpointState }),
        onCheckpoint: async (frame) => {
          if (custody !== undefined) {
            // Selections and not-selected releases are derived from this very
            // frame and written beside it; an inconsistency blocks the unit.
            const inconsistency = custody.applyFrame(frame);
            if (inconsistency !== undefined) {
              custodyBlocked ??= inconsistency;
              throw new Error(`Loop "${loopNode.id}" item ${index} V2 leaf custody is inconsistent with its frame: ${inconsistency}`);
            }
          }
          const bodyResults = { ...frame.nodeResults };
          if (frame.completed) {
            const final = bodyResults[frame.completedNodeIds.at(-1)!]!;
            const collected = contract.collect === undefined ? undefined : {
              status: "known" as const,
              value: collectIterationValue(iterationState, new Map([...iterationPreviousResults, ...Object.entries(bodyResults)]), contract.collect.from),
            };
            bodyResults[loopNode.id] = aggregateReceiptResult(loopNode.id, index, iterationState[contract.as], collected, final);
          }
          await resume!.onItemBodyNodeComplete!({
            itemIndex: index,
            nextBodyNodeIndex: frame.completed ? bodyNodes.length : 0,
            bodyResults,
            graph: { schema: "dzupagent/for-each-item-graph/v1", definitionDigest: resume!.graphDefinitionDigest!, loopNodeId: loopNode.id, itemIndex: index, itemValueDigest: `sha256:${canonicalInputDigest(items[index])}`, state: structuredClone(iterationState), frame },
            mandatory: true,
            ...(attempt > 0 ? { attempt } : {}), outcome: "running",
            ...(admittedHeld === undefined ? {} : { economics: itemEconomics(admittedHeld, index) }),
          });
        },
      });
      for (const [id, result] of graphResult.bodyResults) {
        retainedBodyResults[id] = result;
        iterationPreviousResults.set(id, result);
      }
      lastBodyResult = graphResult.lastResult;
      if (custody !== undefined && custodyBlocked === undefined && custody.hasUnknown()) {
        custodyBlocked = `a leaf outcome is unknown: ${graphResult.error ?? "the host could not prove dispatch"}`;
      }
      if (custodyBlocked !== undefined) completedBody = false;
      if (graphResult.outcome.kind !== "normal" || lastBodyResult === undefined) {
        completedBody = false;
        haltedBeforeBody = graphResult.outcome.kind === "cancelled";
        firstError ??= { nodeId: loopNode.id, output: null, durationMs: Date.now() - startTime,
          error: graphResult.error ?? `Item graph did not complete normally: ${graphResult.outcome.kind}` };
      }
    } else for (
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
          ...(admittedHeld === undefined
            ? {}
            : { economics: itemEconomics(admittedHeld, index) }),
        });
      }
    }

    if (!completedBody) {
      await releaseIncompleteItem(run, {
        index,
        custody,
        custodyBlocked,
        admittedHeld,
        haltedBeforeBody,
        iterStart,
      });
      return;
    }

    const completion = await settleCompletedItem(run, {
      index,
      attempt,
      custody,
      admittedHeld,
      iterationState,
      iterationPreviousResults,
      retainedBodyResults,
      lastBodyResult,
      iterStart,
    });
    if (completion === undefined) return;
    const { collectedValue } = completion;

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

  const flushPrefix = createForEachPrefixFlush({
    merge,
    contract,
    context,
    collected,
    resume,
  });
  // Source attachment and aggregate publication must share the checkpoint
  // queue: another item's frame cannot snapshot half of a prefix transition.
  const flushCompletedPrefix = graphFence ? graphFence.serialize(flushPrefix) : flushPrefix;

  const workers = Array.from({ length: concurrency }, async () => {
    while (
      !(contract.failFast === true && firstError !== undefined) &&
      graphFence?.failed !== true &&
      !budgetBreached &&
      !context.signal?.aborted
    ) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await runIteration(index);
      } catch (error) {
        if (graphFence) { graphFence.fail(error); stopDispatch(); }
        throw error;
      }
    }
  });
  if (graphFence) {
    await Promise.allSettled(workers);
    graphFence.check();
  } else {
    await Promise.all(workers);
  }
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
