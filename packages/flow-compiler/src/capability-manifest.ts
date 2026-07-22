import { createHash } from "node:crypto";

import {
  FLOW_NODE_KINDS,
  type FlowNode,
  type FlowNodeKind,
} from "@dzupagent/flow-ast";

import { routeTarget } from "./route-target.js";
import type { CompilationTarget, FlowRequirementSummary } from "./types.js";

export type { FlowRequirementSummary } from "./types.js";

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

interface DescriptorOptions {
  status: FlowNodeSupportStatus;
  lowering: FlowNodeLoweringMode;
  currentRoute: CompilationTarget;
  recommendedProfile: RecommendedFlowProfile;
  owner?: FlowCapabilityOwner;
  runtimeCapabilities?: string[];
  notes?: string;
}

function descriptor(
  kind: FlowNodeKind,
  options: DescriptorOptions
): FlowNodeCapabilityDescriptor {
  return {
    kind,
    status: options.status,
    lowering: options.lowering,
    currentRoute: options.currentRoute,
    recommendedProfile: options.recommendedProfile,
    owner: options.owner ?? "dzupagent",
    parser: "supported",
    validator: "supported",
    runtimeCapabilities: options.runtimeCapabilities ?? [],
    extensionCandidate: options.recommendedProfile !== "dzup.core@1",
    deprecated: false,
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
  };
}

function runtimeCapability(kind: FlowNodeKind): string[] {
  return [`flow.runtime.${kind}@1`];
}

const native = (
  kind: FlowNodeKind,
  currentRoute: CompilationTarget,
  recommendedProfile: RecommendedFlowProfile = "dzup.core@1",
  notes?: string
): FlowNodeCapabilityDescriptor =>
  descriptor(kind, {
    status: "supported",
    lowering: "native",
    currentRoute,
    recommendedProfile,
    ...(notes !== undefined ? { notes } : {}),
  });

const partial = (
  kind: FlowNodeKind,
  currentRoute: CompilationTarget,
  recommendedProfile: RecommendedFlowProfile,
  lowering: Exclude<FlowNodeLoweringMode, "native" | "unsupported">,
  notes: string
): FlowNodeCapabilityDescriptor =>
  descriptor(kind, {
    status: "partial",
    lowering,
    currentRoute,
    recommendedProfile,
    runtimeCapabilities: runtimeCapability(kind),
    notes,
  });

const hostOnly = (
  kind: FlowNodeKind,
  recommendedProfile: RecommendedFlowProfile,
  owner: FlowCapabilityOwner = "host",
  notes?: string
): FlowNodeCapabilityDescriptor =>
  descriptor(kind, {
    status: "host-only",
    lowering: "runtime-leaf",
    currentRoute: "planning-dag",
    recommendedProfile,
    owner,
    runtimeCapabilities: runtimeCapability(kind),
    ...(notes !== undefined ? { notes } : {}),
  });

/**
 * Current node support truth, keyed exhaustively by the public FlowNode union.
 *
 * `recommendedProfile` records the target architecture without claiming that
 * profile resolution exists today. `currentRoute` and `lowering` describe the
 * compiler that is shipped now.
 */
