import {
  FLOW_NODE_CAPABILITY_REGISTRY,
  type FlowCapabilityOwner,
  type RecommendedFlowProfile,
} from "../capability-manifest.js";

import { type FlowProfileLowering, type FlowProfileManifest } from "./types.js";

interface ProfileDefinition {
  namespace: string;
  name: string;
  owner: FlowCapabilityOwner;
  lowering: FlowProfileLowering;
  portable: boolean;
}

const PROFILE_DEFINITIONS = {
  "dzup.core@1": {
    namespace: "dzup",
    name: "core",
    owner: "dzupagent",
    lowering: "core-ir",
    portable: true,
  },
  "dzup.llm@1": {
    namespace: "dzup",
    name: "llm",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "dzup.agent@1": {
    namespace: "dzup",
    name: "agent",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "dzup.adapters@1": {
    namespace: "dzup",
    name: "adapters",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "dzup.sdlc@1": {
    namespace: "dzup",
    name: "sdlc",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "dzup.rag@1": {
    namespace: "dzup",
    name: "rag",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "dzup.fleet@1": {
    namespace: "dzup",
    name: "fleet",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "codev.spdd@1": {
    namespace: "codev",
    name: "spdd",
    owner: "codev",
    lowering: "opaque-host-action",
    portable: false,
  },
} as const satisfies Record<RecommendedFlowProfile, ProfileDefinition>;

export const FLOW_PROFILE_MANIFESTS = Object.fromEntries(
  Object.entries(PROFILE_DEFINITIONS).map(([ref, definition]) => {
    const profileRef = ref as RecommendedFlowProfile;
    const descriptors = Object.values(FLOW_NODE_CAPABILITY_REGISTRY).filter(
      (descriptor) => descriptor.recommendedProfile === profileRef
    );
    const manifest: FlowProfileManifest = {
      schema: "dzupagent.flowProfileManifest/v1",
      ref: profileRef,
      namespace: definition.namespace,
      name: definition.name,
      version: "1.0.0",
      kind: profileRef === "dzup.core@1" ? "kernel" : "extension",
      owner: definition.owner,
      lowering: definition.lowering,
      portable: definition.portable,
      nodeKinds: descriptors.map((descriptor) => descriptor.kind).sort(),
      capabilities: [
        ...new Set(
          descriptors.flatMap((descriptor) => descriptor.runtimeCapabilities)
        ),
      ].sort(),
      dependencies: profileRef === "dzup.core@1" ? [] : ["dzup.core@1"],
    };
    return [profileRef, manifest];
  })
) as Record<RecommendedFlowProfile, FlowProfileManifest>;
