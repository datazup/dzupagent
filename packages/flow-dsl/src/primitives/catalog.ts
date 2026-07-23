import type {
  PrimitiveDefinition,
  PrimitiveDefinitionV2,
} from "./types.js";

export interface PrimitiveCatalogEntry {
  kind: string;
  version: string;
  namespace: string;
  category: string;
  description?: string;
  effectClass?: string;
  idempotency?: string;
  expandsTo?: string[];
  executesWith?: string;
}

export interface PrimitiveCatalog {
  schemaVersion: 1;
  generatedFrom: "flow-dsl";
  primitives: PrimitiveCatalogEntry[];
}

export interface PrimitiveCatalogV2 {
  schema: "dzupagent.primitiveCatalog/v2";
  generatedFrom: "PrimitiveDefinitionV2";
  primitives: readonly PrimitiveDefinitionV2[];
}

export function exportPrimitiveCatalog(
  definitions: readonly PrimitiveDefinition[],
): PrimitiveCatalog {
  return {
    schemaVersion: 1,
    generatedFrom: "flow-dsl",
    primitives: definitions
      .map((definition) => ({
        kind: definition.kind,
        version: definition.version,
        namespace: definition.namespace,
        category: definition.category,
        ...(definition.description
          ? { description: definition.description }
          : {}),
        ...(definition.effectClass
          ? { effectClass: definition.effectClass }
          : {}),
        ...(definition.idempotency
          ? { idempotency: definition.idempotency }
          : {}),
        ...(definition.expandsTo ? { expandsTo: [...definition.expandsTo] } : {}),
        ...(definition.executesWith
          ? { executesWith: definition.executesWith }
          : {}),
      }))
      .sort((a, b) =>
        `${a.kind}@${a.version}`.localeCompare(`${b.kind}@${b.version}`),
      ),
  };
}

/** Export the complete serializable V2 contracts in deterministic identity order. */
export function exportPrimitiveCatalogV2(
  definitions: readonly PrimitiveDefinitionV2[],
): PrimitiveCatalogV2 {
  return {
    schema: "dzupagent.primitiveCatalog/v2",
    generatedFrom: "PrimitiveDefinitionV2",
    primitives: [...definitions].sort((left, right) =>
      left.ref.localeCompare(right.ref),
    ),
  };
}
