/**
 * Pipeline module — definition types, checkpoint store, and serialization.
 *
 * @module pipeline
 */

// --- Definition types ---
export type {
  NodeRetryPolicy,
  PipelineNodeSource,
  PipelineNodeBase,
  AgentNode,
  ToolNode,
  TransformNode,
  GateNode,
  ForkNode,
  JoinNode,
  LoopNode,
  SuspendNode,
  PipelineNode,
  SequentialEdge,
  ConditionalEdge,
  ErrorEdge,
  PipelineEdge,
  CheckpointStrategy,
  PipelineResumePolicy,
  PipelineCheckpointRetentionPolicy,
  PipelineCheckpointPolicy,
  PipelineExecutionLogPolicy,
  PipelineDefinition,
  PipelineSchemaVersion,
  PipelineValidationError,
  PipelineValidationWarning,
  PipelineValidationResult,
} from "./pipeline-definition.js";

// --- Checkpoint store types ---
export type {
  PipelineCheckpoint,
  PipelineCheckpointCommitReceipt,
  PipelineCheckpointSourceBinding,
  PipelineExecutionScope,
  PipelineForEachItemFrame,
  PipelineLedgerUnavailablePolicy,
  PipelineInteractionResumeCursor,
  PipelineLoopBodyGraphCheckpointOutcome,
  PipelineLoopBodyGraphCheckpointState,
  PipelineLoopCheckpointState,
  PipelineCheckpointEventRecord,
  PipelineCheckpointExecutionLog,
  PipelineCheckpointProviderSessionRef,
  PipelineCheckpointSummary,
  PipelineCheckpointStore,
} from "./pipeline-checkpoint-store.js";

// --- Serialization ---
export { PIPELINE_SCHEMA_VERSIONS } from "./pipeline-definition.js";

export {
  // Zod schemas
  AgentNodeSchema,
  ToolNodeSchema,
  TransformNodeSchema,
  GateNodeSchema,
  ForkNodeSchema,
  JoinNodeSchema,
  LoopNodeSchema,
  SuspendNodeSchema,
  PipelineNodeSchema,
  SequentialEdgeSchema,
  ConditionalEdgeSchema,
  ErrorEdgeSchema,
  PipelineEdgeSchema,
  PipelineCheckpointSchema,
  PipelineDefinitionSchema,
  // Functions
  serializePipeline,
  deserializePipeline,
} from "./pipeline-serialization.js";

// --- Layout ---
export { autoLayout } from "./pipeline-layout.js";
export type {
  NodePosition,
  ViewportState,
  PipelineLayout,
} from "./pipeline-layout.js";
