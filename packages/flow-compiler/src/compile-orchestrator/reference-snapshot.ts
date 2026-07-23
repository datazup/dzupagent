import type { FlowNode } from "@dzupagent/flow-ast";
import type { FlowReferenceBindings } from "@dzupagent/flow-ast/expressions";

import {
  deriveNodeReferenceBindings,
  mergeReferenceBindings,
} from "../stages/reference-symbols.js";
import {
  deriveNodeReferencePortBindings,
  deriveNodeReferenceTypeBindings,
  mergeReferencePortBindings,
  mergeReferenceTypeBindings,
} from "../stages/reference-symbol-contracts.js";
import {
  deriveNodeReferenceClassificationBindings,
  deriveSecretReferenceClassificationBindings,
  mergeReferenceClassificationBindings,
  mergeReferencePortClassificationBindings,
} from "../stages/reference-classifications.js";
import type {
  CompilerOptions,
  FlowReferenceClassificationBindings,
  FlowReferenceTypeBindings,
} from "../types.js";

export interface SourceReferenceSnapshot {
  readonly bindings?: FlowReferenceBindings;
  readonly types?: FlowReferenceTypeBindings;
  readonly classifications?: FlowReferenceClassificationBindings;
}

/** Assemble the declaration, availability, type, port, and policy snapshot. */
export function createSemanticReferenceSnapshot(
  ast: FlowNode,
  source: SourceReferenceSnapshot,
  options: CompilerOptions,
) {
  const referenceBindings = mergeReferenceBindings(
    deriveNodeReferenceBindings(ast),
    source.bindings,
    options.referenceBindings,
  );
  const initialClassifications = mergeReferenceClassificationBindings(
    source.classifications,
    options.referenceClassificationBindings,
    deriveSecretReferenceClassificationBindings(referenceBindings),
  );

  return {
    referenceBindings,
    referenceAvailabilityBindings: mergeReferenceBindings(
      source.bindings,
      options.referenceBindings,
    ),
    referenceTypeBindings: mergeReferenceTypeBindings(
      deriveNodeReferenceTypeBindings(ast),
      source.types,
      options.referenceTypeBindings,
    ),
    referencePortBindings: mergeReferencePortBindings(
      deriveNodeReferencePortBindings(ast),
      options.referencePortBindings,
    ),
    referenceClassificationBindings: mergeReferenceClassificationBindings(
      initialClassifications,
      deriveNodeReferenceClassificationBindings(
        ast,
        initialClassifications,
        options.referencePortClassificationBindings,
      ),
    ),
    referencePortClassificationBindings:
      mergeReferencePortClassificationBindings(
        options.referencePortClassificationBindings,
      ),
  };
}