export const FLOW_NODE_CAPABILITY_REGISTRY = {
  sequence: native("sequence", "skill-chain"),
  action: native("action", "skill-chain"),
  for_each: native("for_each", "pipeline"),
  branch: native("branch", "workflow-builder"),
  approval: native("approval", "workflow-builder"),
  clarification: native("clarification", "workflow-builder"),
  persona: native("persona", "workflow-builder", "dzup.llm@1"),
  route: native("route", "workflow-builder", "dzup.adapters@1"),
  parallel: native("parallel", "workflow-builder"),
  complete: partial(
    "complete",
    "skill-chain",
    "dzup.core@1",
    "degraded",
    "Terminal semantics are native in pipeline artifacts but need an executable anchor in skill-chain flows."
  ),
  spawn: partial(
    "spawn",
    "skill-chain",
    "dzup.agent@1",
    "metadata-only",
    "Preserved as artifact metadata; execution remains host-owned."
  ),
  classify: partial(
    "classify",
    "skill-chain",
    "dzup.llm@1",
    "metadata-only",
    "Preserved as artifact metadata; execution remains host-owned."
  ),
  emit: partial(
    "emit",
    "skill-chain",
    "dzup.core@1",
    "metadata-only",
    "Event emission is not represented as an executable generic target node."
  ),
  memory: partial(
    "memory",
    "skill-chain",
    "dzup.rag@1",
    "degraded",
    "Skill-chain has a memory projection; graph targets retain metadata only."
  ),
  set: descriptor("set", {
    status: "supported",
    lowering: "runtime-leaf",
    currentRoute: "planning-dag",
    recommendedProfile: "dzup.core@1",
    runtimeCapabilities: runtimeCapability("set"),
    notes:
      "Pure state mutation lowers to the DzupAgent pipeline runtime's built-in set handler.",
  }),
  checkpoint: partial(
    "checkpoint",
    "skill-chain",
    "dzup.core@1",
    "metadata-only",
    "Checkpoint policy is carried separately; the node is not a generic executable graph node."
  ),
  restore: partial(
    "restore",
    "skill-chain",
    "dzup.core@1",
    "metadata-only",
    "Restore policy is carried separately; the node is not a generic executable graph node."
  ),
  try_catch: partial(
    "try_catch",
    "workflow-builder",
    "dzup.core@1",
    "degraded",
    "The try body lowers; catch-path execution remains runtime-owned."
  ),
  loop: partial(
    "loop",
    "pipeline",
    "dzup.core@1",
    "degraded",
    "The loop body lowers but the authored condition is runtime-owned."
  ),
  http: partial(
    "http",
    "skill-chain",
    "dzup.core@1",
    "metadata-only",
    "HTTP execution requires a host handler and is not emitted as a generic target node."
  ),
  wait: partial(
    "wait",
    "skill-chain",
    "dzup.core@1",
    "metadata-only",
    "Durable timer/event wait semantics are not normalized in generic targets."
  ),
  subflow: partial(
    "subflow",
    "skill-chain",
    "dzup.core@1",
    "metadata-only",
    "Subflows must be inlined before lowering or executed by a host."
  ),
  prompt: hostOnly("prompt", "dzup.llm@1"),
  return_to: hostOnly(
    "return_to",
    "dzup.core@1",
    "host",
    "Compatibility leaf for hosts with bounded return-region semantics; portable flows should prefer loop."
  ),
  agent: hostOnly("agent", "dzup.agent@1"),
  validate: hostOnly("validate", "dzup.sdlc@1"),
  "worker.dispatch": hostOnly("worker.dispatch", "dzup.fleet@1"),
  "fleet.dispatch": partial(
    "fleet.dispatch",
    "skill-chain",
    "dzup.fleet@1",
    "metadata-only",
    "Collected into fleetSteps side metadata for a host runtime."
  ),
  "fleet.gather": partial(
    "fleet.gather",
    "skill-chain",
    "dzup.fleet@1",
    "metadata-only",
    "Collected into fleetSteps side metadata for a host runtime."
  ),
  "fleet.contract-net": partial(
    "fleet.contract-net",
    "skill-chain",
    "dzup.fleet@1",
    "metadata-only",
    "Collected into fleetSteps side metadata for a host runtime."
  ),
  "knowledge.write": partial(
    "knowledge.write",
    "skill-chain",
    "dzup.rag@1",
    "metadata-only",
    "Knowledge execution is host-owned and not emitted as a generic target node."
  ),
  "knowledge.query": partial(
    "knowledge.query",
    "skill-chain",
    "dzup.rag@1",
    "metadata-only",
    "Knowledge execution is host-owned and not emitted as a generic target node."
  ),
  "shell.run": hostOnly("shell.run", "dzup.sdlc@1"),
  "evidence.write": hostOnly("evidence.write", "dzup.sdlc@1"),
  "validate.schema": hostOnly("validate.schema", "dzup.sdlc@1"),
  "adapter.run": hostOnly("adapter.run", "dzup.adapters@1"),
  "adapter.race": hostOnly("adapter.race", "dzup.adapters@1"),
  "adapter.parallel": hostOnly("adapter.parallel", "dzup.adapters@1"),
  "adapter.supervisor": hostOnly("adapter.supervisor", "dzup.adapters@1"),
  "spdd.import_sources": hostOnly(
    "spdd.import_sources",
    "codev.spdd@1",
    "codev"
  ),
  "spdd.build_source_pack": hostOnly(
    "spdd.build_source_pack",
    "codev.spdd@1",
    "codev"
  ),
  "spdd.run_analysis": hostOnly("spdd.run_analysis", "codev.spdd@1", "codev"),
  "spdd.generate_canvas": hostOnly(
    "spdd.generate_canvas",
    "codev.spdd@1",
    "codev"
  ),
  "spdd.validate_canvas": hostOnly(
    "spdd.validate_canvas",
    "codev.spdd@1",
    "codev"
  ),
  "spdd.review_canvas": hostOnly("spdd.review_canvas", "codev.spdd@1", "codev"),
  "spdd.project_plan": hostOnly("spdd.project_plan", "codev.spdd@1", "codev"),
  "spdd.arm_dispatch": hostOnly("spdd.arm_dispatch", "codev.spdd@1", "codev"),
  "spdd.run_validation": hostOnly(
    "spdd.run_validation",
    "codev.spdd@1",
    "codev"
  ),
  "spdd.collect_proof": hostOnly("spdd.collect_proof", "codev.spdd@1", "codev"),
  "spdd.scan_drift": hostOnly("spdd.scan_drift", "codev.spdd@1", "codev"),
  "spdd.create_sync_proposal": hostOnly(
    "spdd.create_sync_proposal",
    "codev.spdd@1",
    "codev"
  ),
  "spdd.agent_swarm": hostOnly("spdd.agent_swarm", "codev.spdd@1", "codev"),
} as const satisfies Record<FlowNodeKind, FlowNodeCapabilityDescriptor>;

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

