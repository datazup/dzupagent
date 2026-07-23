import type {
  FlowDocumentV1,
  FlowNode,
} from "@dzupagent/flow-ast";

import {
  deriveDocumentReferenceBindings,
  deriveNodeReferenceBindings,
  mergeReferenceBindings,
} from "./stages/reference-symbols.js";
import {
  deriveDocumentReferenceTypeBindings,
  deriveNodeReferencePortBindings,
  deriveNodeReferenceTypeBindings,
  mergeReferencePortBindings,
  mergeReferenceTypeBindings,
} from "./stages/reference-symbol-contracts.js";
import {
  deriveDocumentReferenceClassificationBindings,
  deriveNodeReferenceClassificationBindings,
  deriveSecretReferenceClassificationBindings,
  mergeReferenceClassificationBindings,
  mergeReferencePortClassificationBindings,
} from "./stages/reference-classifications.js";
import type {
  FlowReferenceAuthoringOptions,
  FlowReferenceAuthoringSnapshot,
  FlowReferenceClassificationBindings,
  FlowReferenceCompletion,
  FlowReferencePortClassificationBindings,
  FlowReferencePortBindings,
  FlowReferenceTypeBindings,
} from "./types.js";

/**
 * Build the declaration/type/port snapshot consumed by editors and other
 * authoring tools. This is a declaration catalog, not control-flow
 * availability; compile diagnostics remain the authority for use-site safety.
 */
export function createFlowReferenceAuthoringSnapshot(
  input: FlowDocumentV1 | FlowNode,
  options: FlowReferenceAuthoringOptions = {},
): FlowReferenceAuthoringSnapshot {
  const document = isFlowDocument(input) ? input : undefined;
  const root = document?.root ?? (input as FlowNode);
  const bindings = mergeReferenceBindings(
    document !== undefined
      ? deriveDocumentReferenceBindings(document)
      : undefined,
    deriveNodeReferenceBindings(root),
    options.referenceBindings,
  );
  const types = mergeReferenceTypeBindings(
    document !== undefined
      ? deriveDocumentReferenceTypeBindings(document)
      : undefined,
    deriveNodeReferenceTypeBindings(root),
    options.referenceTypeBindings,
  );
  const ports = mergeReferencePortBindings(
    deriveNodeReferencePortBindings(root),
    options.referencePortBindings,
  );
  const initialClassifications = mergeReferenceClassificationBindings(
    document !== undefined
      ? deriveDocumentReferenceClassificationBindings(document)
      : undefined,
    options.referenceClassificationBindings,
    deriveSecretReferenceClassificationBindings(bindings),
  );
  const classifications = mergeReferenceClassificationBindings(
    initialClassifications,
    deriveNodeReferenceClassificationBindings(
      root,
      initialClassifications,
      options.referencePortClassificationBindings,
    ),
  );
  const portClassifications = mergeReferencePortClassificationBindings(
    options.referencePortClassificationBindings,
  );

  return {
    schema: "dzupagent.flowReferenceAuthoring/v1",
    bindings,
    types,
    ports,
    classifications,
    portClassifications,
    completions: buildCompletions(
      bindings,
      types,
      ports,
      classifications,
      portClassifications,
    ),
  };
}

function buildCompletions(
  bindings: FlowReferenceAuthoringSnapshot["bindings"],
  types: FlowReferenceTypeBindings,
  ports: FlowReferencePortBindings,
  classifications: FlowReferenceClassificationBindings,
  portClassifications: FlowReferencePortClassificationBindings,
): FlowReferenceCompletion[] {
  const completions: FlowReferenceCompletion[] = [];
  for (const [root, names] of Object.entries(bindings)) {
    if (root === "steps") continue;
    for (const name of names ?? []) {
      completions.push({
        kind: "binding",
        label: `${root}.${name}`,
        insertText: `{{ ${root}.${name} }}`,
        root,
        name,
        valueType: types[root]?.[name] ?? "unknown",
        ...(classifications[root]?.[name] !== undefined
          ? { classification: classifications[root]?.[name] }
          : {}),
      });
    }
  }
  for (const [stepId, stepPorts] of Object.entries(ports)) {
    for (const [port, valueType] of Object.entries(stepPorts ?? {})) {
      completions.push({
        kind: "step-port",
        label: `steps.${stepId}.${port}`,
        insertText: `{{ steps.${stepId}.${port} }}`,
        root: "steps",
        stepId,
        name: port,
        valueType: valueType ?? "unknown",
        ...(portClassifications[stepId]?.[port] !== undefined
          ? { classification: portClassifications[stepId]?.[port] }
          : {}),
      });
    }
  }
  return completions.sort((left, right) => left.label.localeCompare(right.label));
}

function isFlowDocument(
  input: FlowDocumentV1 | FlowNode,
): input is FlowDocumentV1 {
  return (
    typeof input === "object" &&
    input !== null &&
    "dsl" in input &&
    "root" in input
  );
}
