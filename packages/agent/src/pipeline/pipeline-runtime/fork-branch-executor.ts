/**
 * Fork/branch fan-out for the pipeline executor.
 *
 * Pulled out of `PipelineExecutor` so the per-branch parallel execution,
 * tracer span bookkeeping, and deterministic merge logic can be tested
 * and reasoned about in isolation.
 *
 * @module pipeline/pipeline-runtime/fork-branch-executor
 */

import type {
  PipelineNode,
  PipelineEdge,
  ForkNode,
  JoinNode,
} from "@dzupagent/core/pipeline";
import type {
  NodeResult,
  NodeExecutionContext,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from "../pipeline-runtime-types.js";
import { omitUndefined } from "../../utils/exact-optional.js";
import {
  nodeStartedEvent,
  nodeCompletedEvent,
  nodeFailedEvent,
} from "./runtime-events.js";
import { getNextNodeIds, getForkBranchStartIds } from "./edge-resolution.js";
import {
  collectStateDelta,
  mergeBranchExecutionResult,
  type BranchExecutionResult,
} from "./branch-merge.js";
import { nodeIdempotencyKey, nodeIdempotencyContext } from "./idempotency.js";
import {
  beginNodeUnderLedger,
  completeNodeUnderLedger,
  failNodeUnderLedger,
  startNodeHeartbeat,
  type HeartbeatHandle,
} from "./node-ledger-integration.js";
import type { NodeLeaseLike } from "../pipeline-runtime-types.js";

export interface ForkBranchExecutorDeps {
  config: PipelineRuntimeConfig;
  nodeMap: Map<string, PipelineNode>;
  outgoingEdges: Map<string, PipelineEdge[]>;
  emit: (event: PipelineRuntimeEvent) => void;
  findJoinNode: (forkId: string) => JoinNode | undefined;
  /** Stable run identifier — used to derive per-branch-node idempotency keys (W4/W5). */
  runId: string;
}

/** Resume inputs for durable fork/branch resume (W4). */
export interface ForkResumeOptions {
  /**
   * branchStartId -> already-completed branch result. Restored (not re-run)
   * on resume. Absent branches execute normally.
   */
  completedBranches: Record<string, BranchExecutionResult>;
  /**
   * Called after each freshly-run branch completes successfully, before the
   * join merge, so the runtime can persist the branch's progress.
   */
  onBranchComplete: (
    branchStartId: string,
    result: BranchExecutionResult
  ) => Promise<void>;
}

/**
 * Run a fork node: clone state, fan out to all branches in parallel,
 * then merge fulfilled branch results back into the shared state. Failed
 * branches emit a `node_failed` event but do not abort siblings.
 */
export async function handleFork(
  deps: ForkBranchExecutorDeps,
  forkNode: ForkNode,
  runState: Record<string, unknown>,
  nodeResults: Map<string, NodeResult>,
  completedNodeIds: string[],
  resume?: ForkResumeOptions
): Promise<void> {
  const { config, outgoingEdges, emit, findJoinNode } = deps;

  emit(nodeStartedEvent(forkNode.id, "fork"));
  if (!completedNodeIds.includes(forkNode.id))
    completedNodeIds.push(forkNode.id);

  // Get all outgoing targets from fork node
  const outgoing = outgoingEdges.get(forkNode.id) ?? [];
  const branchStartIds = getForkBranchStartIds(outgoing);

  const joinNode = findJoinNode(forkNode.forkId);
  const branchBaseState = structuredClone(runState);
  const branchBaseResults = new Map(nodeResults);

  // Start a parent span for the fork group
  const forkSpan = config.tracer?.startPhaseSpan(`fork:${forkNode.forkId}`, {
    attributes: {
      "forge.pipeline.node_type": "fork",
      "forge.pipeline.phase": forkNode.id,
    },
  });

  // Execute branches in parallel — each branch gets its own span
  const branchPromises = branchStartIds.map(async (startId) => {
    const restored = resume?.completedBranches[startId];
    if (restored) return restored;

    const branchSpan = config.tracer?.startPhaseSpan(`branch:${startId}`, {
      attributes: {
        "forge.pipeline.node_type": "branch",
        "forge.pipeline.phase": startId,
      },
    });
    try {
      const result = await executeBranch(
        deps,
        startId,
        joinNode?.id,
        branchBaseState,
        branchBaseResults
      );
      if (branchSpan) config.tracer?.endSpanOk(branchSpan);
      // Persist only successful branches (W4 design §4): a branch whose node
      // returned an error is NOT recorded in forkState, so it re-runs on resume
      // rather than being restored.
      if (resume && result.state === "completed") {
        await resume.onBranchComplete(startId, result);
      }
      return result;
    } catch (err) {
      if (branchSpan) config.tracer?.endSpanWithError(branchSpan, err);
      throw err;
    }
  });

  const settled = await Promise.allSettled(branchPromises);

  // Merge branch outputs deterministically in outgoing edge order.
  // Failed branches emit an error event but do not abort surviving branches.
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") {
      const br = outcome.value;
      mergeBranchExecutionResult(nodeResults, completedNodeIds, runState, br);
    } else {
      const branchStartId = branchStartIds[i]!;
      const errorMessage =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      emit(nodeFailedEvent(branchStartId, errorMessage));
    }
  }

  // End fork parent span
  if (forkSpan) config.tracer?.endSpanOk(forkSpan);

  emit(nodeCompletedEvent(forkNode.id, 0));
}

