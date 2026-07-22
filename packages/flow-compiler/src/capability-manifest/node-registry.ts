import { type FlowNodeKind } from "@dzupagent/flow-ast";

import type { CompilationTarget } from "../types.js";
import type {
  FlowCapabilityOwner,
  FlowNodeCapabilityDescriptor,
  FlowNodeLoweringMode,
  FlowNodeSupportStatus,
  RecommendedFlowProfile,
} from "./types.js";

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
