import { createHash } from "node:crypto";

import type {
  PrimitiveDefinition,
  PrimitiveDefinitionV2,
  PrimitiveDefinitionV2Input,
  PrimitiveExpansionHandlers,
  PrimitiveJsonSchema,
  PrimitiveOutputPortDefinition,
  PrimitiveSchema,
} from "./types.js";
import {
  validatePrimitiveAuthoringSchema,
  validatePrimitiveSchema,
} from "./authoring-metadata.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const INPUT_PATH_PATTERN =
  /^[A-Za-z][A-Za-z0-9_-]*(?:\.(?:[A-Za-z][A-Za-z0-9_-]*|\*))+$/;

/** Create a frozen V2 definition with a deterministic compatibility hash. */
export function definePrimitiveV2(
  input: PrimitiveDefinitionV2Input,
): PrimitiveDefinitionV2 {
  const semanticHash = hashPrimitiveDefinitionV2(input);
  const definition: PrimitiveDefinitionV2 = {
    ...input,
    requiresProfiles: Object.freeze([...input.requiresProfiles]),
    requiresCapabilities: Object.freeze([...input.requiresCapabilities]),
    acceptedInputClassifications: Object.freeze([
      ...input.acceptedInputClassifications,
    ]),
    inputSchema: freezeSchema(input.inputSchema),
    ...(input.inputPathClassifications === undefined
      ? {}
      : {
          inputPathClassifications: Object.freeze(
            Object.fromEntries(
              Object.entries(input.inputPathClassifications).sort(
                ([left], [right]) => left.localeCompare(right),
              ),
            ),
          ),
        }),
    credentialInputPaths: Object.freeze([...input.credentialInputPaths]),
    outputPorts: freezeOutputPorts(input.outputPorts),
    errorSchema: freezeSchema(input.errorSchema),
    errors: Object.freeze(input.errors.map((error) => Object.freeze({ ...error }))),
    effect: Object.freeze({
      ...input.effect,
      classes: Object.freeze([...input.effect.classes]),
    }),
    execution: Object.freeze({
      ...input.execution,
      ...(input.execution.expandsTo === undefined
        ? {}
        : { expandsTo: Object.freeze([...input.execution.expandsTo]) }),
      delivery: Object.freeze([...input.execution.delivery]),
      durability: Object.freeze([...input.execution.durability]),
    }),
    policy: Object.freeze({
      ...input.policy,
      allowedOverrides: Object.freeze([...input.policy.allowedOverrides]),
      requiredApprovalClasses: Object.freeze([
        ...input.policy.requiredApprovalClasses,
      ]),
    }),
    evidence: Object.freeze({
      ...input.evidence,
      required: Object.freeze([...input.evidence.required]),
    }),
    compatibility: Object.freeze({
      ...input.compatibility,
      semanticHash,
      supersedes: Object.freeze([...input.compatibility.supersedes]),
      deprecatedAliases: Object.freeze([
        ...input.compatibility.deprecatedAliases,
      ]),
    }),
  };
  validatePrimitiveDefinitionV2(definition);
  return Object.freeze(definition);
}

/**
 * Generate the legacy registry view. Expansion functions stay outside the
 * serializable V2 contract and are attached through stable expansion refs.
 */
export function toPrimitiveDefinitionV1(
  definition: PrimitiveDefinitionV2,
  expansionHandlers: PrimitiveExpansionHandlers = {},
): PrimitiveDefinition {
  const kind = primitiveKind(definition);
  const expand =
    definition.execution.expansionRef === undefined
      ? undefined
      : expansionHandlers[definition.execution.expansionRef];
  if (definition.execution.kind === "expand" && expand === undefined) {
    throw new Error(
      `primitive ${kind}@${definition.version} requires expansion handler ${definition.execution.expansionRef ?? "<missing>"}`,
    );
  }
  const schema =
    typeof definition.inputSchema === "string"
      ? { $ref: definition.inputSchema }
      : definition.inputSchema;
  const outputSchema = outputSchemaFromPorts(definition.outputPorts);
  const idempotency =
    definition.effect.idempotency === "pure"
      ? "idempotent"
      : definition.effect.idempotency;

  return {
    kind,
    version: definition.version,
    namespace: definition.namespace,
    category: definition.category,
    ...(definition.description === undefined
      ? {}
      : { description: definition.description }),
    schema,
    outputSchema,
    ...(definition.effect.classes[0] === undefined
      ? {}
      : { effectClass: definition.effect.classes[0] }),
    idempotency,
    ...(definition.execution.expandsTo === undefined
      ? {}
      : { expandsTo: [...definition.execution.expandsTo] }),
    ...(expand === undefined ? {} : { expand }),
    ...(definition.execution.handlerRef === undefined
      ? {}
      : { executesWith: definition.execution.handlerRef }),
  };
}

