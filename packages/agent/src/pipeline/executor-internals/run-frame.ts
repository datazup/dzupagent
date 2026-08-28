import type {
  PipelineCheckpoint,
  PipelineInteractionResumeCursor,
} from "@dzupagent/core/pipeline";
import type {
  PipelineInteractionResumeV1,
  PipelinePendingInteractionV1,
  PipelineSha256Digest,
} from "@dzupagent/runtime-contracts";

import type { NodeResult, PipelineRuntimeEvent } from "../pipeline-runtime-types.js";
import type { ForkState, LoopState } from "./executor-state-types.js";

/** Per-run mutable state threaded through pipeline and scoped-graph dispatch. */
export interface RunFrame {
  runId: string;
  runState: Record<string, unknown>;
  nodeResults: Map<string, NodeResult>;
  completedNodeIds: string[];
  nodeIdempotencyKeys: Record<string, string>;
  loopState: LoopState;
  forkState: ForkState;
  eventLog: PipelineRuntimeEvent[];
  versionTracker: { version: number };
  pendingInteraction?: PipelinePendingInteractionV1;
  interactionReceipts: Record<string, PipelineInteractionResumeV1>;
  interactionResumeCursor?: PipelineInteractionResumeCursor;
  /** Definition-bound ordered-source digests for reached for_each loops. */
  loopSourceDigests?: Record<string, PipelineSha256Digest>;
  /** Durable public recursive-fork parent completion receipts. */
  recursiveForkCompletions?: NonNullable<
    PipelineCheckpoint["recursiveForkCompletions"]
  >;
  startTime: number;
}
