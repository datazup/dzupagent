import { FLOW_NODE_KINDS } from "./types.js";
import type { FlowNode } from "./types.js";

export type FlowNodeType = FlowNode["type"];

export const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set(FLOW_NODE_KINDS);

export const FLOW_NODE_VALIDATOR_DESCRIPTORS: ReadonlyArray<{
  type: FlowNodeType;
  hasChildren: boolean;
}> = [
  { type: "sequence", hasChildren: true },
  { type: "action", hasChildren: false },
  { type: "for_each", hasChildren: true },
  { type: "branch", hasChildren: true },
  { type: "approval", hasChildren: true },
  { type: "clarification", hasChildren: false },
  { type: "persona", hasChildren: true },
  { type: "route", hasChildren: true },
  { type: "parallel", hasChildren: true },
  { type: "complete", hasChildren: false },
  { type: "spawn", hasChildren: false },
  { type: "classify", hasChildren: false },
  { type: "emit", hasChildren: false },
  { type: "memory", hasChildren: false },
  { type: "set", hasChildren: false },
  { type: "checkpoint", hasChildren: false },
  { type: "restore", hasChildren: false },
  { type: "try_catch", hasChildren: true },
  { type: "loop", hasChildren: true },
  { type: "http", hasChildren: false },
  { type: "wait", hasChildren: false },
  { type: "subflow", hasChildren: false },
  { type: "prompt", hasChildren: false },
  { type: "return_to", hasChildren: false },
  { type: "agent", hasChildren: false },
  { type: "validate", hasChildren: false },
  { type: "worker.dispatch", hasChildren: false },
  { type: "fleet.dispatch", hasChildren: false },
  { type: "fleet.gather", hasChildren: false },
  { type: "fleet.contract-net", hasChildren: false },
  { type: "knowledge.write", hasChildren: false },
  { type: "knowledge.query", hasChildren: false },
  { type: "adapter.run", hasChildren: false },
  { type: "adapter.race", hasChildren: false },
  { type: "adapter.parallel", hasChildren: false },
];
