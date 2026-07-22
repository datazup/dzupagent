import type { FlowNodeBase } from "./primitives.js";

// ---------------------------------------------------------------------------
// spdd.* nodes — SPDD Phase 3 Slice 3.1 workflow node catalog. Each node is a
// thin adapter over an already-shipped codev-app SPDD/planning-execution
// service (see codev-app docs/superpowers/specs/2026-07-04-spdd-phase3-workflow-dsl-design.md).
// reads/writes contracts are declared via the existing FlowNodeMetadata
// (meta.requires / meta.produces / meta.artifacts), not a new AST field.
// ---------------------------------------------------------------------------

export type SpddImportSourcesNode = FlowNodeBase & {
  type: "spdd.import_sources";
  spddRunId: string;
  sourceRefs: unknown[];
  outputKey: string;
};

export type SpddBuildSourcePackNode = FlowNodeBase & {
  type: "spdd.build_source_pack";
  spddRunId: string;
  sourceRefsKey: string;
  featureId?: string;
  outputKey: string;
};

export type SpddRunAnalysisNode = FlowNodeBase & {
  type: "spdd.run_analysis";
  spddRunId: string;
  planArtifactId: string;
  sourceArtifactIds?: string[];
  outputKey: string;
};

export type SpddGenerateCanvasNode = FlowNodeBase & {
  type: "spdd.generate_canvas";
  spddRunId: string;
  promptAssetVersionId: string;
  title?: string;
  objective?: string;
  outputKey: string;
};

export type SpddValidateCanvasNode = FlowNodeBase & {
  type: "spdd.validate_canvas";
  spddRunId: string;
  promptAssetVersionId: string;
  outputKey: string;
};

export type SpddReviewCanvasNode = FlowNodeBase & {
  type: "spdd.review_canvas";
  spddRunId: string;
  promptAssetVersionId: string;
  outputKey: string;
};

export type SpddProjectPlanNode = FlowNodeBase & {
  type: "spdd.project_plan";
  spddRunId: string;
  promptAssetVersionId: string;
  outputKey: string;
};

export type SpddArmDispatchNode = FlowNodeBase & {
  type: "spdd.arm_dispatch";
  spddRunId: string;
  planRunId: string;
  outputKey: string;
};

export type SpddRunValidationNode = FlowNodeBase & {
  type: "spdd.run_validation";
  spddRunId: string;
  planRunId: string;
  executionRunId: string;
  reviewerId?: string;
  outputKey: string;
};

export type SpddCollectProofNode = FlowNodeBase & {
  type: "spdd.collect_proof";
  spddRunId: string;
  planRunId: string;
  taskId?: string;
  outputKey: string;
};

export type SpddScanDriftNode = FlowNodeBase & {
  type: "spdd.scan_drift";
  spddRunId: string;
  promptAssetVersionId: string;
  outputKey: string;
};

export type SpddCreateSyncProposalNode = FlowNodeBase & {
  type: "spdd.create_sync_proposal";
  spddRunId: string;
  driftFindingIdsKey: string;
  outputKey: string;
};

export type SpddSwarmSubTask = {
  role: string;
  personaRef?: string;
  input: Record<string, unknown>;
};

export type SpddAgentSwarmNode = FlowNodeBase & {
  type: "spdd.agent_swarm";
  spddRunId: string;
  subTasks: SpddSwarmSubTask[];
  outputKey: string;
};
