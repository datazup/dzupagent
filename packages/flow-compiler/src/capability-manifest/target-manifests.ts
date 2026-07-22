import type { CompilationTarget } from "../types.js";
import type {
  FlowValidationProfile,
  FlowValidationProfileId,
  HostCapabilityManifest,
  TargetCapabilityManifest,
} from "./types.js";

export const TARGET_CAPABILITY_MANIFESTS = {
  "skill-chain": {
    schema: "dzupagent.targetCapabilityManifest/v1",
    target: "skill-chain",
    version: "0.2.0",
    capability: "flow.target.skill-chain@1",
    routeFeatures: ["sequential"],
    executionModel: "inline",
    durabilityModes: ["volatile"],
    limitations: [
      {
        code: "ACTION_ANCHOR_REQUIRED",
        message: "At least one executable action step is required.",
      },
      {
        code: "NO_RUNTIME_LEAVES",
        message: "Runtime leaves route to planning-dag instead.",
      },
    ],
  },
  "workflow-builder": {
    schema: "dzupagent.targetCapabilityManifest/v1",
    target: "workflow-builder",
    version: "0.2.0",
    capability: "flow.target.workflow-builder@1",
    routeFeatures: ["branch", "parallel", "suspend"],
    executionModel: "inline",
    durabilityModes: ["volatile", "checkpointed"],
    limitations: [
      {
        code: "NO_FOR_EACH",
        message: "for_each and loop route to pipeline.",
      },
      {
        code: "NO_RUNTIME_LEAF_ROUTING",
        message: "Runtime leaves route to planning-dag.",
      },
    ],
  },
  pipeline: {
    schema: "dzupagent.targetCapabilityManifest/v1",
    target: "pipeline",
    version: "0.2.0",
    capability: "flow.target.pipeline@1",
    routeFeatures: ["for_each", "loop"],
    executionModel: "hybrid",
    durabilityModes: ["volatile", "checkpointed"],
    limitations: [],
  },
  "planning-dag": {
    schema: "dzupagent.targetCapabilityManifest/v1",
    target: "planning-dag",
    version: "0.2.0",
    capability: "flow.target.planning-dag@1",
    routeFeatures: ["runtime-leaf"],
    executionModel: "hybrid",
    durabilityModes: ["volatile", "checkpointed"],
    limitations: [
      {
        code: "HOST_HANDLERS_REQUIRED",
        message: "Runtime leaf tool names require matching host handlers.",
      },
      {
        code: "NO_FOR_EACH",
        message: "for_each and loop take routing precedence and use pipeline.",
      },
    ],
  },
} as const satisfies Record<CompilationTarget, TargetCapabilityManifest>;

/**
 * Conservative manifest for the built-in DzupAgent PipelineRuntime surface.
 * Optional runtime tool ports are intentionally absent; a host that wires
 * them must publish its own manifest with the additional capabilities.
 */
export const DZUPAGENT_PIPELINE_HOST_MANIFEST: HostCapabilityManifest = {
  schema: "dzupagent.hostCapabilityManifest/v1",
  host: "dzupagent.pipeline-runtime",
  version: "0.2.0",
  targets: ["workflow-builder", "pipeline", "planning-dag"],
  capabilities: [
    TARGET_CAPABILITY_MANIFESTS["workflow-builder"].capability,
    TARGET_CAPABILITY_MANIFESTS.pipeline.capability,
    TARGET_CAPABILITY_MANIFESTS["planning-dag"].capability,
    "flow.runtime.set@1",
  ],
};

export const FLOW_VALIDATION_PROFILES = {
  "authoring-fast": {
    id: "authoring-fast",
    gates: ["parse", "document-shape", "output-key-uniqueness"],
    requiresHostManifest: false,
  },
  "compiler-focused": {
    id: "compiler-focused",
    gates: [
      "parse",
      "document-shape",
      "output-key-uniqueness",
      "semantic-resolution",
      "target-lowering",
      "requirement-summary",
    ],
    requiresHostManifest: false,
  },
  "runtime-fixture": {
    id: "runtime-fixture",
    gates: [
      "parse",
      "document-shape",
      "output-key-uniqueness",
      "semantic-resolution",
      "target-lowering",
      "requirement-summary",
      "host-readiness",
      "runtime-fixture",
      "evidence-assertions",
    ],
    requiresHostManifest: true,
  },
} as const satisfies Record<FlowValidationProfileId, FlowValidationProfile>;
