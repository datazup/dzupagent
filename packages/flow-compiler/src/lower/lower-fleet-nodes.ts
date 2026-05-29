import type {
  FleetContractNetNode,
  FleetDispatchNode,
  FleetGatherNode,
  FlowNode,
  KnowledgeQueryNode,
  KnowledgeWriteNode,
} from "@dzupagent/flow-ast";

const FLEET_SUPERVISOR_FACTORY =
  "@dzupagent/agent/orchestration#FleetSupervisor";
const KNOWLEDGE_STORE_FACTORY = "@dzupagent/agent/orchestration#KnowledgeStore";

type KnowledgeNode = KnowledgeWriteNode | KnowledgeQueryNode;
type FleetPolicyRef =
  | "fan-out"
  | "contract-net"
  | "dependency-tracker"
  | "supervisor";

export type LoweredFleetPayload =
  | {
      type: "fleet.dispatch";
      mode: FleetDispatchNode["mode"];
      policy: FleetPolicyRef;
      repos: FleetDispatchNode["repos"];
      task: FleetDispatchNode["task"];
      onContractChange?: string;
      output?: string;
    }
  | {
      type: "fleet.gather";
      source: string;
      strategy?: string;
      output?: string;
    }
  | {
      type: "fleet.contract-net";
      mode: "contract-net";
      policy: "contract-net";
      repos: FleetContractNetNode["repos"];
      task: FleetContractNetNode["task"];
      output?: string;
    };

export type LoweredKnowledgePayload =
  | {
      type: "knowledge.write";
      scope: string;
      entry: KnowledgeWriteNode["entry"];
    }
  | {
      type: "knowledge.query";
      filter: Record<string, unknown>;
      output: string;
    };

export interface LoweredFleetStep {
  id: string;
  kind:
    | "fleet.dispatch"
    | "fleet.gather"
    | "fleet.contract-net"
    | "knowledge.write"
    | "knowledge.query";
  factory: string;
  handler: "run" | "gather" | "append" | "query";
  payload: LoweredFleetPayload | LoweredKnowledgePayload;
}

export function lowerFleetNode(node: FlowNode): LoweredFleetStep {
  switch (node.type) {
    case "fleet.dispatch":
      return lowerFleetDispatchNode(node);
    case "fleet.gather":
      return lowerFleetGatherNode(node);
    case "fleet.contract-net":
      return lowerFleetContractNetNode(node);
    case "knowledge.write":
    case "knowledge.query":
      return lowerKnowledgeNode(node);
    default:
      throw new Error(`lowerFleetNode: unsupported type ${node.type}`);
  }
}

export function lowerKnowledgeNode(node: KnowledgeNode): LoweredFleetStep {
  switch (node.type) {
    case "knowledge.write": {
      const id = requireNodeId(node);
      const scope = requireString(node.scope, "knowledge.write.scope");
      const entry = requireDefined(node.entry, "knowledge.write.entry");
      return {
        id,
        kind: "knowledge.write",
        factory: KNOWLEDGE_STORE_FACTORY,
        handler: "append",
        payload: {
          type: "knowledge.write",
          scope,
          entry,
        },
      };
    }
    case "knowledge.query": {
      const id = requireNodeId(node);
      const filter = requirePlainObject(
        node.filter,
        "knowledge.query.filter"
      );
      const output = requireString(node.output, "knowledge.query.output");
      return {
        id,
        kind: "knowledge.query",
        factory: KNOWLEDGE_STORE_FACTORY,
        handler: "query",
        payload: {
          type: "knowledge.query",
          filter,
          output,
        },
      };
    }
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      throw new Error("lowerKnowledgeNode: unsupported node type");
    }
  }
}

export function isFleetNode(node: FlowNode): boolean {
  const t = (node as { type?: string }).type;
  return (
    t === "fleet.dispatch" ||
    t === "fleet.contract-net" ||
    t === "fleet.gather" ||
    t === "knowledge.write" ||
    t === "knowledge.query"
  );
}