export function primitiveKind(definition: PrimitiveDefinitionV2): string {
  return definition.ref.slice(
    "primitive://".length,
    definition.ref.lastIndexOf("@"),
  );
}

export function validatePrimitiveDefinitionV2(
  definition: PrimitiveDefinitionV2,
): void {
  const identity = `${primitiveKind(definition)}@${definition.version}`;
  if (definition.ref !== `primitive://${identity}`) {
    throw new Error(
      `primitive ${identity} ref must be primitive://${identity}; received ${definition.ref}`,
    );
  }
  if (
    primitiveKind(definition).split(".").at(-1) !== definition.name
  ) {
    throw new Error(`primitive ${identity} name must match its ref`);
  }
  if (!SHA256_PATTERN.test(definition.compatibility.semanticHash)) {
    throw new Error(`primitive ${identity} has an invalid semantic hash`);
  }
  if (Object.keys(definition.outputPorts).length === 0) {
    throw new Error(`primitive ${identity} must declare at least one output port`);
  }
  if (definition.effect.classes.length === 0) {
    throw new Error(`primitive ${identity} must declare at least one effect class`);
  }
  if (definition.acceptedInputClassifications.length === 0) {
    throw new Error(
      `primitive ${identity} must declare accepted input classifications`,
    );
  }
  if (
    new Set(definition.acceptedInputClassifications).size !==
    definition.acceptedInputClassifications.length
  ) {
    throw new Error(
      `primitive ${identity} repeats an accepted input classification`,
    );
  }
  validateUniqueNonEmpty(
    definition.requiresProfiles,
    `primitive ${identity} profile requirements`,
  );
  validateUniqueNonEmpty(
    definition.requiresCapabilities,
    `primitive ${identity} capability requirements`,
  );
  validateUniqueNonEmpty(
    definition.effect.classes,
    `primitive ${identity} effect classes`,
  );
  validateUniqueNonEmpty(
    definition.execution.delivery,
    `primitive ${identity} delivery modes`,
  );
  validateUniqueNonEmpty(
    definition.execution.durability,
    `primitive ${identity} durability modes`,
  );
  validateUniqueNonEmpty(
    definition.policy.allowedOverrides,
    `primitive ${identity} policy overrides`,
  );
  validateUniqueNonEmpty(
    definition.policy.requiredApprovalClasses,
    `primitive ${identity} approval classes`,
  );
  validateUniqueNonEmpty(
    definition.evidence.required,
    `primitive ${identity} evidence requirements`,
  );
  validateUniqueNonEmpty(
    definition.compatibility.supersedes,
    `primitive ${identity} supersession refs`,
  );
  validateUniqueNonEmpty(
    definition.compatibility.deprecatedAliases,
    `primitive ${identity} deprecated aliases`,
  );
  validateUniqueNonEmpty(
    definition.errors.map((error) => error.code),
    `primitive ${identity} error codes`,
  );
  validatePrimitiveAuthoringSchema(definition);
  validatePrimitiveSchema(definition.errorSchema, `${identity}.errorSchema`);
  for (const [port, contract] of Object.entries(definition.outputPorts)) {
    if (port.length === 0) {
      throw new Error(`primitive ${identity} output port name must not be empty`);
    }
    validatePrimitiveSchema(
      contract.schema,
      `${identity}.outputPorts.${port}.schema`,
    );
  }
  if (
    new Set(definition.credentialInputPaths).size !==
    definition.credentialInputPaths.length
  ) {
    throw new Error(`primitive ${identity} repeats a credential input path`);
  }
  if (
    definition.credentialInputPaths.some(
      (path) => !INPUT_PATH_PATTERN.test(path),
    )
  ) {
    throw new Error(
      `primitive ${identity} has an invalid credential input path`,
    );
  }
  if (
    definition.credentialInputs === "forbidden" &&
    definition.credentialInputPaths.length > 0
  ) {
    throw new Error(
      `primitive ${identity} forbids credentials but declares credential input paths`,
    );
  }
  if (
    definition.credentialInputs !== "forbidden" &&
    definition.credentialInputPaths.length === 0
  ) {
    throw new Error(
      `primitive ${identity} accepts credentials but declares no credential input paths`,
    );
  }
  if (
    definition.credentialInputs === "handle-only" &&
    (definition.credentialResolverCapabilityRef === undefined ||
      !definition.requiresCapabilities.includes(
        definition.credentialResolverCapabilityRef,
      ))
  ) {
    throw new Error(
      `primitive ${identity} must require its credential resolver capability`,
    );
  }
  if (
    definition.credentialInputs !== "handle-only" &&
    definition.credentialResolverCapabilityRef !== undefined
  ) {
    throw new Error(
      `primitive ${identity} declares a credential resolver without handle-only inputs`,
    );
  }
  if (
    definition.evidence.redactionReceiptRequired &&
    definition.evidence.redactionReceiptSchema !==
      "dzupagent.flowRedactionReceipt/v1"
  ) {
    throw new Error(
      `primitive ${identity} requires the canonical redaction receipt schema`,
    );
  }
  if (
    definition.evidence.redactionReceiptRequired &&
    definition.evidence.redactionPolicyRef === undefined
  ) {
    throw new Error(
      `primitive ${identity} requires a redaction policy reference`,
    );
  }
  if (
    !definition.evidence.redactionReceiptRequired &&
    definition.evidence.redactionReceiptSchema !== undefined
  ) {
    throw new Error(
      `primitive ${identity} declares a redaction receipt schema without requiring a receipt`,
    );
  }
  if (definition.execution.delivery.length === 0) {
    throw new Error(`primitive ${identity} must declare delivery support`);
  }
  if (definition.execution.durability.length === 0) {
    throw new Error(`primitive ${identity} must declare durability support`);
  }
  if (
    definition.execution.kind === "expand" &&
    definition.execution.expansionRef === undefined
  ) {
    throw new Error(`primitive ${identity} must declare an expansionRef`);
  }
  if (
    definition.execution.kind !== "expand" &&
    definition.execution.handlerRef === undefined
  ) {
    throw new Error(`primitive ${identity} must declare a handlerRef`);
  }
  const {
    compatibility: storedCompatibility,
    ...definitionWithoutCompatibility
  } = definition;
  const {
    semanticHash: _semanticHash,
    ...compatibilityWithoutHash
  } = storedCompatibility;
  const expectedHash = hashPrimitiveDefinitionV2({
    ...definitionWithoutCompatibility,
    compatibility: compatibilityWithoutHash,
  });
  if (definition.compatibility.semanticHash !== expectedHash) {
    throw new Error(
      `primitive ${identity} semantic hash does not match its contract`,
    );
  }
}

