/**
 * Predicate loop executor — runs LoopNode body nodes iteratively until
 * a continue predicate returns false or maxIterations is reached. Dispatches
 * to the for_each executor when the node carries a `forEach` contract.
 *
 * @module pipeline/loop-executor/predicate-loop
 */

import type { LoopNode, PipelineNode } from "@dzupagent/core/pipeline";
import type {
  NodeExecutor,
  NodeExecutionContext,
  NodeResult,
  PipelineRuntimeEvent,
  LoopMetrics,
} from "../pipeline-runtime-types.js";
import type {
  LoopExecutionResult,
  LoopBodyGraphScheduleResult,
  LoopResumeOptions,
} from "./types.js";
import { executeForEachLoop } from "./for-each-loop.js";
import { createLoopIterationDeadline } from "./iteration-deadline.js";
import {
  isPipelineCheckpointCommitConflictError,
  isPipelineCheckpointIntegrityError,
} from "../pipeline-shared/checkpoint-integrity-error.js";
import {
  captureLoopBinding,
  completePredicateLoop,
  digestProgressOutput,
  isLoopIterationCancelled,
  isLoopIterationTimeout,
  loopBodyFailure,
  restoreLoopBinding,
  validateBodyResumeCursor,
  withoutLoopBinding,
  type LoopBindingSnapshot,
} from "./predicate-loop-helpers.js";
import {
  admitPredicateIteration,
  checkpointSettledPredicateIteration,
  releasePredicateIteration,
  settlePredicateIteration,
  validatePredicateBudgetHost,
  type HeldPredicateIterationReservation,
  type PredicateBudgetFailure,
} from "./predicate-loop-economics.js";

/**
 * Execute a loop node: runs body nodes in sequence per iteration,
 * evaluating the continue predicate after each iteration.
 */
export async function executeLoop(
  loopNode: LoopNode,
  bodyNodes: PipelineNode[],
  nodeExecutor: NodeExecutor,
  context: NodeExecutionContext,
  predicates: Record<string, (state: Record<string, unknown>) => boolean>,
  onEvent?: (event: PipelineRuntimeEvent) => void,
  resume?: LoopResumeOptions
): Promise<LoopExecutionResult> {
  if (loopNode.forEach !== undefined) {
    return executeForEachLoop(
      loopNode,
      bodyNodes,
      nodeExecutor,
      context,
      onEvent,
      resume
    );
  }

  const outerLoopBinding = captureLoopBinding(context.state);
  try {
    return await executePredicateLoop(
      loopNode,
      bodyNodes,
      nodeExecutor,
      context,
      predicates,
      onEvent,
      resume,
      outerLoopBinding
    );
  } finally {
    restoreLoopBinding(context.state, outerLoopBinding);
  }
}

