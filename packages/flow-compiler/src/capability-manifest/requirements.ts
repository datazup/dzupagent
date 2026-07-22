import { type FlowNode, type FlowNodeKind } from "@dzupagent/flow-ast";

import { routeTarget } from "../route-target.js";
import type { FlowRequirementSummary } from "../types.js";
import { semanticHash, visitFlow } from "./hashing.js";
import { FLOW_NODE_CAPABILITY_REGISTRY } from "./node-registry.js";
import { TARGET_CAPABILITY_MANIFESTS } from "./target-manifests.js";
import type {
  HostCapabilityManifest,
  HostReadinessDiagnostic,
  HostReadinessResult,
} from "./types.js";

export function collectFlowRequirements(ast: FlowNode): FlowRequirementSummary {
  const nodeKinds = new Set<FlowNodeKind>();
  visitFlow(ast, (node) => nodeKinds.add(node.type));

  const target = routeTarget(ast).target;
  const descriptors = [...nodeKinds].map(
    (kind) => FLOW_NODE_CAPABILITY_REGISTRY[kind]
  );
  const requiredCapabilities = new Set<string>([
    TARGET_CAPABILITY_MANIFESTS[target].capability,
  ]);
  for (const item of descriptors) {
    for (const capability of item.runtimeCapabilities) {
      requiredCapabilities.add(capability);
    }
  }

  return {
    schema: "dzupagent.flowRequirements/v1",
    target,
    semanticHash: semanticHash(ast),
    nodeKinds: [...nodeKinds].sort(),
    requiredCapabilities: [...requiredCapabilities].sort(),
    partialNodeKinds: descriptors
      .filter((item) => item.status === "partial")
      .map((item) => item.kind)
      .sort(),
    unsupportedNodeKinds: descriptors
      .filter((item) => item.status === "unsupported")
      .map((item) => item.kind)
      .sort(),
  };
}

export function resolveHostReadiness(
  requirements: FlowRequirementSummary,
  host: HostCapabilityManifest
): HostReadinessResult {
  const diagnostics: HostReadinessDiagnostic[] = [];

  if (!host.targets.includes(requirements.target)) {
    diagnostics.push({
      code: "UNSUPPORTED_TARGET",
      message: `Host "${host.host}" does not support target "${requirements.target}".`,
      target: requirements.target,
    });
  }

  const hostCapabilities = new Set(host.capabilities);
  for (const capability of requirements.requiredCapabilities) {
    if (!hostCapabilities.has(capability)) {
      diagnostics.push({
        code: "MISSING_CAPABILITY",
        message: `Host "${host.host}" is missing required capability "${capability}".`,
        capability,
      });
    }
  }

  for (const nodeKind of requirements.unsupportedNodeKinds) {
    diagnostics.push({
      code: "UNSUPPORTED_NODE",
      message: `Node type "${nodeKind}" is unsupported by current generic compiler targets.`,
      nodeKind,
    });
  }

  return {
    schema: "dzupagent.hostReadiness/v1",
    status: diagnostics.length === 0 ? "ready" : "blocked",
    host: host.host,
    target: requirements.target,
    diagnostics,
  };
}