export function collectFleetSteps(ast: FlowNode): LoweredFleetStep[] {
  const steps: LoweredFleetStep[] = [];
  const visit = (node: FlowNode): void => {
    if (isFleetNode(node)) {
      steps.push(lowerFleetNode(node));
    }
    const n = node as unknown as Record<string, unknown>;
    for (const key of [
      "nodes",
      "body",
      "then",
      "else",
      "catch",
      "onApprove",
      "onReject",
    ]) {
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c as FlowNode);
      }
    }
    if (Array.isArray(n["branches"])) {
      for (const branch of n["branches"]) {
        if (!Array.isArray(branch)) continue;
        for (const c of branch) visit(c as FlowNode);
      }
    }
  };
  visit(ast);
  return steps;
}

function lowerFleetDispatchNode(node: FleetDispatchNode): LoweredFleetStep {
  const id = requireNodeId(node);
  const mode = requireFleetMode(node.mode, "fleet.dispatch.mode");
  const repos = requireRepos(node.repos, "fleet.dispatch.repos");
  const task = requireDefined(node.task, "fleet.dispatch.task");
  const onContractChange =
    node.on_contract_change === undefined
      ? undefined
      : requireString(
          node.on_contract_change,
          "fleet.dispatch.on_contract_change"
        );
  const output =
    node.output === undefined
      ? undefined
      : requireString(node.output, "fleet.dispatch.output");

  return {
    id,
    kind: "fleet.dispatch",
    factory: FLEET_SUPERVISOR_FACTORY,
    handler: "run",
    payload: {
      type: "fleet.dispatch",
      mode,
      policy: policyForMode(mode),
      repos,
      task,
      ...(onContractChange !== undefined ? { onContractChange } : {}),
      ...(output !== undefined ? { output } : {}),
    },
  };
}

function lowerFleetGatherNode(node: FleetGatherNode): LoweredFleetStep {
  const id = requireNodeId(node);
  const source = requireString(node.source, "fleet.gather.source");
  const strategy =
    node.strategy === undefined
      ? undefined
      : requireString(node.strategy, "fleet.gather.strategy");
  const output =
    node.output === undefined
      ? undefined
      : requireString(node.output, "fleet.gather.output");

  return {
    id,
    kind: "fleet.gather",
    factory: FLEET_SUPERVISOR_FACTORY,
    handler: "gather",
    payload: {
      type: "fleet.gather",
      source,
      ...(strategy !== undefined ? { strategy } : {}),
      ...(output !== undefined ? { output } : {}),
    },
  };
}

function lowerFleetContractNetNode(
  node: FleetContractNetNode
): LoweredFleetStep {
  const id = requireNodeId(node);
  const repos = requireRepos(node.repos, "fleet.contract-net.repos");
  const task = requireDefined(node.task, "fleet.contract-net.task");
  const output =
    node.output === undefined
      ? undefined
      : requireString(node.output, "fleet.contract-net.output");

  return {
    id,
    kind: "fleet.contract-net",
    factory: FLEET_SUPERVISOR_FACTORY,
    handler: "run",
    payload: {
      type: "fleet.contract-net",
      mode: "contract-net",
      policy: "contract-net",
      repos,
      task,
      ...(output !== undefined ? { output } : {}),
    },
  };
}

function requireNodeId(node: FlowNode): string {
  return requireString(node.id, `${node.type}.id`);
}

function requireDefined<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new Error(`lowerFleetNode: ${field} is required`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`lowerFleetNode: ${field} must be a non-empty string`);
  }
  return value;
}

function requirePlainObject(
  value: unknown,
  field: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`lowerFleetNode: ${field} must be an object`);
  }
  return { ...(value as Record<string, unknown>) };
}

function requireFleetMode(
  value: unknown,
  field: string
): FleetDispatchNode["mode"] {
  if (
    value === "supervisor" ||
    value === "contract-net" ||
    value === "fan-out" ||
    value === "dependency"
  ) {
    return value;
  }
  throw new Error(
    `lowerFleetNode: ${field} must be one of supervisor|contract-net|fan-out|dependency`
  );
}

function requireRepos(
  value: unknown,
  field: string
): FleetDispatchNode["repos"] {
  if (typeof value === "string") {
    return requireString(value, field);
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  throw new Error(`lowerFleetNode: ${field} must be a string or array`);
}

function policyForMode(mode: FleetDispatchNode["mode"]): FleetPolicyRef {
  switch (mode) {
    case "fan-out":
      return "fan-out";
    case "contract-net":
      return "contract-net";
    case "dependency":
      return "dependency-tracker";
    case "supervisor":
      return "supervisor";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}