export function hashPrimitiveDefinitionV2(
  input: PrimitiveDefinitionV2Input,
): `sha256:${string}` {
  const hashable = {
    ...input,
    compatibility: {
      supersedes: input.compatibility.supersedes,
      deprecatedAliases: input.compatibility.deprecatedAliases,
    },
  };
  return `sha256:${createHash("sha256")
    .update(stableStringify(hashable))
    .digest("hex")}`;
}

function outputSchemaFromPorts(
  ports: Readonly<Record<string, PrimitiveOutputPortDefinition>>,
): PrimitiveJsonSchema {
  const required = Object.entries(ports)
    .filter(([, port]) => port.cardinality !== "optional")
    .map(([name]) => name)
    .sort();
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(ports)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, port]) => [
          name,
          typeof port.schema === "string" ? { $ref: port.schema } : port.schema,
        ]),
    ),
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

function freezeOutputPorts(
  ports: Readonly<Record<string, PrimitiveOutputPortDefinition>>,
): Readonly<Record<string, PrimitiveOutputPortDefinition>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(ports).map(([name, port]) => [
        name,
        Object.freeze({ ...port, schema: freezeSchema(port.schema) }),
      ]),
    ),
  );
}

function freezeSchema<T extends PrimitiveSchema>(schema: T): T {
  return (typeof schema === "string"
    ? schema
    : freezeJson(schema, new WeakSet())) as T;
}

function freezeJson(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("cannot freeze cyclic primitive schema");
  seen.add(value);
  if (Array.isArray(value)) {
    const array = value.map((item) => freezeJson(item, seen));
    seen.delete(value);
    return Object.freeze(array);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const frozen = Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [
      key,
      freezeJson(nested, seen),
    ]),
  );
  seen.delete(value);
  return Object.freeze(frozen);
}

function validateUniqueNonEmpty(
  values: readonly string[],
  label: string,
): void {
  if (values.some((value) => value.length === 0)) {
    throw new Error(`${label} must not contain empty values`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError("cannot hash cyclic primitive definition");
  seen.add(value);
  if (Array.isArray(value)) {
    const serialized = `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  const record = value as Record<string, unknown>;
  const serialized = `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`,
    )
    .join(",")}}`;
  seen.delete(value);
  return serialized;
}
