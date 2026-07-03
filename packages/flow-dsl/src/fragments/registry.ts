import type { FlowFragmentCatalogEntry } from "@dzupagent/flow-ast";

import type { FragmentDefinitionInput, FragmentRegistry } from "./types.js";

function keyOf(id: string, version: number): string {
  return `${id}@${version}`;
}

function toEntry(input: FragmentDefinitionInput): FlowFragmentCatalogEntry {
  if ("fragment" in input) return input;
  const namespace = input.id.includes(".") ? input.id.split(".")[0]! : "default";
  return {
    id: input.id,
    version: input.version,
    namespace,
    fragment: input,
  };
}

export function createFragmentRegistry(
  definitions: readonly FragmentDefinitionInput[],
): FragmentRegistry {
  const byKey = new Map<string, FlowFragmentCatalogEntry>();
  const latestById = new Map<string, FlowFragmentCatalogEntry>();

  for (const definition of definitions) {
    const entry = toEntry(definition);
    const key = keyOf(entry.id, entry.version);
    if (byKey.has(key)) throw new Error(`duplicate fragment ${key}`);
    const frozen = Object.freeze({
      ...entry,
      fragment: Object.freeze({ ...entry.fragment }),
    });
    byKey.set(key, frozen);

    const currentLatest = latestById.get(entry.id);
    if (!currentLatest || entry.version > currentLatest.version) {
      latestById.set(entry.id, frozen);
    }
  }

  return Object.freeze({
    get(id: string, version?: number) {
      return version === undefined ? latestById.get(id) : byKey.get(keyOf(id, version));
    },
    list(namespace?: string) {
      const values = [...byKey.values()];
      return namespace
        ? values.filter((entry) => entry.namespace === namespace)
        : values;
    },
    has(id: string, version?: number) {
      return Boolean(this.get(id, version));
    },
  });
}
