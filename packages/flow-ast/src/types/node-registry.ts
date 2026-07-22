import type { FlowNode } from "./nodes.js";

export type FlowNodeKind = FlowNode["type"];

/**
 * Authoritative registry for public FlowNode discriminators.
 *
 * Parser, validator, and downstream contract tests derive their accepted
 * node-kind lists from this table so the public union cannot drift from
 * runtime handling.
 */
export const FLOW_NODE_KIND_REGISTRY = {
  sequence: true,
  action: true,
  for_each: true,
  branch: true,
  approval: true,
  clarification: true,
  persona: true,
  route: true,
  parallel: true,
  complete: true,
  spawn: true,
  classify: true,
  emit: true,
  memory: true,
  set: true,
  checkpoint: true,
  restore: true,
  try_catch: true,
  loop: true,
  http: true,
  wait: true,
  subflow: true,
  prompt: true,
  return_to: true,
  agent: true,
  validate: true,
  "worker.dispatch": true,
  "fleet.dispatch": true,
  "fleet.gather": true,
  "fleet.contract-net": true,
  "knowledge.write": true,
  "knowledge.query": true,
  "shell.run": true,
  "evidence.write": true,
  "validate.schema": true,
  "adapter.run": true,
  "adapter.race": true,
  "adapter.parallel": true,
  "adapter.supervisor": true,
  "spdd.import_sources": true,
  "spdd.build_source_pack": true,
  "spdd.run_analysis": true,
  "spdd.generate_canvas": true,
  "spdd.validate_canvas": true,
  "spdd.review_canvas": true,
  "spdd.project_plan": true,
  "spdd.arm_dispatch": true,
  "spdd.run_validation": true,
  "spdd.collect_proof": true,
  "spdd.scan_drift": true,
  "spdd.create_sync_proposal": true,
  "spdd.agent_swarm": true,
} as const satisfies Record<FlowNodeKind, true>;

export const FLOW_NODE_KINDS = Object.keys(
  FLOW_NODE_KIND_REGISTRY
) as FlowNodeKind[];

export function isFlowNodeKind(value: string): value is FlowNodeKind {
  return Object.prototype.hasOwnProperty.call(FLOW_NODE_KIND_REGISTRY, value);
}
