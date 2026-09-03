import { canonicalDigestPrefixed } from "@dzupagent/canonical-json";

import type {
  FlowSchemaBinding,
  FlowSchemaDefinition,
  FlowSchemaDefinitionInput,
  FlowSchemaRef,
  FlowSchemaRegistry,
  FlowSchemaRegistryOptions,
  FlowSchemaTrust,
  ResolvedFlowSchema,
} from "./types.js";

const SCHEMA_REF_PATTERN =
  /^schema:\/\/([A-Za-z][A-Za-z0-9_.-]*)\/([A-Za-z][A-Za-z0-9_.-]*)@([A-Za-z0-9][A-Za-z0-9_.-]*)$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Define one immutable schema contract with a deterministic semantic hash. */
export function defineFlowSchema(
  input: FlowSchemaDefinitionInput,
): FlowSchemaDefinition {
  assertSchemaRef(input.ref);
  if (input.owner.trim().length === 0) {
    throw new Error(`schema ${input.ref} owner must not be empty`);
  }
  const semanticHash = hashFlowSchemaDefinition(input);
  return deepFreeze({
    ...input,
    compatibility: {
      ...input.compatibility,
      semanticHash,
      supersedes: [...input.compatibility.supersedes],
    },
  }) as FlowSchemaDefinition;
}

/** Create an exact-ref registry; trust and compatibility fail closed. */
export function createFlowSchemaRegistry(
  definitions: readonly FlowSchemaDefinition[],
  options: FlowSchemaRegistryOptions = {},
): FlowSchemaRegistry {
  const acceptedTrust = new Set<FlowSchemaTrust>(
    options.acceptedTrust ?? ["reviewed"],
  );
  if (acceptedTrust.size === 0) {
    throw new Error("schema registry must accept at least one trust class");
  }
  const byRef = new Map<FlowSchemaRef, FlowSchemaDefinition>();
  for (const source of definitions) {
    validateFlowSchemaDefinition(source);
    if (!acceptedTrust.has(source.trust)) {
      throw new Error(
        `schema ${source.ref} trust "${source.trust}" is not accepted`,
      );
    }
    if (byRef.has(source.ref)) {
      throw new Error(`duplicate schema ref ${source.ref}`);
    }
    byRef.set(source.ref, defineFlowSchema({
      ...source,
      compatibility: {
        supersedes: source.compatibility.supersedes,
      },
    }));
  }
  validateCompatibility(byRef);
  validateReferenceGraph(byRef);
  const ordered = Object.freeze(
    [...byRef.values()].sort((left, right) =>
      left.ref.localeCompare(right.ref),
    ),
  );
  const registryHash = hashBindings(
    ordered.map(toBinding),
  );
  return Object.freeze({
    schema: "dzupagent.schemaRegistry/v1" as const,
    registryHash,
    get(ref: FlowSchemaRef) {
      return byRef.get(ref);
    },
    has(ref: FlowSchemaRef) {
      return byRef.has(ref);
    },
    list(namespace?: string) {
      return namespace === undefined
        ? ordered
        : Object.freeze(
            ordered.filter(
              (definition) => schemaRefParts(definition.ref).namespace === namespace,
            ),
          );
    },
  });
}

/** Resolve an exact root and every nested exact `$ref`, returning its lock. */
export function resolveFlowSchema(
  ref: FlowSchemaRef,
  registry: FlowSchemaRegistry,
): ResolvedFlowSchema {
  assertSchemaRef(ref);
  const bindings = new Map<FlowSchemaRef, FlowSchemaBinding>();
  const jsonSchema = resolveRef(ref, registry, bindings, []);
  return Object.freeze({
    schema: "dzupagent.resolvedSchema/v1" as const,
    root: toBinding(requireSchema(ref, registry)),
    registryHash: registry.registryHash,
    bindings: Object.freeze(
      [...bindings.values()].sort((left, right) =>
        left.ref.localeCompare(right.ref),
      ),
    ),
    jsonSchema,
  });
}

export function validateFlowSchemaDefinition(
  definition: FlowSchemaDefinition,
): void {
  assertSchemaRef(definition.ref);
  if (definition.schema !== "dzupagent.schemaDefinition/v1") {
    throw new Error(`schema ${definition.ref} has an unsupported contract`);
  }
  if (definition.owner.trim().length === 0) {
    throw new Error(`schema ${definition.ref} owner must not be empty`);
  }
  if (!["reviewed", "local", "untrusted"].includes(definition.trust)) {
    throw new Error(`schema ${definition.ref} has an invalid trust class`);
  }
  if (!SHA256_PATTERN.test(definition.compatibility.semanticHash)) {
    throw new Error(`schema ${definition.ref} has an invalid semantic hash`);
  }
  const expected = hashFlowSchemaDefinition({
    schema: definition.schema,
    ref: definition.ref,
    owner: definition.owner,
    trust: definition.trust,
    jsonSchema: definition.jsonSchema,
    compatibility: {
      supersedes: definition.compatibility.supersedes,
    },
  });
  if (definition.compatibility.semanticHash !== expected) {
    throw new Error(`schema ${definition.ref} semantic hash does not match`);
  }
  if (
    new Set(definition.compatibility.supersedes).size !==
    definition.compatibility.supersedes.length
  ) {
    throw new Error(`schema ${definition.ref} repeats a supersession ref`);
  }
}

