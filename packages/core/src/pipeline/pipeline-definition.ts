/**
 * Pipeline definition types — re-exported from their canonical home in the
 * runtime-contracts pipeline-artifact subpath (ARCH27-T-07 moved them so the
 * flow compiler can consume the artifact contract without a runtime edge
 * into core). This module remains the compatibility surface for existing
 * core consumers.
 *
 * @module pipeline/pipeline-definition
 */

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
  PipelineSchemaVersion,
  PipelineDefinition,
  PipelineValidationError,
  PipelineValidationWarning,
  PipelineValidationResult,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
export { PIPELINE_SCHEMA_VERSIONS } from "@dzupagent/runtime-contracts/pipeline-artifact";
