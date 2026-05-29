import type { FlowNode } from "@dzupagent/flow-ast";

export interface LoweredFleetStep {
  id: string;
  kind:
    | "fleet.dispatch"
    | "fleet.gather"
    | "fleet.contract-net"
    | "knowledge.write"
    | "knowledge.query";
  factory: string;
  payload: Record<string, unknown>;
}

export function lowerFleetNode(node: FlowNode): LoweredFleetStep {
  const n = node as Record<string, unknown> & { id: string; type: string };
  switch (n.type) {
    case "fleet.dispatch":
    case "fleet.contract-net":
    case "fleet.gather":
      return {
        id: n.id,
        kind: n.type,
        factory: "@dzupagent/agent/orchestration#FleetSupervisor",
        payload: n,
      };
    case "knowledge.write":
    case "knowledge.query":
      return {
        id: n.id,
        kind: n.type,
        factory: "@dzupagent/agent/orchestration#KnowledgeStore",
        payload: n,
      };
    default:
      throw new Error(`lowerFleetNode: unsupported type ${n.type}`);
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
    const n = node as Record<string, unknown>;
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
      for (const branch of n["branches"] as FlowNode[][]) {
        for (const c of branch) visit(c);
      }
    }
  };
  visit(ast);
  return steps;
}