export function hashFlowSchemaDefinition(
  input: FlowSchemaDefinitionInput,
): `sha256:${string}` {
  return digest({
    schema: input.schema,
    ref: input.ref,
    owner: input.owner,
    trust: input.trust,
    jsonSchema: input.jsonSchema,
    compatibility: {
      supersedes: [...input.compatibility.supersedes].sort(),
    },
  });
}

function resolveRef(
  ref: FlowSchemaRef,
  registry: FlowSchemaRegistry,
  bindings: Map<FlowSchemaRef, FlowSchemaBinding>,
  stack: readonly FlowSchemaRef[],
): Readonly<Record<string, unknown>> {
  if (stack.includes(ref)) {
    throw new Error(`schema reference cycle: ${[...stack, ref].join(" -> ")}`);
  }
  const definition = requireSchema(ref, registry);
  bindings.set(ref, toBinding(definition));
  return resolveNode(
    definition.jsonSchema,
    registry,
    bindings,
    [...stack, ref],
  ) as Readonly<Record<string, unknown>>;
}

function resolveNode(
  value: unknown,
  registry: FlowSchemaRegistry,
  bindings: Map<FlowSchemaRef, FlowSchemaBinding>,
  stack: readonly FlowSchemaRef[],
): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item) => resolveNode(item, registry, bindings, stack)),
    );
  }
  if (!isRecord(value)) return value;
  const ref = value["$ref"];
  if (typeof ref === "string") {
    if (Object.keys(value).length !== 1) {
      throw new Error(`schema $ref "${ref}" must not have sibling keywords`);
    }
    assertSchemaRef(ref);
    return resolveRef(ref, registry, bindings, stack);
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [
          key,
          resolveNode(nested, registry, bindings, stack),
        ]),
    ),
  );
}

function validateCompatibility(
  byRef: ReadonlyMap<FlowSchemaRef, FlowSchemaDefinition>,
): void {
  for (const definition of byRef.values()) {
    const current = schemaRefParts(definition.ref);
    for (const ref of definition.compatibility.supersedes) {
      const prior = byRef.get(ref);
      if (prior === undefined) {
        throw new Error(`schema ${definition.ref} supersedes missing ${ref}`);
      }
      const previous = schemaRefParts(prior.ref);
      if (
        current.namespace !== previous.namespace ||
        current.name !== previous.name
      ) {
        throw new Error(
          `schema ${definition.ref} cannot supersede a different schema identity`,
        );
      }
      if (
        current.version.localeCompare(previous.version, undefined, {
          numeric: true,
        }) <= 0
      ) {
        throw new Error(`schema ${definition.ref} must supersede an older version`);
      }
    }
  }
}

function validateReferenceGraph(
  byRef: ReadonlyMap<FlowSchemaRef, FlowSchemaDefinition>,
): void {
  const registry: FlowSchemaRegistry = {
    schema: "dzupagent.schemaRegistry/v1",
    registryHash: hashBindings([...byRef.values()].map(toBinding)),
    get: (ref) => byRef.get(ref),
    has: (ref) => byRef.has(ref),
    list: () => [...byRef.values()],
  };
  for (const ref of byRef.keys()) resolveFlowSchema(ref, registry);
}

function requireSchema(
  ref: FlowSchemaRef,
  registry: FlowSchemaRegistry,
): FlowSchemaDefinition {
  const definition = registry.get(ref);
  if (definition === undefined) {
    throw new Error(`schema registry does not contain ${ref}`);
  }
  return definition;
}

function toBinding(definition: FlowSchemaDefinition): FlowSchemaBinding {
  return Object.freeze({
    ref: definition.ref,
    semanticHash: definition.compatibility.semanticHash,
  });
}

function hashBindings(
  bindings: readonly FlowSchemaBinding[],
): `sha256:${string}` {
  return digest(
    [...bindings].sort((left, right) => left.ref.localeCompare(right.ref)),
  );
}

// Delegates to @dzupagent/canonical-json's authoring-v1 preset. DELIBERATE
// digest change (ARCH27-T-01 family): the removed local stableStringify
// sorted keys with localeCompare, whose order varies with the host ICU
// locale and differs from UTF-16 order on mixed-case or non-ASCII keys, so
// these digests were never locale-stable to begin with. Corpus-proven
// identical to the old output for lowercase/camelCase key sets; only
// adversarial key orders change.
function digest(value: unknown): `sha256:${string}` {
  return canonicalDigestPrefixed(value, "authoring-v1");
}

function assertSchemaRef(value: string): asserts value is FlowSchemaRef {
  if (!SCHEMA_REF_PATTERN.test(value)) {
    throw new Error(`schema ref must be exact schema://namespace/name@version; received "${value}"`);
  }
}

function schemaRefParts(ref: FlowSchemaRef): {
  namespace: string;
  name: string;
  version: string;
} {
  const match = SCHEMA_REF_PATTERN.exec(ref);
  if (match === null) throw new Error(`invalid schema ref ${ref}`);
  return {
    namespace: match[1]!,
    name: match[2]!,
    version: match[3]!,
  };
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("cannot freeze cyclic schema input");
  seen.add(value);
  const frozen = Array.isArray(value)
    ? Object.freeze(value.map((item) => deepFreeze(item, seen)))
    : Object.freeze(
        Object.fromEntries(
          Object.entries(value).map(([key, nested]) => [
            key,
            deepFreeze(nested, seen),
          ]),
        ),
      );
  seen.delete(value);
  return frozen;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
