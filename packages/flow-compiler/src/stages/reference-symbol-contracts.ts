import type {
  FlowDocumentV1,
  FlowNode,
} from "@dzupagent/flow-ast";

import type {
  FlowReferencePortBindings,
  FlowReferenceTypeBindings,
  FlowReferenceValueType,
} from "../types.js";

/** Derive first-segment input types from an authored document. */
export function deriveDocumentReferenceTypeBindings(
  document: FlowDocumentV1,
): FlowReferenceTypeBindings {
  return {
    inputs: Object.fromEntries(
      Object.entries(document.inputs ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, spec]) => [name, spec.type]),
    ),
  };
}

/**
 * Derive the small, sound type lattice available from explicit v1 node
 * declarations. Opaque schema refs remain `unknown`.
 */
export function deriveNodeReferenceTypeBindings(
  root: FlowNode,
): FlowReferenceTypeBindings {
  const state = new Map<string, FlowReferenceValueType>();
  visitNodeTypes(root, state);
  return {
    state: Object.fromEntries(
      [...state.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

/**
 * Declare every AST step with no guessed ports.
 *
 * An empty contract is deliberate: v1 state destinations are not portable
 * step-port names. Hosts may add reviewed ports through CompilerOptions.
 */
export function deriveNodeReferencePortBindings(
  root: FlowNode,
): FlowReferencePortBindings {
  const ports = new Map<string, Record<string, FlowReferenceValueType>>();
  visitNodePorts(root, ports);
  return Object.fromEntries(
    [...ports.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Merge type snapshots conservatively; conflicting known types become unknown. */
export function mergeReferenceTypeBindings(
  ...sources: Array<FlowReferenceTypeBindings | undefined>
): FlowReferenceTypeBindings {
  const merged = new Map<string, Map<string, FlowReferenceValueType>>();
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [root, bindings] of Object.entries(source)) {
      if (bindings === undefined) continue;
      const current =
        merged.get(root) ?? new Map<string, FlowReferenceValueType>();
      for (const [name, type] of Object.entries(bindings)) {
        if (type === undefined) continue;
        current.set(name, mergeReferenceType(current.get(name), type));
      }
      merged.set(root, current);
    }
  }
  return Object.fromEntries(
    [...merged.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([root, bindings]) => [
        root,
        Object.fromEntries(
          [...bindings.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ]),
  );
}

/** Merge host port contracts without silently choosing a type conflict. */
export function mergeReferencePortBindings(
  ...sources: Array<FlowReferencePortBindings | undefined>
): FlowReferencePortBindings {
  const merged = new Map<string, Map<string, FlowReferenceValueType>>();
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [stepId, ports] of Object.entries(source)) {
      const current =
        merged.get(stepId) ?? new Map<string, FlowReferenceValueType>();
      for (const [port, type] of Object.entries(ports ?? {})) {
        current.set(
          port,
          mergeReferenceType(current.get(port), type ?? "unknown"),
        );
      }
      merged.set(stepId, current);
    }
  }
  return Object.fromEntries(
    [...merged.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stepId, ports]) => [
        stepId,
        Object.fromEntries(
          [...ports.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ]),
  );
}

function visitNodeTypes(
  node: FlowNode,
  state: Map<string, FlowReferenceValueType>,
): void {
  collectNodeStateTypes(node, state);
  for (const child of childNodes(node)) visitNodeTypes(child, state);
}

function visitNodePorts(
  node: FlowNode,
  ports: Map<string, Record<string, FlowReferenceValueType>>,
): void {
  if (node.id !== undefined && node.id.length > 0) ports.set(node.id, {});
  for (const child of childNodes(node)) visitNodePorts(child, ports);
}

function childNodes(node: FlowNode): readonly FlowNode[] {
  switch (node.type) {
    case "sequence":
      return node.nodes;
    case "for_each":
    case "persona":
    case "route":
    case "loop":
      return node.body;
    case "branch":
      return [...node.then, ...(node.else ?? [])];
    case "parallel":
      return node.branches.flat();
    case "approval":
      return [...node.onApprove, ...(node.onReject ?? [])];
    case "try_catch":
      return [...node.body, ...node.catch];
    default:
      return [];
  }
}

function collectNodeStateTypes(
  node: FlowNode,
  state: Map<string, FlowReferenceValueType>,
): void {
  switch (node.type) {
    case "for_each":
      recordType(state, node.as, "unknown");
      if (node.collect !== undefined) {
        recordType(state, node.collect.into, "array");
      }
      if (node.accumulator !== undefined) {
        recordType(
          state,
          node.accumulator.key,
          node.accumulator.initialValue === undefined
            ? "array"
            : inferLiteralType(node.accumulator.initialValue),
        );
      }
      return;
    case "set":
      for (const [key, value] of Object.entries(node.assign)) {
        recordType(state, key, inferLiteralType(value));
      }
      return;
    case "classify":
      recordType(state, node.outputKey, "string");
      return;
    case "memory":
      if (node.outputVar !== undefined) {
        recordType(state, node.outputVar, "unknown");
      }
      return;
    case "try_catch":
      recordType(state, node.errorVar ?? "error", "string");
      return;
    case "http":
      recordType(state, node.outputVar ?? node.id ?? "httpResponse", "unknown");
      return;
    case "subflow":
      recordType(state, node.outputVar ?? node.id ?? "subflowResult", "object");
      return;
    case "prompt":
      recordType(state, node.outputKey ?? node.id ?? "promptResult", "string");
      return;
    case "agent":
      recordType(state, node.output.key, typeFromSchema(node.output.schema));
      return;
    case "worker.dispatch":
      recordType(
        state,
        node.outputKey,
        node.resultFormat === "json" ? "unknown" : "string",
      );
      return;
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor":
      recordType(state, node.output, typeFromSchema(node.outputSchema));
      return;
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "shell.run":
    case "evidence.write":
    case "validate.schema":
      if (node.output !== undefined) {
        recordType(state, node.output, "unknown");
      }
      return;
    case "knowledge.query":
      recordType(state, node.output, "unknown");
      return;
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
      recordType(state, node.outputKey, "unknown");
      return;
    default:
      return;
  }
}

function recordType(
  target: Map<string, FlowReferenceValueType>,
  name: string,
  type: FlowReferenceValueType,
): void {
  target.set(name, mergeReferenceType(target.get(name), type));
}

function mergeReferenceType(
  current: FlowReferenceValueType | undefined,
  next: FlowReferenceValueType,
): FlowReferenceValueType {
  if (current === undefined || current === "unknown") return next;
  if (next === "unknown" || current === next) return current;
  if (current === "any" || next === "any") return "any";
  return "unknown";
}

function inferLiteralType(value: unknown): FlowReferenceValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return value.includes("{{") || value.includes("}}")
        ? "unknown"
        : "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function typeFromSchema(schema: unknown): FlowReferenceValueType {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return "unknown";
  }
  const type = (schema as Record<string, unknown>)["type"];
  if (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "object" ||
    type === "array" ||
    type === "null"
  ) {
    return type;
  }
  if (type === "integer") return "number";
  return "unknown";
}
