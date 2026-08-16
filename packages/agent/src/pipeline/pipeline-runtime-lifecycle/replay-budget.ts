import type {
  NodeResult,
  PipelineRunResult,
} from "../pipeline-runtime-types.js";
import type { ResumeHost } from "./resume-context.js";

/** Shared terminal for a `resume.maxReplayNodes` budget breach. */
export function failReplayBudgetExceeded(
  host: ResumeHost,
  args: {
    runId: string;
    nodeResults: Map<string, NodeResult>;
    replayNodeCount: number;
    maxReplayNodes: number;
    startTime: number;
  },
): PipelineRunResult {
  const errorMessage =
    `Resume replay budget exceeded: ${args.replayNodeCount} nodes would replay, ` +
    `maxReplayNodes is ${args.maxReplayNodes}.`;
  host.setState("failed");
  host.emitFailed(args.runId, errorMessage);
  return {
    pipelineId: host.config.definition.id,
    runId: args.runId,
    state: "failed",
    nodeResults: args.nodeResults,
    totalDurationMs: Date.now() - args.startTime,
    error: errorMessage,
  };
}
/**
 * Enforce the `resume.maxReplayNodes` budget for a re-entry at `startNodeId`.
 * Returns a failed `PipelineRunResult` when the budget is exceeded, or
 * `undefined` when the resume may proceed (no budget set, or within it).
 */
export function enforceReplayBudget(
  host: ResumeHost,
  args: {
    startNodeId: string;
    runId: string;
    runState: Record<string, unknown>;
    completedNodeIds: string[];
    nodeResults: Map<string, NodeResult>;
    startTime: number;
  },
): PipelineRunResult | undefined {
  const maxReplayNodes = host.config.definition.resume?.maxReplayNodes;
  if (maxReplayNodes === undefined) return undefined;

  const replayNodeCount = host.countReplayNodesFrom(
    args.startNodeId,
    args.runState,
    args.completedNodeIds,
  );
  if (replayNodeCount > maxReplayNodes) {
    return failReplayBudgetExceeded(host, {
      runId: args.runId,
      nodeResults: args.nodeResults,
      replayNodeCount,
      maxReplayNodes,
      startTime: args.startTime,
    });
  }
  return undefined;
}
