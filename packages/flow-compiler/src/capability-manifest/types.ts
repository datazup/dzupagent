import type { FlowNodeKind } from "@dzupagent/flow-ast";

import type { CompilationTarget } from "../types.js";

export type { FlowRequirementSummary } from "../types.js";

export type FlowNodeSupportStatus =
  | "supported"
  | "partial"
  | "host-only"
  | "unsupported";

export type FlowNodeLoweringMode =
  | "native"
  | "runtime-leaf"
  | "metadata-only"
  | "degraded"
  | "unsupported";

export type FlowCapabilityOwner = "dzupagent" | "host" | "codev";

export type RecommendedFlowProfile =
  | "dzup.core@1"
  | "dzup.llm@1"
  | "dzup.agent@1"
  | "dzup.adapters@1"
  | "dzup.sdlc@1"
  | "dzup.rag@1"
  | "dzup.fleet@1"
  | "codev.spdd@1";

export interface FlowNodeCapabilityDescriptor {
  kind: FlowNodeKind;
  status: FlowNodeSupportStatus;
  lowering: FlowNodeLoweringMode;
  currentRoute: CompilationTarget;
  recommendedProfile: RecommendedFlowProfile;
  owner: FlowCapabilityOwner;
  parser: "supported";
  validator: "supported";
  runtimeCapabilities: string[];
  extensionCandidate: boolean;
  deprecated: boolean;
  notes?: string;
}

export interface TargetCapabilityLimitation {
  code: string;
  message: string;
}

export interface TargetCapabilityManifest {
  schema: "dzupagent.targetCapabilityManifest/v1";
  target: CompilationTarget;
  version: "0.2.0";
  capability: string;
  routeFeatures: string[];
  executionModel: "inline" | "hybrid";
  durabilityModes: Array<"volatile" | "checkpointed">;
  limitations: TargetCapabilityLimitation[];
}

export interface HostCapabilityManifest {
  schema: "dzupagent.hostCapabilityManifest/v1";
  host: string;
  version: string;
  targets: CompilationTarget[];
  capabilities: string[];
}

export interface HostReadinessDiagnostic {
  code: "UNSUPPORTED_TARGET" | "MISSING_CAPABILITY" | "UNSUPPORTED_NODE";
  message: string;
  target?: CompilationTarget;
  capability?: string;
  nodeKind?: FlowNodeKind;
}

export interface HostReadinessResult {
  schema: "dzupagent.hostReadiness/v1";
  status: "ready" | "blocked";
  host: string;
  target: CompilationTarget;
  diagnostics: HostReadinessDiagnostic[];
}

export type FlowValidationProfileId =
  | "authoring-fast"
  | "compiler-focused"
  | "runtime-fixture";

export interface FlowValidationProfile {
  id: FlowValidationProfileId;
  gates: string[];
  requiresHostManifest: boolean;
}

export interface FlowConformanceMatrix {
  schema: "dzupagent.flowConformanceMatrix/v1";
  generatedFrom: "FLOW_NODE_KIND_REGISTRY";
  nodes: FlowNodeCapabilityDescriptor[];
  targets: TargetCapabilityManifest[];
  validationProfiles: FlowValidationProfile[];
}