export function generateFlowConformanceMatrix(): FlowConformanceMatrix {
  return {
    schema: "dzupagent.flowConformanceMatrix/v1",
    generatedFrom: "FLOW_NODE_KIND_REGISTRY",
    nodes: FLOW_NODE_KINDS.map((kind) => FLOW_NODE_CAPABILITY_REGISTRY[kind]),
    targets: Object.values(TARGET_CAPABILITY_MANIFESTS),
    validationProfiles: Object.values(FLOW_VALIDATION_PROFILES),
  };
}

export function renderFlowConformanceMatrixMarkdown(
  matrix: FlowConformanceMatrix = generateFlowConformanceMatrix()
): string {
  const lines = [
    "# Flow Node And Target Conformance Matrix",
    "",
    "> Generated from the public `FLOW_NODE_KIND_REGISTRY` and the compiler capability manifests. Do not edit by hand.",
    "",
    `Schema: \`${matrix.schema}\``,
    "",
    "## Nodes",
    "",
    "| Node | Parse | Validate | Status | Lowering | Current route | Recommended profile | Owner | Runtime requirements | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const node of matrix.nodes) {
    lines.push(
      `| \`${node.kind}\` | yes | yes | ${node.status} | ${node.lowering} | \`${
        node.currentRoute
      }\` | \`${node.recommendedProfile}\` | ${node.owner} | ${
        node.runtimeCapabilities.map((item) => `\`${item}\``).join("<br>") ||
        "none"
      } | ${escapeTableCell(node.notes ?? "")} |`
    );
  }

  lines.push("", "## Targets", "");
  lines.push(
    "| Target | Capability | Route features | Execution | Durability | Limitations |",
    "| --- | --- | --- | --- | --- | --- |"
  );
  for (const target of matrix.targets) {
    lines.push(
      `| \`${target.target}\` | \`${
        target.capability
      }\` | ${target.routeFeatures.join(", ")} | ${
        target.executionModel
      } | ${target.durabilityModes.join(", ")} | ${target.limitations
        .map((item) => `\`${item.code}\`: ${escapeTableCell(item.message)}`)
        .join("<br>")} |`
    );
  }

  lines.push("", "## Validation profiles", "");
  lines.push(
    "| Profile | Gates | Host manifest required |",
    "| --- | --- | --- |"
  );
  for (const profile of matrix.validationProfiles) {
    lines.push(
      `| \`${profile.id}\` | ${profile.gates
        .map((gate) => `\`${gate}\``)
        .join(" → ")} | ${profile.requiresHostManifest ? "yes" : "no"} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

function semanticHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "function") return JSON.stringify("[Function]");
  if (typeof value === "symbol") return JSON.stringify(value.toString());
  if (typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (seen.has(value)) return JSON.stringify("[Circular]");

  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`
    );
  return `{${entries.join(",")}}`;
}

function visitFlow(node: FlowNode, visit: (node: FlowNode) => void): void {
  visit(node);
  switch (node.type) {
    case "sequence":
      node.nodes.forEach((child) => visitFlow(child, visit));
      return;
    case "for_each":
    case "persona":
    case "route":
    case "try_catch":
    case "loop":
      node.body.forEach((child) => visitFlow(child, visit));
      if (node.type === "try_catch") {
        node.catch.forEach((child) => visitFlow(child, visit));
      }
      return;
    case "branch":
      node.then.forEach((child) => visitFlow(child, visit));
      node.else?.forEach((child) => visitFlow(child, visit));
      return;
    case "parallel":
      node.branches.forEach((branch) =>
        branch.forEach((child) => visitFlow(child, visit))
      );
      return;
    case "approval":
      node.onApprove.forEach((child) => visitFlow(child, visit));
      node.onReject?.forEach((child) => visitFlow(child, visit));
      return;
    default:
      return;
  }
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
