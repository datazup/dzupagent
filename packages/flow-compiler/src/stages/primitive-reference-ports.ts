import type {
  FlowDataClassification,
  FlowNode,
} from "@dzupagent/flow-ast";
import {
  BUILT_IN_PRIMITIVE_DEFINITIONS_V2,
  primitiveKind,
  type PrimitiveDefinitionV2,
  type PrimitiveSchema,
} from "@dzupagent/flow-dsl";

import type {
  FlowReferenceClassificationBindings,
  FlowReferencePortBindings,
  FlowReferencePortClassificationBindings,
  FlowReferenceValueType,
} from "../types.js";
import {
  mergeFlowDataClassification,
  stateOutputKeyForClassification,
} from "./reference-classifications.js";

const LATEST_PRIMITIVE_BY_KIND = indexLatestPrimitives(
  BUILT_IN_PRIMITIVE_DEFINITIONS_V2,
);

/** Resolve the latest built-in V2 contract for a canonical v1 node kind. */
export function resolveBuiltInPrimitiveDefinition(
  kind: string,
): PrimitiveDefinitionV2 | undefined {
  return LATEST_PRIMITIVE_BY_KIND.get(kind);
}

/** Generate canonical step-port value types from resolved built-in primitives. */
export function derivePrimitiveReferencePortBindings(
  root: FlowNode,
): FlowReferencePortBindings {
  const bindings: Record<string, Record<string, FlowReferenceValueType>> = {};
  visitNodes(root, (node) => {
    if (node.id === undefined || node.id.length === 0) return;
    const definition = resolveBuiltInPrimitiveDefinition(node.type);
    if (definition === undefined) return;
    bindings[node.id] = Object.fromEntries(
      Object.entries(definition.outputPorts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([port, contract]) => [
          port,
          contract.cardinality === "many"
            ? "array"
            : referenceTypeFromSchema(contract.schema),
        ]),
    );
  });
  return Object.fromEntries(
    Object.entries(bindings).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

/**
 * Generate baseline port classifications and monotonically lift them to the
 * classification inferred for the node's concrete v1 state destination.
 */
export function derivePrimitiveReferencePortClassificationBindings(
  root: FlowNode,
  stateBindings: FlowReferenceClassificationBindings = {},
): FlowReferencePortClassificationBindings {
  const bindings: Record<string, Record<string, FlowDataClassification>> = {};
  visitNodes(root, (node) => {
    if (node.id === undefined || node.id.length === 0) return;
    const definition = resolveBuiltInPrimitiveDefinition(node.type);
    if (definition === undefined) return;
    const outputKey = stateOutputKeyForClassification(node);
    const inferred =
      outputKey === undefined ? undefined : stateBindings["state"]?.[outputKey];
    bindings[node.id] = Object.fromEntries(
      Object.entries(definition.outputPorts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([port, contract]) => [
          port,
          mergeFlowDataClassification(contract.classification, inferred) ??
            contract.classification,
        ]),
    );
  });
  return Object.fromEntries(
    Object.entries(bindings).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function indexLatestPrimitives(
  definitions: readonly PrimitiveDefinitionV2[],
): ReadonlyMap<string, PrimitiveDefinitionV2> {
  const latest = new Map<string, PrimitiveDefinitionV2>();
  for (const definition of definitions) {
    const kind = primitiveKind(definition);
    const current = latest.get(kind);
    if (
      current === undefined ||
      definition.version.localeCompare(current.version, undefined, {
        numeric: true,
      }) > 0
    ) {
      latest.set(kind, definition);
    }
  }
  return latest;
}

function referenceTypeFromSchema(
  schema: PrimitiveSchema,
): FlowReferenceValueType {
  if (typeof schema === "string") return "unknown";
  const type = schema["type"];
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
  return "unknown";
}

function visitNodes(node: FlowNode, visit: (node: FlowNode) => void): void {
  visit(node);
  for (const child of childNodes(node)) visitNodes(child, visit);
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