async function executeBranch(
  deps: ForkBranchExecutorDeps,
  startNodeId: string,
  joinNodeId: string | undefined,
  baseRunState: Record<string, unknown>,
  baseNodeResults: Map<string, NodeResult>
): Promise<BranchExecutionResult> {
  const { config, nodeMap, outgoingEdges, emit, runId } = deps;
  let currentId: string | undefined = startNodeId;
  const runState = structuredClone(baseRunState);
  const baselineState = structuredClone(baseRunState);
  const nodeResults = new Map(baseNodeResults);
  const branchNodeResults = new Map<string, NodeResult>();
  const completedNodeIds: string[] = [];
  let errored = false;

  while (currentId && currentId !== joinNodeId) {
    const node = nodeMap.get(currentId);
    if (!node) break;

    emit(nodeStartedEvent(node.id, node.type));

    // N3b: thread the real flow fingerprint + node attempt policy + node input
    // so branch-node keys are collision-proof across flow versions and inputs,
    // matching the sequential dispatch path.
    const idempotencyKey = nodeIdempotencyKey(runId, node.id, {
      flowDefinition: config.definition,
      ...nodeIdempotencyContext(node),
    });
    const context: NodeExecutionContext = omitUndefined({
      state: runState,
      previousResults: nodeResults,
      signal: config.signal,
      idempotencyKey,
    });

    // P2 (opt-in): run the branch node under the durable ledger so concurrent
    // branches get the same lease/fence/replay-skip guarantee as the sequential
    // path. When no ledger is configured this branch is skipped entirely and
    // the path below is byte-for-byte unchanged from pre-P2 behavior.
    const outcome =
      config.nodeLedger !== undefined
        ? await runBranchNodeUnderLedger(deps, node, idempotencyKey, context)
        : {
            kind: "ran" as const,
            result: await config.nodeExecutor(node.id, node, context),
          };

    if (outcome.kind === "replay") {
      // Replay-skip: a completed node replays its prior output without
      // re-executing. Record it as this branch node's result and continue.
      const replayResult: NodeResult = {
        nodeId: node.id,
        output: outcome.output,
        durationMs: 0,
      };
      nodeResults.set(node.id, replayResult);
      branchNodeResults.set(node.id, replayResult);
      completedNodeIds.push(node.id);
      emit(nodeCompletedEvent(node.id, 0));

      const nextIds = getNextNodeIds(
        node.id,
        outgoingEdges,
        config.predicates,
        runState
      );
      currentId = nextIds[0];
      continue;
    }

    if (outcome.kind === "busy") {
      // Held by a fresh lease elsewhere — mark this branch errored (without a
      // ledger result) so W4's onBranchComplete does NOT persist it and the
      // branch re-runs on resume. Do NOT abort sibling branches.
      emit(nodeFailedEvent(node.id, outcome.error));
      errored = true;
      break;
    }

    const result = outcome.result;
    nodeResults.set(node.id, result);
    branchNodeResults.set(node.id, result);
    completedNodeIds.push(node.id);

    if (result.error) {
      emit(nodeFailedEvent(node.id, result.error));
      errored = true;
      break;
    }

    if (outcome.kind === "fenced") {
      // Lease lost mid-execution (fenced out): a newer lease superseded us, so
      // this branch must NOT be committed as completed — re-run on resume.
      emit(nodeFailedEvent(node.id, outcome.error));
      errored = true;
      break;
    }

    emit(nodeCompletedEvent(node.id, result.durationMs));

    const nextIds = getNextNodeIds(
      node.id,
      outgoingEdges,
      config.predicates,
      runState
    );
    currentId = nextIds[0];
  }

  const stateDelta = collectStateDelta(baselineState, runState);

  return {
    state: errored ? "failed" : "completed",
    stateDelta,
    nodeResults: branchNodeResults,
    completedNodeIds,
  };
}

