import type { FlowNode } from "@dzupagent/flow-ast";
import type {
  AgentNode,
  PipelineNodeSource,
  ToolNode,
} from "@dzupagent/core/orchestration";

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from "./_shared-types.js";
import { nodeDurabilityFields } from "./_shared-durability.js";
import { freshId } from "./_shared-utils.js";

type RuntimeLeafNode = Extract<
  FlowNode,
  {
    type:
      | "agent"
      | "prompt"
      | "validate"
      | "worker.dispatch"
      | "shell.run"
      | "evidence.write"
      | "validate.schema"
      | "adapter.run"
      | "adapter.race"
      | "adapter.parallel"
      | "adapter.supervisor";
  }
>;

const FLOW_NODE_BASE_FIELDS = new Set<string>([
  "type",
  "id",
  "name",
  "description",
  "meta",
  "effectClass",
  "idempotency",
  "resumePoint",
]);

export function lowerRuntimeLeaf(
  node: RuntimeLeafNode,
  ctx: LowerPipelineContext,
  path: string
): LowerPipelineResult {
  const id = freshId(ctx);
  const base = {
    id,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.description !== undefined ? { description: node.description } : {}),
    source: flowNodeSource(node, path),
    ...nodeDurabilityFields(node),
  };

  if (node.type === "agent") {
    const agentNode: AgentNode = {
      ...base,
      type: "agent",
      agentId: node.agentId,
      config: runtimePayload(node, new Set(["agentId"])),
    };
    return { nodes: [agentNode], edges: [], warnings: [] };
  }

  const toolNode: ToolNode = {
    ...base,
    type: "tool",
    toolName: `dzup.runtime.${node.type}`,
    arguments: runtimePayload(node),
  };
  return { nodes: [toolNode], edges: [], warnings: [] };
}

function flowNodeSource(
  node: RuntimeLeafNode,
  path: string
): PipelineNodeSource {
  return {
    kind: "flow-node",
    path,
    nodeType: node.type,
    ...(node.id !== undefined ? { nodeId: node.id } : {}),
  };
}

function runtimePayload(
  node: RuntimeLeafNode,
  additionalOmittedFields: Set<string> = new Set()
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue;
    if (FLOW_NODE_BASE_FIELDS.has(key)) continue;
    if (additionalOmittedFields.has(key)) continue;
    payload[key] = value;
  }
  return payload;
}
