/**
 * Pipeline module — definition types, checkpoint store, and serialization.
 *
 * @module pipeline
 */

// --- Definition types ---
export type {
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
  PipelineDefinition,
  PipelineValidationError,
  PipelineValidationWarning,
  PipelineValidationResult,
} from './pipeline-definition.js'

// --- Checkpoint store types ---
export type {
  PipelineCheckpoint,
  PipelineCheckpointSummary,
  PipelineCheckpointStore,
} from './pipeline-checkpoint-store.js'

// --- Serialization ---
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
} from './pipeline-serialization.js'

// --- Layout ---
export { autoLayout } from './pipeline-layout.js'
export type { NodePosition, ViewportState, PipelineLayout } from './pipeline-layout.js'
