import type { FlowNode } from "@dzupagent/flow-ast";
import type { FlowReferenceBindings } from "@dzupagent/flow-ast/expressions";

export type ReferenceAvailability = Map<string, Set<string>>;

export function availabilityFromBindings(
  bindings: FlowReferenceBindings | undefined,
): ReferenceAvailability {
  const availability: ReferenceAvailability = new Map();
  for (const [root, names] of Object.entries(bindings ?? {})) {
    availability.set(root, new Set(names ?? []));
  }
  return availability;
}

export function cloneAvailability(
  source: ReferenceAvailability,
): ReferenceAvailability {
  return new Map(
    [...source.entries()].map(([root, names]) => [root, new Set(names)]),
  );
}

export function intersectAvailability(
  left: ReferenceAvailability,
  right: ReferenceAvailability,
): ReferenceAvailability {
  const result: ReferenceAvailability = new Map();
  for (const root of new Set([...left.keys(), ...right.keys()])) {
    const leftNames = left.get(root) ?? new Set<string>();
    const rightNames = right.get(root) ?? new Set<string>();
    result.set(
      root,
      new Set([...leftNames].filter((name) => rightNames.has(name))),
    );
  }
  return result;
}

export function unionAvailability(
  ...sources: readonly ReferenceAvailability[]
): ReferenceAvailability {
  const result: ReferenceAvailability = new Map();
  for (const source of sources) {
    for (const [root, names] of source) {
      const current = result.get(root) ?? new Set<string>();
      for (const name of names) current.add(name);
      result.set(root, current);
    }
  }
  return result;
}

export function addAvailable(
  target: ReferenceAvailability,
  root: string,
  name: string,
): void {
  const names = target.get(root) ?? new Set<string>();
  names.add(name);
  target.set(root, names);
}

export function addNodeStateOutputs(
  node: FlowNode,
  target: ReferenceAvailability,
): void {
  const addState = (name: string | undefined): void => {
    if (name !== undefined && name.length > 0) {
      addAvailable(target, "state", name);
    }
  };

  switch (node.type) {
    case "set":
      for (const key of Object.keys(node.assign)) addState(key);
      return;
    case "classify":
    case "worker.dispatch":
    case "spdd.import_sources":
    case "spdd.build_source_pack":
    case "spdd.run_analysis":
    case "spdd.generate_canvas":
    case "spdd.validate_canvas":
    case "spdd.review_canvas":
    case "spdd.project_plan":
    case "spdd.arm_dispatch":
    case "spdd.run_validation":
    case "spdd.collect_proof":
    case "spdd.scan_drift":
    case "spdd.create_sync_proposal":
    case "spdd.agent_swarm":
      addState(node.outputKey);
      return;
    case "memory":
      addState(node.outputVar);
      return;
    case "http":
      addState(node.outputVar ?? node.id ?? "httpResponse");
      return;
    case "subflow":
      addState(node.outputVar ?? node.id ?? "subflowResult");
      return;
    case "prompt":
      addState(node.outputKey ?? node.id ?? "promptResult");
      return;
    case "agent":
      addState(node.output.key);
      return;
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "shell.run":
    case "evidence.write":
    case "validate.schema":
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor":
      addState(node.output);
      return;
    case "knowledge.query":
      addState(node.output);
      return;
    default:
      return;
  }
}
