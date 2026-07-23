import type { FlowNode } from "@dzupagent/flow-ast";
import type { FlowReferenceBindings } from "@dzupagent/flow-ast/expressions";

import {
  deriveNodeReferenceBindings,
  mergeReferenceBindings,
} from "../stages/reference-symbols.js";
import {
  deriveNodeReferencePortBindings,
  deriveNodeCredentialTypeBindings,
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
import { derivePrimitiveReferencePortClassificationBindings } from "../stages/primitive-reference-ports.js";
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
  const referencePortBindings = mergeReferencePortBindings(
    deriveNodeReferencePortBindings(ast),
    options.referencePortBindings,
  );
  const initialTypes = mergeReferenceTypeBindings(
    deriveNodeReferenceTypeBindings(ast),
    source.types,
    options.referenceTypeBindings,
  );
  const referenceTypeBindings = mergeReferenceTypeBindings(
    initialTypes,
    deriveNodeCredentialTypeBindings(ast, initialTypes, referencePortBindings),
  );
  const initialPortClassifications =
    mergeReferencePortClassificationBindings(
      derivePrimitiveReferencePortClassificationBindings(ast),
      options.referencePortClassificationBindings,
    );
  const derivedClassifications = deriveNodeReferenceClassificationBindings(
    ast,
    initialClassifications,
    initialPortClassifications,
  );
  const referencePortClassificationBindings =
    mergeReferencePortClassificationBindings(
      initialPortClassifications,
      derivePrimitiveReferencePortClassificationBindings(
        ast,
        derivedClassifications,
      ),
    );
  const referenceClassificationBindings = mergeReferenceClassificationBindings(
    initialClassifications,
    derivedClassifications,
    deriveNodeReferenceClassificationBindings(
      ast,
      mergeReferenceClassificationBindings(
        initialClassifications,
        derivedClassifications,
      ),
      referencePortClassificationBindings,
    ),
  );

  return {
    referenceBindings,
    referenceAvailabilityBindings: mergeReferenceBindings(
      source.bindings,
      options.referenceBindings,
    ),
    referenceTypeBindings,
    referencePortBindings,
    referenceClassificationBindings,
    referencePortClassificationBindings,
  };
}
