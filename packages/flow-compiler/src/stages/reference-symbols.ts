import type {
  FlowDocumentV1,
  FlowNode,
} from "@dzupagent/flow-ast";
import type { FlowReferenceBindings } from "@dzupagent/flow-ast/expressions";

/**
 * Derive the reference roots that are owned by a full authored document.
 *
 * Document inputs populate only the canonical `inputs` root. Host runtimes
 * that intentionally project inputs into state can declare the corresponding
 * state names through their binding snapshot.
 */
export function deriveDocumentReferenceBindings(
  document: FlowDocumentV1,
): FlowReferenceBindings {
  const inputs = Object.keys(document.inputs ?? {});
  return {
    inputs: sortedUnique(inputs),
  };
}

/**
 * Derive node-owned symbols after subflow expansion.
 *
 * This is intentionally a declaration table, not an availability analysis:
 * it proves that a state key or step id exists somewhere in the compiled
 * graph. Dominance, branch availability, loop scope, and port typing are
 * later compiler passes.
 */
export function deriveNodeReferenceBindings(
  root: FlowNode,
): FlowReferenceBindings {
  const state = new Set<string>();
  const steps = new Set<string>();

  visitNode(root, state, steps);

  return {
    artifacts: [],
    context: [],
    inputs: [],
    params: [],
    secrets: [],
    state: sortedUnique(state),
    steps: sortedUnique(steps),
    loop: ["index", "item"],
  };
}

/**
 * Merge compiler-, document-, and host-declared binding snapshots.
 *
 * Sources are unioned instead of overwritten so hosts can add late-bound
 * `context`, `secrets`, or `artifacts` names without discarding document
 * inputs and compiler-derived state/step symbols.
 */
export function mergeReferenceBindings(
  ...sources: Array<FlowReferenceBindings | undefined>
): FlowReferenceBindings {
  const merged = new Map<string, Set<string>>();

  for (const source of sources) {
    if (source === undefined) continue;
    for (const [root, names] of Object.entries(source)) {
      if (names === undefined) continue;
      const current = merged.get(root) ?? new Set<string>();
      for (const name of names) current.add(name);
      merged.set(root, current);
    }
  }

  return Object.fromEntries(
    [...merged.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([root, names]) => [root, sortedUnique(names)]),
  );
}

function visitNode(
  node: FlowNode,
  state: Set<string>,
  steps: Set<string>,
): void {
  if (node.id !== undefined && node.id.length > 0) steps.add(node.id);
  collectNodeStateSymbols(node, state);

  switch (node.type) {
    case "sequence":
      visitNodes(node.nodes, state, steps);
      return;
    case "for_each":
    case "persona":
    case "route":
    case "loop":
      visitNodes(node.body, state, steps);
      return;
    case "branch":
      visitNodes(node.then, state, steps);
      visitNodes(node.else ?? [], state, steps);
      return;
    case "parallel":
      for (const branch of node.branches) visitNodes(branch, state, steps);
      return;
    case "approval":
      visitNodes(node.onApprove, state, steps);
      visitNodes(node.onReject ?? [], state, steps);
      return;
    case "try_catch":
      visitNodes(node.body, state, steps);
      visitNodes(node.catch, state, steps);
      return;
    case "action":
    case "clarification":
    case "complete":
    case "spawn":
    case "classify":
    case "emit":
    case "memory":
    case "set":
    case "checkpoint":
    case "restore":
    case "http":
    case "wait":
    case "subflow":
    case "prompt":
    case "return_to":
    case "agent":
    case "validate":
    case "worker.dispatch":
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "knowledge.write":
    case "knowledge.query":
    case "shell.run":
    case "evidence.write":
    case "validate.schema":
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor":
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
      return;
    default: {
      const exhaustive: never = node;
      void exhaustive;
    }
  }
}

function visitNodes(
  nodes: readonly FlowNode[],
  state: Set<string>,
  steps: Set<string>,
): void {
  for (const node of nodes) visitNode(node, state, steps);
}

function collectNodeStateSymbols(
  node: FlowNode,
  state: Set<string>,
): void {
  switch (node.type) {
    case "for_each":
      state.add(node.as);
      if (node.collect !== undefined) state.add(node.collect.into);
      if (node.accumulator !== undefined) state.add(node.accumulator.key);
      return;
    case "set":
      for (const key of Object.keys(node.assign)) state.add(key);
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
      state.add(node.outputKey);
      return;
    case "memory":
      addOptional(node.outputVar, state);
      return;
    case "try_catch":
      state.add(node.errorVar ?? "error");
      return;
    case "http":
      state.add(node.outputVar ?? node.id ?? "httpResponse");
      return;
    case "subflow":
      state.add(node.outputVar ?? node.id ?? "subflowResult");
      return;
    case "prompt":
      state.add(node.outputKey ?? node.id ?? "promptResult");
      return;
    case "agent":
      state.add(node.output.key);
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
      addOptional(node.output, state);
      return;
    case "knowledge.query":
      state.add(node.output);
      return;
    case "sequence":
    case "action":
    case "branch":
    case "parallel":
    case "approval":
    case "clarification":
    case "persona":
    case "route":
    case "complete":
    case "spawn":
    case "emit":
    case "checkpoint":
    case "restore":
    case "loop":
    case "wait":
    case "return_to":
    case "validate":
    case "knowledge.write":
      return;
    default: {
      const exhaustive: never = node;
      void exhaustive;
    }
  }
}

function addOptional(
  value: string | undefined,
  output: Set<string>,
): void {
  if (value !== undefined && value.length > 0) output.add(value);
}

function sortedUnique(
  values: Iterable<string>,
): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
