import type { PrimitiveDefinition, PrimitiveRegistry } from "./types.js";

function keyOf(kind: string, version: string): string {
  return `${kind}@${version}`;
}

export function createPrimitiveRegistry(
  definitions: readonly PrimitiveDefinition[],
): PrimitiveRegistry {
  const byKey = new Map<string, PrimitiveDefinition>();
  const latestByKind = new Map<string, PrimitiveDefinition>();

  for (const definition of definitions) {
    const key = keyOf(definition.kind, definition.version);
    if (byKey.has(key)) {
      throw new Error(`duplicate primitive ${key}`);
    }
    const frozen = Object.freeze({ ...definition });
    byKey.set(key, frozen);
    latestByKind.set(definition.kind, frozen);
  }

  return Object.freeze({
    get(kind: string, version?: string) {
      return version ? byKey.get(keyOf(kind, version)) : latestByKind.get(kind);
    },
    list(namespace?: string) {
      const values = [...byKey.values()];
      return namespace
        ? values.filter((definition) => definition.namespace === namespace)
        : values;
    },
    has(kind: string, version?: string) {
      return Boolean(this.get(kind, version));
    },
  });
}
