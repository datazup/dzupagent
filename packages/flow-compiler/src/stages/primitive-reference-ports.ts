import type {
  FlowDataClassification,
  FlowNode,
} from "@dzupagent/flow-ast";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  type PrimitiveDefinitionV2,
  type PrimitiveRegistryV2,
  type PrimitiveSchema,
} from "@dzupagent/flow-dsl";

import type {
  FlowReferenceClassificationBindings,
  FlowReferencePortBindings,
  FlowReferencePortClassificationBindings,
  FlowReferenceValueType,
  FlowPrimitiveBindings,
} from "../types.js";
import {
  mergeFlowDataClassification,
  stateOutputKeyForClassification,
} from "./reference-classifications.js";

/** Resolve the latest built-in V2 contract for a canonical v1 node kind. */
export function resolveBuiltInPrimitiveDefinition(
  kind: string,
): PrimitiveDefinitionV2 | undefined {
  return BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve(kind);
}

/** Resolve an exact external binding or fall back to the reviewed built-in. */
export function resolvePrimitiveDefinition(
  kind: string,
  registry: PrimitiveRegistryV2 | undefined,
  bindings: FlowPrimitiveBindings | undefined,
): PrimitiveDefinitionV2 | undefined {
  const binding = bindings?.[kind];
  if (binding === undefined) return resolveBuiltInPrimitiveDefinition(kind);
  const definition = registry?.get(binding.ref);
  return definition !== undefined &&
    definition.compatibility.semanticHash === binding.semanticHash
    ? definition
    : undefined;
}

/** Generate canonical step-port value types from resolved built-in primitives. */
export function derivePrimitiveReferencePortBindings(
  root: FlowNode,
  registry?: PrimitiveRegistryV2,
  primitiveBindings?: FlowPrimitiveBindings,
): FlowReferencePortBindings {
  const portBindings: Record<string, Record<string, FlowReferenceValueType>> = {};
  visitNodes(root, (node) => {
    if (node.id === undefined || node.id.length === 0) return;
    const definition = resolvePrimitiveDefinition(
      node.type,
      registry,
      primitiveBindings,
    );
    if (definition === undefined) return;
    portBindings[node.id] = Object.fromEntries(
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
    Object.entries(portBindings).sort(([left], [right]) =>
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
  registry?: PrimitiveRegistryV2,
  primitiveBindings?: FlowPrimitiveBindings,
): FlowReferencePortClassificationBindings {
  const portBindings: Record<string, Record<string, FlowDataClassification>> = {};
  visitNodes(root, (node) => {
    if (node.id === undefined || node.id.length === 0) return;
    const definition = resolvePrimitiveDefinition(
      node.type,
      registry,
      primitiveBindings,
    );
    if (definition === undefined) return;
    const outputKey = stateOutputKeyForClassification(node);
    const inferred =
      outputKey === undefined ? undefined : stateBindings["state"]?.[outputKey];
    portBindings[node.id] = Object.fromEntries(
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
    Object.entries(portBindings).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
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
