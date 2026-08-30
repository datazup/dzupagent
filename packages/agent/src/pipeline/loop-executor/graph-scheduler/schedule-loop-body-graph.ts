import type { LoopNode } from "@dzupagent/runtime-contracts/pipeline-artifact";

import { loopBoundary } from "../../loop-body-graph-checkpoint-validator.js";
import type { RunFrame } from "../../executor-internals/run-frame.js";
import type {
  ScopedGraphExecutorDeps,
  ScopedGraphFrameCodec,
} from "../../scoped-graph/contract.js";
import { executeScopedGraph } from "../../scoped-graph/execute-scoped-graph.js";
import type {
  LoopBodyGraphCheckpointState,
  LoopBodyGraphScheduleInput,
  LoopBodyGraphScheduleResult,
} from "../types.js";

/** Loop-owned dependency spelling retained for callers of the legacy adapter. */
export interface LoopBodyGraphSchedulerDeps extends ScopedGraphExecutorDeps {}

const LOOP_BODY_GRAPH_FRAME_CODEC: ScopedGraphFrameCodec<LoopBodyGraphCheckpointState> =
  {
    decode: (frame) => frame,
    encode: (frame) => frame,
  };

/**
 * Thin loop adapter over the reusable scoped graph kernel.
 *
 * The identity frame codec is intentional: it proves extraction does not add,
 * remove, rename, or reorder fields in the retained loop-body wire object.
 */
export async function scheduleLoopBodyGraph(
  deps: LoopBodyGraphSchedulerDeps,
  loopNode: LoopNode,
  outerFrame: RunFrame,
  input: LoopBodyGraphScheduleInput
): Promise<LoopBodyGraphScheduleResult> {
  const result = await executeScopedGraph(
    deps,
    loopBoundary(loopNode, deps.config.definition.id),
    outerFrame,
    {
      scopedRunId: `${outerFrame.runId}::loop:${loopNode.id}:iteration:${input.iteration}`,
      context: input.context,
      ...(input.resumeState === undefined
        ? {}
        : { resumeFrame: input.resumeState }),
      ...(input.onCheckpoint === undefined
        ? {}
        : { onCheckpoint: input.onCheckpoint }),
    },
    LOOP_BODY_GRAPH_FRAME_CODEC
  );

  return {
    outcome: result.outcome,
    state: result.state,
    bodyResults: result.nodeResults,
    ...(result.lastResult === undefined ? {} : { lastResult: result.lastResult }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.checkpointFrame === undefined
      ? {}
      : { checkpointState: result.checkpointFrame }),
  };
}