async function executePredicateLoop(
  loopNode: LoopNode,
  bodyNodes: PipelineNode[],
  nodeExecutor: NodeExecutor,
  context: NodeExecutionContext,
  predicates: Record<string, (state: Record<string, unknown>) => boolean>,
  onEvent: ((event: PipelineRuntimeEvent) => void) | undefined,
  resume: LoopResumeOptions | undefined,
  outerLoopBinding: LoopBindingSnapshot
): Promise<LoopExecutionResult> {
  const startTime = Date.now();
  const iterationDurations: number[] = [];
  const budgetHostError = validatePredicateBudgetHost(loopNode, resume);
  if (budgetHostError !== undefined) {
    return {
      result: {
        nodeId: loopNode.id,
        output: null,
        durationMs: Date.now() - startTime,
        error: budgetHostError,
      },
      metrics: {
        iterationCount: 0,
        iterationDurations,
        converged: false,
        terminationReason: "budget_unknown",
      },
    };
  }
  // Resume cursor: iterations already completed before this call (W3).
  const startIteration = Math.max(0, resume?.startIteration ?? 0);
  const startBodyNodeIndex = resume?.startBodyNodeIndex ?? 0;
  const graphBody = loopNode.bodyGraph !== undefined;
  if (graphBody && resume?.scheduleBodyGraph === undefined) {
    throw new Error(
      `Loop node "${loopNode.id}": graph body requires a bounded pipeline scheduler`
    );
  }
  if (graphBody && startBodyNodeIndex !== 0) {
    throw new Error(
      `Loop node "${loopNode.id}": graph body cannot resume from a flat body-node index`
    );
  }
  const retainedBodyResults = validateBodyResumeCursor(
    loopNode,
    bodyNodes,
    startBodyNodeIndex,
    resume?.bodyResults
  );
  let iterationCount = startIteration;
  let terminationReason: LoopMetrics["terminationReason"] = "max_iterations";
  let lastBodyResult = retainedBodyResults.at(-1);
  let previousOutput = resume?.previousOutput;
  let previousProgressDigest = resume?.progressDigest;

  const progressKey = loopNode.typedWhile?.progressKey;
  if (
    progressKey !== undefined &&
    !bodyNodes.some((bodyNode) => bodyNode.id === progressKey)
  ) {
    throw new Error(
      `Loop node "${loopNode.id}": progressKey "${progressKey}" is not a body node`
    );
  }

  for (const result of retainedBodyResults) {
    context.previousResults.set(result.nodeId, result);
  }

  const continuePredicate = predicates[loopNode.continuePredicateName];
  if (!continuePredicate) {
    throw new Error(
      `Loop node "${loopNode.id}": predicate "${loopNode.continuePredicateName}" not found in predicates`
    );
  }

  // For a resumed loop, decide up front whether any further iteration should
  // run. If the cursor already reached maxIterations, or the continue predicate
  // is already satisfied against the resumed state, skip straight to terminal
  // handling without re-running the body.
  if (
    resume?.iterationEconomics !== undefined &&
    startIteration >= loopNode.maxIterations
  ) {
    return predicateBudgetFailureResult({
      loopNode,
      failure: {
        status: "blocked",
        reason: "budget_unknown",
        error:
          `Loop "${loopNode.id}" iteration ${startIteration + 1} checkpoint ` +
          "carries a reservation beyond maxIterations; redispatch is blocked",
      },
      lastBodyResult,
      loopStartedAt: startTime,
      iterationCount,
      iterationDurations,
    });
  }
  if (
    startIteration > 0 &&
    startBodyNodeIndex === 0 &&
    resume?.iterationEconomics === undefined
  ) {
    context.state["loop"] = {
      index: startIteration - 1,
      iteration: startIteration,
      isFirst: startIteration === 1,
      ...(previousOutput !== undefined ? { previous: previousOutput } : {}),
    };
    if (!continuePredicate(context.state)) {
      terminationReason = "condition_met";
    }
  }
  const alreadyTerminated =
    startIteration >= loopNode.maxIterations ||
    terminationReason === "condition_met";

  for (
    let i = startIteration;
    !alreadyTerminated && i < loopNode.maxIterations;
    i++
  ) {
    // Check cancellation
    if (context.signal?.aborted) {
      terminationReason = "cancelled";
      break;
    }

    const iterStart = Date.now();
    iterationCount++;
    context.state["loop"] = {
      index: i,
      iteration: i + 1,
      isFirst: i === 0,
      ...(previousOutput !== undefined ? { previous: previousOutput } : {}),
    };

    onEvent?.({
      type: "pipeline:loop_iteration",
      nodeId: loopNode.id,
      iteration: iterationCount,
      maxIterations: loopNode.maxIterations,
    });

    const bodyStartIndex = i === startIteration ? startBodyNodeIndex : 0;
    const resumedBodyGraphState =
      i === startIteration ? resume?.bodyGraphState : undefined;
    const admission = await admitPredicateIteration({
      loopNode,
      bodyNodes,
      state: context.state,
      resume,
      iteration: iterationCount,
      completedIterations: i,
      bodyComplete: graphBody
        ? resumedBodyGraphState?.completed === true
        : bodyStartIndex === bodyNodes.length,
      ...(i !== startIteration || resume?.iterationOutcome === undefined
        ? {}
        : { retainedOutcome: resume.iterationOutcome }),
      ...(i !== startIteration || resume?.iterationEconomics === undefined
        ? {}
        : { retainedEconomics: resume.iterationEconomics }),
    });
    if (admission.status === "blocked") {
      iterationDurations.push(Date.now() - iterStart);
      return predicateBudgetFailureResult({
        loopNode,
        failure: admission,
        lastBodyResult,
        loopStartedAt: startTime,
        iterationCount,
        iterationDurations,
      });
    }
    const held: HeldPredicateIterationReservation | undefined =
      admission.status === "held" || admission.status === "settled"
        ? admission.held
        : undefined;
    let settledCostCents =
      admission.status === "settled"
        ? admission.settledCostCents
        : undefined;
    let settledEvidence =
      admission.status === "settled" ? admission.evidence : undefined;
    const releaseOutstanding = async (
      outcome: "failed" | "cancelled" | "denied",
      reason: "aborted" | "failed"
    ): Promise<PredicateBudgetFailure | undefined> => {
      if (held === undefined || settledCostCents !== undefined) return undefined;
      const released = await releasePredicateIteration({
        loopNode,
        resume,
        completedIterations: i,
        held,
        outcome,
        reason,
      });
      return released.status === "blocked" ? released : undefined;
    };
    const settleOutstanding = async (
      bodyResults: Readonly<Record<string, NodeResult>>
    ): Promise<PredicateBudgetFailure | undefined> => {
      if (held === undefined || settledCostCents !== undefined) return undefined;
      const settlement = await settlePredicateIteration({
        loopNode,
        resume,
        completedIterations: i,
        held,
        bodyResults,
      });
      if (settlement.status === "blocked") return settlement;
      settledCostCents = settlement.settledCostCents;
      settledEvidence = settlement.evidence;
      if (settlement.overrun === undefined) return undefined;
      await checkpointSettledPredicateIteration({
        resume,
        completedIterations: i,
        outcome: "failed",
        held,
        settledCostCents,
        ...(settledEvidence === undefined ? {} : { evidence: settledEvidence }),
      });
      return {
        status: "blocked",
        reason: "budget_exceeded",
        error: settlement.overrun,
      };
    };

    const iterationBodyResults = new Map<string, NodeResult>();
    if (i === startIteration) {
      for (const result of retainedBodyResults) {
        iterationBodyResults.set(result.nodeId, result);
      }
    }

    const deadline = createLoopIterationDeadline({
      loopNodeId: loopNode.id,
      iteration: iterationCount,
      timeoutMs: loopNode.typedWhile?.iterationTimeoutMs,
      parentSignal: context.signal,
    });
    const iterationContext: NodeExecutionContext = {
      ...context,
      ...(deadline.signal === undefined ? {} : { signal: deadline.signal }),
    };
    try {
      if (graphBody) {
        let scheduled: LoopBodyGraphScheduleResult;
        try {
          scheduled = await deadline.run(
            resume!.scheduleBodyGraph!({
              iteration: iterationCount,
              context: iterationContext,
              ...(resumedBodyGraphState === undefined
                ? {}
                : { resumeState: resumedBodyGraphState }),
              ...(resume?.onBodyGraphCheckpoint === undefined
                ? {}
                : {
                    onCheckpoint: (state, options) =>
                      withoutLoopBinding(
                        context.state,
                        outerLoopBinding,
                        async () =>
                          resume.onBodyGraphCheckpoint!({
                            completedIterations: i,
                            state,
                            ...(options?.mandatory === true
                              ? { mandatory: true }
                              : {}),
                          })
                      ),
                  }),
            })
          );
        } catch (error) {
          if (isLoopIterationCancelled(error)) {
            terminationReason = "cancelled";
            scheduled = {
              outcome: { kind: "cancelled" },
              state: "cancelled",
              bodyResults: new Map(),
            };
          }
          if (isLoopIterationTimeout(error)) {
            const releaseFailure = await releaseOutstanding(
              "cancelled",
              "aborted"
            );
            iterationDurations.push(Date.now() - iterStart);
            if (releaseFailure !== undefined) {
              return predicateBudgetFailureResult({
                loopNode,
                failure: releaseFailure,
                lastBodyResult,
                loopStartedAt: startTime,
                iterationCount,
                iterationDurations,
              });
            }
            return {
              result: {
                nodeId: loopNode.id,
                output: lastBodyResult?.output ?? null,
                durationMs: Date.now() - startTime,
                error: error.message,
              },
              metrics: {
                iterationCount,
                iterationDurations,
                converged: false,
                terminationReason: "timed_out",
              },
            };
          }
          throw error;
        }

        for (const [nodeId, bodyResult] of scheduled.bodyResults) {
          iterationBodyResults.set(nodeId, bodyResult);
          context.previousResults.set(nodeId, bodyResult);
        }
        lastBodyResult = scheduled.lastResult ?? lastBodyResult;

        if (scheduled.outcome.kind === "cancelled") {
          terminationReason = "cancelled";
        } else if (scheduled.outcome.kind === "suspended") {
          if (scheduled.checkpointState === undefined) {
            throw new Error(
              `Loop node "${loopNode.id}": suspended body outcome omitted its durable graph frame`
            );
          }
          iterationDurations.push(Date.now() - iterStart);
          return {
            result: {
              nodeId: loopNode.id,
              output: scheduled.lastResult?.output ?? null,
              durationMs: Date.now() - startTime,
            },
            metrics: {
              iterationCount,
              iterationDurations,
              converged: false,
              terminationReason: scheduled.outcome.kind,
            },
            control: {
              outcome: scheduled.outcome,
              checkpointState: scheduled.checkpointState,
              completedIterations: i,
            },
          };
        } else if (scheduled.outcome.kind === "terminal") {
          if (scheduled.checkpointState === undefined) {
            throw new Error(
              `Loop node "${loopNode.id}": terminal body outcome omitted its durable graph frame`
            );
          }
          const settlementFailure = await settleOutstanding(
            Object.fromEntries(iterationBodyResults)
          );
          iterationDurations.push(Date.now() - iterStart);
          if (settlementFailure !== undefined) {
            return predicateBudgetFailureResult({
              loopNode,
              failure: settlementFailure,
              lastBodyResult,
              loopStartedAt: startTime,
              iterationCount,
              iterationDurations,
            });
          }
          if (
            held !== undefined &&
            settledCostCents !== undefined
          ) {
            await checkpointSettledPredicateIteration({
              resume,
              completedIterations: i,
              outcome: "completed",
              held,
              settledCostCents,
              ...(settledEvidence === undefined
                ? {}
                : { evidence: settledEvidence }),
            });
          }
          return {
            result: {
              nodeId: loopNode.id,
              output: scheduled.lastResult?.output ?? null,
              durationMs: Date.now() - startTime,
            },
            metrics: {
              iterationCount,
              iterationDurations,
              converged: false,
              terminationReason: "terminal",
            },
            control: {
              outcome: scheduled.outcome,
              checkpointState: scheduled.checkpointState,
              completedIterations: i,
            },
          };
        } else if (scheduled.outcome.kind !== "normal") {
          const error = scheduled.outcome.error;
          const releaseFailure = await releaseOutstanding("failed", "failed");
          iterationDurations.push(Date.now() - iterStart);
          if (releaseFailure !== undefined) {
            return predicateBudgetFailureResult({
              loopNode,
              failure: releaseFailure,
              lastBodyResult,
              loopStartedAt: startTime,
              iterationCount,
              iterationDurations,
            });
          }
          return loopBodyFailure(
            loopNode,
            scheduled.lastResult,
            error,
            startTime,
            iterationCount,
            iterationDurations
          );
        }
      } else {
        // Legacy artifact path: execute the ordered body list, resuming after
        // the last body node whose successful result was durably retained.
        for (
          let bodyIndex = bodyStartIndex;
          bodyIndex < bodyNodes.length;
          bodyIndex++
        ) {
        const bodyNode = bodyNodes[bodyIndex]!;
        if (context.signal?.aborted) {
          terminationReason = "cancelled";
          break;
        }

        let bodyResult: NodeResult;
        try {
          bodyResult = await deadline.run(
            nodeExecutor(bodyNode.id, bodyNode, iterationContext)
          );
        } catch (error) {
          if (isLoopIterationCancelled(error)) {
            terminationReason = "cancelled";
            break;
          }
          if (isLoopIterationTimeout(error)) {
            const releaseFailure = await releaseOutstanding(
              "cancelled",
              "aborted"
            );
            iterationDurations.push(Date.now() - iterStart);
            if (releaseFailure !== undefined) {
              return predicateBudgetFailureResult({
                loopNode,
                failure: releaseFailure,
                lastBodyResult,
                loopStartedAt: startTime,
                iterationCount,
                iterationDurations,
              });
            }
            return {
              result: {
                nodeId: loopNode.id,
                output: lastBodyResult?.output ?? null,
                durationMs: Date.now() - startTime,
                error: error.message,
              },
              metrics: {
                iterationCount,
                iterationDurations,
                converged: false,
                terminationReason: "timed_out",
              },
            };
          }
          throw error;
        }
          context.previousResults.set(bodyNode.id, bodyResult);
          lastBodyResult = bodyResult;

          if (bodyResult.error) {
            const releaseFailure = await releaseOutstanding(
              "failed",
              "failed"
            );
            iterationDurations.push(Date.now() - iterStart);
            if (releaseFailure !== undefined) {
              return predicateBudgetFailureResult({
                loopNode,
                failure: releaseFailure,
                lastBodyResult: bodyResult,
                loopStartedAt: startTime,
                iterationCount,
                iterationDurations,
              });
            }
            return loopBodyFailure(
              loopNode,
              bodyResult,
              bodyResult.error,
              startTime,
              iterationCount,
              iterationDurations
            );
          }

          iterationBodyResults.set(bodyNode.id, bodyResult);
          const onBodyNodeComplete = resume?.onBodyNodeComplete;
          if (onBodyNodeComplete !== undefined) {
            await withoutLoopBinding(
              context.state,
              outerLoopBinding,
              async () =>
                onBodyNodeComplete({
                  completedIterations: i,
                  nextBodyNodeIndex: bodyIndex + 1,
                  bodyResults: Object.fromEntries(iterationBodyResults),
                })
            );
          }
        }
      }
    } catch (error) {
      // A graph-scoped standard-node dispatcher may observe the derived abort
      // signal after the scheduler race itself settles. Normalize that late
      // cancellation at the iteration boundary as well.
      if (isLoopIterationCancelled(error)) {
        terminationReason = "cancelled";
      } else if (
        isPipelineCheckpointIntegrityError(error) ||
        isPipelineCheckpointCommitConflictError(error)
      ) {
        // A checkpoint transport/CAS boundary may follow committed body work.
        // Preserve the durable hold so restart can reconcile it; releasing here
        // would refund work whose effect receipt may already be committed.
        throw error;
      } else {
        const releaseFailure = await releaseOutstanding("failed", "failed");
        if (releaseFailure !== undefined) {
          iterationDurations.push(Date.now() - iterStart);
          return predicateBudgetFailureResult({
            loopNode,
            failure: releaseFailure,
            lastBodyResult,
            loopStartedAt: startTime,
            iterationCount,
            iterationDurations,
          });
        }
        throw error;
      }
    } finally {
      deadline.dispose();
    }

    iterationDurations.push(Date.now() - iterStart);

    // An interrupted body is not a completed iteration. Leave the most recent
    // body-node cursor intact so a later resume continues at the next node.
    if (terminationReason === "cancelled") {
      const releaseFailure = await releaseOutstanding("cancelled", "aborted");
      if (releaseFailure !== undefined) {
        return predicateBudgetFailureResult({
          loopNode,
          failure: releaseFailure,
          lastBodyResult,
          loopStartedAt: startTime,
          iterationCount,
          iterationDurations,
        });
      }
      break;
    }

    const settlementFailure = await settleOutstanding(
      Object.fromEntries(iterationBodyResults)
    );
    if (settlementFailure !== undefined) {
      return predicateBudgetFailureResult({
        loopNode,
        failure: settlementFailure,
        lastBodyResult,
        loopStartedAt: startTime,
        iterationCount,
        iterationDurations,
      });
    }

    const completedOutput = lastBodyResult?.output;
    const progressDigest =
      progressKey !== undefined
        ? digestProgressOutput(loopNode, progressKey, iterationBodyResults)
        : undefined;
    if (
      progressDigest !== undefined &&
      previousProgressDigest === progressDigest
    ) {
      if (held !== undefined && settledCostCents !== undefined) {
        await checkpointSettledPredicateIteration({
          resume,
          completedIterations: i,
          outcome: "failed",
          held,
          settledCostCents,
          ...(settledEvidence === undefined
            ? {}
            : { evidence: settledEvidence }),
        });
      }
      return {
        result: {
          nodeId: loopNode.id,
          output: completedOutput ?? null,
          durationMs: Date.now() - startTime,
          error: `Loop "${loopNode.id}" made no progress: body node "${progressKey}" produced the same canonical output in consecutive iterations`,
        },
        metrics: {
          iterationCount,
          iterationDurations,
          converged: false,
          terminationReason: "no_progress",
        },
      };
    }

    // Settle evidence must be durable before the general iteration cursor
    // advances. A crash in this window otherwise retains only the pending
    // reservation and forces reconciliation to rediscover a charge the host
    // already proved with exact terminal usage/effect receipts.
    if (held !== undefined && settledCostCents !== undefined) {
      await checkpointSettledPredicateIteration({
        resume,
        completedIterations: i,
        outcome: "completed",
        held,
        settledCostCents,
        ...(settledEvidence === undefined
          ? {}
          : { evidence: settledEvidence }),
      });
    }

    // Durable-resume checkpoint hook (W3): persist the cursor + accumulated
    // state after each completed iteration so a crash resumes from the next
    // iteration. Runs before the continue-predicate break so the final
    // iteration's progress is recorded too.
    const onIterationComplete = resume?.onIterationComplete;
    if (onIterationComplete !== undefined) {
      await withoutLoopBinding(
        context.state,
        outerLoopBinding,
        async () =>
          onIterationComplete(iterationCount, {
            ...(completedOutput !== undefined
              ? { previousOutput: completedOutput }
              : {}),
            ...(progressDigest !== undefined ? { progressDigest } : {}),
          })
      );
    }
    previousOutput = completedOutput;
    previousProgressDigest = progressDigest;

    if (context.signal?.aborted) {
      terminationReason = "cancelled";
      break;
    }

    // Evaluate continue predicate
    const shouldContinue = continuePredicate(context.state);
    if (!shouldContinue) {
      terminationReason = "condition_met";
      break;
    }
  }

  return completePredicateLoop({
    loopNode,
    lastBodyResult,
    loopStartedAt: startTime,
    iterationCount,
    iterationDurations,
    terminationReason,
  });
}

function predicateBudgetFailureResult(input: {
  readonly loopNode: LoopNode;
  readonly failure: PredicateBudgetFailure;
  readonly lastBodyResult: NodeResult | undefined;
  readonly loopStartedAt: number;
  readonly iterationCount: number;
  readonly iterationDurations: number[];
}): LoopExecutionResult {
  return {
    result: {
      nodeId: input.loopNode.id,
      output: input.lastBodyResult?.output ?? null,
      durationMs: Date.now() - input.loopStartedAt,
      error: input.failure.error,
    },
    metrics: {
      iterationCount: input.iterationCount,
      iterationDurations: input.iterationDurations,
      converged: false,
      terminationReason: input.failure.reason,
    },
  };
}