/**
 * Outcome of running one branch node under the durable ledger.
 *  - `replay`  → a prior completion was found; skip execution, use its output.
 *  - `busy`    → the node is held by a fresh lease elsewhere; branch errors.
 *  - `fenced`  → completion was fenced out mid-exec; branch errors (re-run).
 *  - `ran`     → executed under a lease and committed; carries the result
 *               (which may itself carry `result.error` for a soft failure).
 */
type BranchLedgerOutcome =
  | { kind: "replay"; output: unknown }
  | { kind: "busy"; error: string }
  | { kind: "fenced"; error: string; result: NodeResult }
  | { kind: "ran"; result: NodeResult };

/**
 * Run a single branch node under the ledger, mirroring the sequential path's
 * discipline (`dispatchStandardNode`): begin → replay | busy | lease; start a
 * heartbeat and thread its composite signal into the node context; run; on
 * success record the completion fence-gated (fenced-out → branch error); on a
 * soft error record a retryable failure. The heartbeat is always stopped in a
 * `finally`. Only called when `config.nodeLedger !== undefined`.
 */
async function runBranchNodeUnderLedger(
  deps: ForkBranchExecutorDeps,
  node: PipelineNode,
  idempotencyKey: string,
  context: NodeExecutionContext
): Promise<BranchLedgerOutcome> {
  const { config, runId } = deps;
  // Narrowed by the caller's `config.nodeLedger !== undefined` guard.
  const ledger = config.nodeLedger!;

  const begin = await beginNodeUnderLedger(
    ledger,
    runId,
    node.id,
    idempotencyKey,
    runId,
    Date.now()
  );

  if (begin.kind === "replay") {
    return { kind: "replay", output: begin.output };
  }
  if (begin.kind === "busy") {
    return {
      kind: "busy",
      error: `branch node "${node.id}" is leased by another worker`,
    };
  }

  const lease: NodeLeaseLike = begin.lease;
  const heartbeat: HeartbeatHandle = startNodeHeartbeat(
    ledger,
    runId,
    node.id,
    lease.owner,
    lease.fenceToken,
    config.signal
  );

  // Thread the heartbeat's composite signal (parent cancel OR lease loss) into
  // the node so a long-running branch node aborts promptly on lease loss.
  const ledgerContext: NodeExecutionContext = {
    ...context,
    signal: heartbeat.signal,
  };

  try {
    const result = await config.nodeExecutor(node.id, node, ledgerContext);

    if (result.error) {
      await failNodeUnderLedger(
        ledger,
        runId,
        node.id,
        idempotencyKey,
        lease,
        result.error,
        true
      );
      return { kind: "ran", result };
    }

    const committed = await completeNodeUnderLedger(
      ledger,
      runId,
      node.id,
      idempotencyKey,
      lease,
      result.output,
      result.durationMs
    );
    if (!committed) {
      return {
        kind: "fenced",
        error: `branch node "${node.id}" lease lost during execution (fenced out)`,
        result,
      };
    }

    return { kind: "ran", result };
  } finally {
    heartbeat.stop();
  }
}
