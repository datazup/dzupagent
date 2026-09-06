import type { PipelineDefinition } from "@dzupagent/runtime-contracts/pipeline-artifact";

export function branchDefinition(concurrency = 1, emptyElse = false): PipelineDefinition {
  return {
    id: "item-branch", name: "ItemBranch", version: "1", schemaVersion: "1.0.0",
    entryNodeId: "items", checkpointStrategy: "after_each_node",
    nodes: [
      { id: "items", type: "loop", maxIterations: 100, continuePredicateName: "items",
        bodyNodeIds: ["before", "choose", "yes", ...(emptyElse ? [] : ["no"]), "after"],
        bodyGraph: { entryNodeId: "before", normalExitNodeIds: ["after"], suspendedExitNodeIds: [], terminalExitNodeIds: [], errorExitNodeIds: [] },
        forEach: { source: "items", as: "item", concurrency, order: "input", empty: { body: "skip", aggregate: "empty-array" }, collect: { from: "after", into: "answers" } } },
      { id: "before", type: "agent", agentId: "before" },
      { id: "choose", type: "gate", gateType: "quality", condition: "choose" },
      { id: "yes", type: "agent", agentId: "yes" },
      ...(emptyElse ? [] : [{ id: "no", type: "agent" as const, agentId: "no" }]),
      { id: "after", type: "agent", agentId: "after" },
      { id: "done", type: "agent", agentId: "done" },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "before", targetNodeId: "choose" },
      { type: "conditional", sourceNodeId: "choose", predicateName: "choose", branches: emptyElse ? { true: "yes" } : { true: "yes", false: "no" } },
      ...(emptyElse ? [{ type: "sequential" as const, sourceNodeId: "choose", targetNodeId: "after" }] : [{ type: "sequential" as const, sourceNodeId: "no", targetNodeId: "after" }]),
      { type: "sequential", sourceNodeId: "yes", targetNodeId: "after" },
      { type: "sequential", sourceNodeId: "items", targetNodeId: "done" },
    ],
  };
}
