/**
 * Barrel for the flow-compiler capability manifest surface.
 *
 * The implementation was decomposed into focused leaf modules under
 * `./capability-manifest/`. This file preserves the exact public export
 * surface (types + values) that consumers import from
 * `./capability-manifest.js`.
 */

export type { FlowRequirementSummary } from "./types.js";

export type {
  FlowCapabilityOwner,
  FlowConformanceMatrix,
  FlowNodeCapabilityDescriptor,
  FlowNodeLoweringMode,
  FlowNodeSupportStatus,
  FlowValidationProfile,
  FlowValidationProfileId,
  HostCapabilityManifest,
  HostReadinessDiagnostic,
  HostReadinessResult,
  RecommendedFlowProfile,
  TargetCapabilityLimitation,
  TargetCapabilityManifest,
} from "./capability-manifest/types.js";

export { FLOW_NODE_CAPABILITY_REGISTRY } from "./capability-manifest/node-registry.js";

export {
  DZUPAGENT_PIPELINE_HOST_MANIFEST,
  FLOW_VALIDATION_PROFILES,
  TARGET_CAPABILITY_MANIFESTS,
} from "./capability-manifest/target-manifests.js";

export {
  collectFlowRequirements,
  resolveHostReadiness,
} from "./capability-manifest/requirements.js";

export {
  generateFlowConformanceMatrix,
  renderFlowConformanceMatrixMarkdown,
} from "./capability-manifest/conformance-matrix.js";
