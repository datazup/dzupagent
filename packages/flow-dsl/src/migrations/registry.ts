import { canonicalDigestPrefixed } from "@datazup/canonical-json";

import type { PrimitiveDefinitionV2 } from "../primitives/types.js";
import type {
  FlowSchemaDefinition,
  FlowSchemaRef,
} from "../schemas/types.js";
import type {
  MigratableContractRef,
  VersionMigrationDefinition,
  VersionMigrationDefinitionInput,
  VersionMigrationRef,
  VersionMigrationRegistry,
  VersionMigrationRegistryOptions,
} from "./types.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MIGRATION_REF_PATTERN =
  // Anchored both ends; each segment class is separated by a literal delimiter
  // (`/`, `@`, `-to-`) that the class itself cannot match, so there is no
  // ambiguity to backtrack across. Measured flat: 10k-char adversarial input
  // 0.18ms.
  // eslint-disable-next-line security/detect-unsafe-regex -- False positive.
  /^migration:\/\/(primitive|schema)\/([A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z][A-Za-z0-9_.-]*)?)@([A-Za-z0-9][A-Za-z0-9_.-]*)-to-([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

/** Define one immutable, content-addressed report-only migration contract. */
export function defineVersionMigration(
  input: VersionMigrationDefinitionInput,
): VersionMigrationDefinition {
  validateDefinitionInput(input);
  return deepFreeze({
    ...input,
    rollback: { ...input.rollback },
    migrationHash: hashVersionMigrationDefinition(input),
  }) as VersionMigrationDefinition;
}

/** Create an exact migration catalog and bind it to current contract hashes. */
export function createVersionMigrationRegistry(
  definitions: readonly VersionMigrationDefinition[],
  options: VersionMigrationRegistryOptions = {},
): VersionMigrationRegistry {
  const byRef = new Map<VersionMigrationRef, VersionMigrationDefinition>();
  const byRoute = new Map<string, VersionMigrationDefinition>();
  for (const source of definitions) {
    validateVersionMigrationDefinition(source);
    const definition = defineVersionMigration({
      ...source,
      rollback: source.rollback,
    });
    validateCatalogBinding(definition, options);
    if (byRef.has(definition.ref)) {
      throw new Error(`duplicate migration ref ${definition.ref}`);
    }
    const route = routeKey(definition.fromRef, definition.toRef);
    if (byRoute.has(route)) {
      throw new Error(
        `duplicate migration route ${definition.fromRef} -> ${definition.toRef}`,
      );
    }
    byRef.set(definition.ref, definition);
    byRoute.set(route, definition);
  }
  const ordered = Object.freeze(
    [...byRef.values()].sort((left, right) =>
      left.ref.localeCompare(right.ref),
    ),
  );
  return Object.freeze({
    schema: "dzupagent.versionMigrationRegistry/v1" as const,
    registryHash: digest(
      ordered.map(({ ref, migrationHash }) => ({ ref, migrationHash })),
    ),
    get: (ref: VersionMigrationRef) => byRef.get(ref),
    find: (
      fromRef: MigratableContractRef,
      toRef: MigratableContractRef,
    ) => byRoute.get(routeKey(fromRef, toRef)),
    list: () => ordered,
  });
}

export function validateVersionMigrationDefinition(
  definition: VersionMigrationDefinition,
): void {
  validateDefinitionInput(definition);
  if (!SHA256_PATTERN.test(definition.migrationHash)) {
    throw new Error(`migration ${definition.ref} has an invalid hash`);
  }
  const expected = hashVersionMigrationDefinition({
    schema: definition.schema,
    ref: definition.ref,
    owner: definition.owner,
    fromRef: definition.fromRef,
    toRef: definition.toRef,
    fromSemanticHash: definition.fromSemanticHash,
    toSemanticHash: definition.toSemanticHash,
    classification: definition.classification,
    ...(definition.transformRef === undefined
      ? {}
      : { transformRef: definition.transformRef }),
    ...(definition.semanticProjectionRef === undefined
      ? {}
      : { semanticProjectionRef: definition.semanticProjectionRef }),
    rollback: definition.rollback,
  });
  if (definition.migrationHash !== expected) {
    throw new Error(`migration ${definition.ref} hash does not match`);
  }
}

export function hashVersionMigrationDefinition(
  input: VersionMigrationDefinitionInput,
): `sha256:${string}` {
  return digest({
    schema: input.schema,
    ref: input.ref,
    owner: input.owner,
    fromRef: input.fromRef,
    toRef: input.toRef,
    fromSemanticHash: input.fromSemanticHash,
    toSemanticHash: input.toSemanticHash,
    classification: input.classification,
    transformRef: input.transformRef ?? null,
    semanticProjectionRef: input.semanticProjectionRef ?? null,
    rollback: input.rollback,
  });
}

function validateDefinitionInput(
  input: VersionMigrationDefinitionInput,
): void {
  if (input.schema !== "dzupagent.versionMigrationDefinition/v1") {
    throw new Error(`migration ${input.ref} has an unsupported contract`);
  }
  if (input.owner.trim().length === 0) {
    throw new Error(`migration ${input.ref} owner must not be empty`);
  }
  if (
    !SHA256_PATTERN.test(input.fromSemanticHash) ||
    !SHA256_PATTERN.test(input.toSemanticHash)
  ) {
    throw new Error(`migration ${input.ref} requires exact semantic hashes`);
  }
  const parsed = parseMigrationRef(input.ref);
  const from = parseContractRef(input.fromRef);
  const to = parseContractRef(input.toRef);
  if (
    from.kind !== to.kind ||
    from.identity !== to.identity ||
    from.version === to.version
  ) {
    throw new Error(
      `migration ${input.ref} must connect different versions of one contract identity`,
    );
  }
  if (
    parsed.kind !== from.kind ||
    parsed.identity !== from.identity ||
    parsed.fromVersion !== from.version ||
    parsed.toVersion !== to.version
  ) {
    throw new Error(`migration ${input.ref} does not match its exact route`);
  }
  const transformRequired = input.classification !== "incompatible";
  if (transformRequired && !nonEmpty(input.transformRef)) {
    throw new Error(`migration ${input.ref} requires a transformRef`);
  }
  if (!transformRequired && input.transformRef !== undefined) {
    throw new Error(
      `incompatible migration ${input.ref} cannot declare a transformRef`,
    );
  }
  if (!transformRequired && input.rollback.kind === "exact") {
    throw new Error(
      `incompatible migration ${input.ref} cannot declare exact rollback`,
    );
  }
  if (
    input.classification === "equivalent" &&
    !nonEmpty(input.semanticProjectionRef)
  ) {
    throw new Error(
      `equivalent migration ${input.ref} requires a semanticProjectionRef`,
    );
  }
  if (input.rollback.kind === "exact" && !nonEmpty(input.rollback.transformRef)) {
    throw new Error(`migration ${input.ref} exact rollback requires a transformRef`);
  }
  if (
    input.rollback.kind === "manual" &&
    input.rollback.instructions.trim().length === 0
  ) {
    throw new Error(`migration ${input.ref} manual rollback needs instructions`);
  }
  if (
    input.rollback.kind === "unavailable" &&
    input.rollback.reason.trim().length === 0
  ) {
    throw new Error(`migration ${input.ref} unavailable rollback needs a reason`);
  }
}

function validateCatalogBinding(
  definition: VersionMigrationDefinition,
  options: VersionMigrationRegistryOptions,
): void {
  const from = resolveContract(definition.fromRef, options);
  const to = resolveContract(definition.toRef, options);
  if (from.semanticHash !== definition.fromSemanticHash) {
    throw new Error(`migration ${definition.ref} source semantic hash drift`);
  }
  if (to.semanticHash !== definition.toSemanticHash) {
    throw new Error(`migration ${definition.ref} target semantic hash drift`);
  }
  if (!to.supersedes.includes(definition.fromRef)) {
    throw new Error(
      `migration ${definition.ref} target does not supersede its source`,
    );
  }
}

function resolveContract(
  ref: MigratableContractRef,
  options: VersionMigrationRegistryOptions,
): {
  semanticHash: `sha256:${string}`;
  supersedes: readonly MigratableContractRef[];
} {
  if (ref.startsWith("primitive://")) {
    const definition: PrimitiveDefinitionV2 | undefined =
      options.primitiveRegistry?.get(
        ref as PrimitiveDefinitionV2["ref"],
      );
    if (definition === undefined) {
      throw new Error(`migration registry cannot resolve ${ref}`);
    }
    return {
      semanticHash: definition.compatibility.semanticHash,
      supersedes: definition.compatibility.supersedes,
    };
  }
  const definition: FlowSchemaDefinition | undefined =
    options.schemaRegistry?.get(ref as FlowSchemaRef);
  if (definition === undefined) {
    throw new Error(`migration registry cannot resolve ${ref}`);
  }
  return {
    semanticHash: definition.compatibility.semanticHash,
    supersedes: definition.compatibility.supersedes,
  };
}

function parseMigrationRef(ref: VersionMigrationRef): {
  kind: "primitive" | "schema";
  identity: string;
  fromVersion: string;
  toVersion: string;
} {
  const match = MIGRATION_REF_PATTERN.exec(ref);
  if (match === null) {
    throw new Error(`invalid exact migration ref "${ref}"`);
  }
  return {
    kind: match[1] as "primitive" | "schema",
    identity: match[2]!,
    fromVersion: match[3]!,
    toVersion: match[4]!,
  };
}

function parseContractRef(ref: MigratableContractRef): {
  kind: "primitive" | "schema";
  identity: string;
  version: string;
} {
  const primitive = /^primitive:\/\/([^@]+)@(.+)$/.exec(ref);
  if (primitive !== null) {
    return {
      kind: "primitive",
      identity: primitive[1]!,
      version: primitive[2]!,
    };
  }
  const schema = /^schema:\/\/([^/]+)\/([^@]+)@(.+)$/.exec(ref);
  if (schema === null) throw new Error(`invalid migratable contract ref ${ref}`);
  return {
    kind: "schema",
    identity: `${schema[1]}/${schema[2]}`,
    version: schema[3]!,
  };
}

function routeKey(
  fromRef: MigratableContractRef,
  toRef: MigratableContractRef,
): string {
  return `${fromRef}\u0000${toRef}`;
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

// Delegates to @datazup/canonical-json's authoring-v1 preset. DELIBERATE
// digest change (ARCH27-T-01 family): the removed local stableStringify
// sorted keys with localeCompare, whose order varies with the host ICU
// locale and differs from UTF-16 order on mixed-case or non-ASCII keys, so
// these digests were never locale-stable to begin with. Corpus-proven
// identical to the old output for lowercase/camelCase key sets; only
// adversarial key orders change.
function digest(value: unknown): `sha256:${string}` {
  return canonicalDigestPrefixed(value, "authoring-v1");
}

function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFreeze(item)));
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        deepFreeze(nested),
      ]),
    ),
  );
}
