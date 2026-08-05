import {
  type FlowNode,
  type FlowNodeKind,
} from "@dzupagent/flow-ast";
import {
  FLOW_TYPED_CONDITION_CAPABILITY,
} from "@dzupagent/flow-ast/typed-condition-evaluator";

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
  // A kind missing from the registry can only come from a forward-version or
  // untyped (JS) artifact. Treat it as unsupported so readiness blocks instead
  // of crashing on an undefined descriptor.
  const unknownNodeKinds: FlowNodeKind[] = [];
  const descriptors = [...nodeKinds].flatMap((kind) => {
    const descriptor = FLOW_NODE_CAPABILITY_REGISTRY[kind] as
      | (typeof FLOW_NODE_CAPABILITY_REGISTRY)[FlowNodeKind]
      | undefined;
    if (descriptor === undefined) {
      unknownNodeKinds.push(kind);
      return [];
    }
    return [descriptor];
  });
  const requiredCapabilities = new Set<string>([
    TARGET_CAPABILITY_MANIFESTS[target].capability,
  ]);
  for (const item of descriptors) {
    for (const capability of item.runtimeCapabilities) {
      requiredCapabilities.add(capability);
    }
  }
  let hasTypedCondition = false;
  visitFlow(ast, (node) => {
    if (node.type === "branch" && node.typedCondition !== undefined) {
      hasTypedCondition = true;
    }
  });
  if (hasTypedCondition) {
    requiredCapabilities.add(FLOW_TYPED_CONDITION_CAPABILITY);
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
    unsupportedNodeKinds: [
      ...descriptors
        .filter((item) => item.status === "unsupported")
        .map((item) => item.kind),
      ...unknownNodeKinds,
    ].sort(),
  };
}

export interface ResolveHostReadinessOptions {
  /**
   * "default" preserves the historical gate: target + capability strings +
   * unsupported nodes. "release-strict" additionally blocks on `partial`
   * node kinds — flows whose nodes lower degraded or metadata-only must not
   * be promoted as ready for a release surface.
   */
  profile?: "default" | "release-strict";
}

export function resolveHostReadiness(
  requirements: FlowRequirementSummary,
  host: HostCapabilityManifest,
  options: ResolveHostReadinessOptions = {}
): HostReadinessResult {
  const profile = options.profile ?? "default";
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

  if (profile === "release-strict") {
    for (const nodeKind of requirements.partialNodeKinds) {
      const descriptor = FLOW_NODE_CAPABILITY_REGISTRY[nodeKind] as
        | (typeof FLOW_NODE_CAPABILITY_REGISTRY)[FlowNodeKind]
        | undefined;
      const detail = descriptor?.notes !== undefined ? ` ${descriptor.notes}` : "";
      diagnostics.push({
        code: "PARTIAL_NODE",
        message: `Node type "${nodeKind}" lowers only partially (${descriptor?.lowering ?? "unknown"}) and is blocked under the release-strict profile.${detail}`,
        nodeKind,
      });
    }
  }

  return {
    schema: "dzupagent.hostReadiness/v1",
    status: diagnostics.length === 0 ? "ready" : "blocked",
    host: host.host,
    target: requirements.target,
    diagnostics,
  };
}
