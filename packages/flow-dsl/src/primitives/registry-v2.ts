import { createHash } from "node:crypto";

import { createPrimitiveAuthoringMetadata } from "./authoring-metadata.js";
import {
  definePrimitiveV2,
  primitiveKind,
  validatePrimitiveDefinitionV2,
} from "./definition-v2.js";
import type {
  PrimitiveDefinitionV2,
  PrimitiveDefinitionV2Input,
  PrimitiveRegistryV2,
  PrimitiveRegistryV2Options,
} from "./types.js";

/** Create an immutable, exact-ref V2 registry with compatibility validation. */
export function createPrimitiveRegistryV2(
  definitions: readonly PrimitiveDefinitionV2[],
  options: PrimitiveRegistryV2Options = {},
): PrimitiveRegistryV2 {
  const byRef = new Map<
    PrimitiveDefinitionV2["ref"],
    PrimitiveDefinitionV2
  >();
  const latestByKind = new Map<string, PrimitiveDefinitionV2>();
  const aliases = new Map<string, PrimitiveDefinitionV2>();

  for (const source of definitions) {
    validatePrimitiveDefinitionV2(source);
    const definition = normalizeDefinition(source);
    if (byRef.has(definition.ref)) {
      throw new Error(`duplicate primitive V2 ref ${definition.ref}`);
    }
    if (
      options.requireClassifiedLeafInputs === true &&
      !createPrimitiveAuthoringMetadata(definition).classificationComplete
    ) {
      const paths =
        createPrimitiveAuthoringMetadata(definition).unclassifiedLeafPaths;
      throw new Error(
        `primitive ${definition.ref} has unclassified input leaves: ${paths.join(", ")}`,
      );
    }
    byRef.set(definition.ref, definition);
    const kind = primitiveKind(definition);
    const current = latestByKind.get(kind);
    if (
      current === undefined ||
      compareVersions(definition.version, current.version) > 0
    ) {
      latestByKind.set(kind, definition);
    }
  }

  validateTransitions(byRef);
  for (const definition of byRef.values()) {
    for (const alias of definition.compatibility.deprecatedAliases) {
      if (
        aliases.has(alias) ||
        latestByKind.has(alias) ||
        byRef.has(asPrimitiveRef(alias))
      ) {
        throw new Error(`duplicate or colliding primitive alias "${alias}"`);
      }
      aliases.set(alias, definition);
    }
  }

  const ordered = Object.freeze(
    [...byRef.values()].sort((left, right) =>
      left.ref.localeCompare(right.ref),
    ),
  );
  const registryHash = hashPrimitiveRegistryV2(ordered);

  return Object.freeze({
    schema: "dzupagent.primitiveRegistry/v2" as const,
    registryHash,
    get(ref: PrimitiveDefinitionV2["ref"]) {
      return byRef.get(ref);
    },
    resolve(kind: string, version?: string) {
      return version === undefined
        ? latestByKind.get(kind)
        : byRef.get(`primitive://${kind}@${version}`);
    },
    resolveAlias(alias: string) {
      return aliases.get(alias);
    },
    list(namespace?: string) {
      return namespace === undefined
        ? ordered
        : Object.freeze(
            ordered.filter((definition) => definition.namespace === namespace),
          );
    },
    has(ref: PrimitiveDefinitionV2["ref"]) {
      return byRef.has(ref);
    },
  });
}

/** Extend a registry without weakening duplicate or compatibility checks. */
export function extendPrimitiveRegistryV2(
  base: PrimitiveRegistryV2,
  definitions: readonly PrimitiveDefinitionV2[],
  options: PrimitiveRegistryV2Options = {},
): PrimitiveRegistryV2 {
  return createPrimitiveRegistryV2([...base.list(), ...definitions], options);
}

/** Hash exact definition identities, not registry insertion order. */
export function hashPrimitiveRegistryV2(
  definitions: readonly PrimitiveDefinitionV2[],
): `sha256:${string}` {
  const identities = [...definitions]
    .map((definition) => ({
      ref: definition.ref,
      semanticHash: definition.compatibility.semanticHash,
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(identities))
    .digest("hex")}`;
}

function normalizeDefinition(
  definition: PrimitiveDefinitionV2,
): PrimitiveDefinitionV2 {
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = definition;
  return definePrimitiveV2({
    ...contract,
    compatibility,
  } as PrimitiveDefinitionV2Input);
}

function validateTransitions(
  byRef: ReadonlyMap<
    PrimitiveDefinitionV2["ref"],
    PrimitiveDefinitionV2
  >,
): void {
  for (const definition of byRef.values()) {
    const kind = primitiveKind(definition);
    for (const supersededRef of definition.compatibility.supersedes) {
      const superseded = byRef.get(supersededRef);
      if (superseded === undefined) {
        throw new Error(
          `primitive ${definition.ref} supersedes missing ${supersededRef}`,
        );
      }
      if (primitiveKind(superseded) !== kind) {
        throw new Error(
          `primitive ${definition.ref} cannot supersede a different primitive kind`,
        );
      }
      if (compareVersions(definition.version, superseded.version) <= 0) {
        throw new Error(
          `primitive ${definition.ref} must supersede an older version`,
        );
      }
    }
    const compensation = definition.effect.compensation;
    if (compensation !== undefined && !byRef.has(compensation)) {
      throw new Error(
        `primitive ${definition.ref} references missing compensation ${compensation}`,
      );
    }
  }
}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function asPrimitiveRef(value: string): PrimitiveDefinitionV2["ref"] {
  return value.startsWith("primitive://")
    ? (value as PrimitiveDefinitionV2["ref"])
    : (`primitive://${value}` as PrimitiveDefinitionV2["ref"]);
}
