import type { PrimitiveDefinition } from "./types.js";

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
