import type { FlowDataClassification } from "@dzupagent/flow-ast";

import type {
  PrimitiveAuthoringField,
  PrimitiveAuthoringMetadata,
  PrimitiveAuthoringValueType,
  PrimitiveDefinitionV2,
  PrimitiveOutputAuthoringField,
  PrimitiveSchema,
} from "./types.js";

const SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

/** Generate deterministic nested editor/form metadata from one reviewed V2 contract. */
export function createPrimitiveAuthoringMetadata(
  definition: PrimitiveDefinitionV2,
): PrimitiveAuthoringMetadata {
  const inputFields =
    typeof definition.inputSchema === "string"
      ? []
      : collectInputFields(definition, definition.inputSchema);
  const outputFields = Object.freeze(
    Object.entries(definition.outputPorts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([path, port]): PrimitiveOutputAuthoringField =>
          Object.freeze({
            path,
            valueType:
              port.cardinality === "many"
                ? "array"
                : valueTypeFromSchema(port.schema),
            classification: port.classification,
            cardinality: port.cardinality,
            persistence: port.persistence,
          }),
      ),
  );
  const unclassifiedLeafPaths = Object.freeze(
    inputFields
      .filter((field) => field.leaf && field.classification === "unclassified")
      .map((field) => field.path),
  );
  return Object.freeze({
    schema: "dzupagent.primitiveAuthoringMetadata/v1" as const,
    primitiveRef: definition.ref,
    semanticHash: definition.compatibility.semanticHash,
    inputSchema: definition.inputSchema,
    inputFields: Object.freeze(inputFields),
    outputFields,
    unclassifiedLeafPaths,
    classificationComplete:
      typeof definition.inputSchema !== "string" &&
      unclassifiedLeafPaths.length === 0,
  });
}

/** Validate the supported JSON Schema subset used for deterministic authoring. */
export function validatePrimitiveAuthoringSchema(
  definition: PrimitiveDefinitionV2,
): void {
  if (typeof definition.inputSchema === "string") {
    if (Object.keys(definition.inputPathClassifications ?? {}).length > 0) {
      throw new Error(
        `primitive ${definition.ref} cannot classify deep paths in an unresolved input-schema reference`,
      );
    }
    return;
  }
  validatePrimitiveSchema(definition.inputSchema, "inputSchema");
  for (const path of Object.keys(definition.inputPathClassifications ?? {})) {
    if (!schemaAllowsPath(definition.inputSchema, path)) {
      throw new Error(
        `primitive ${definition.ref} classifies unknown input-schema path "${path}"`,
      );
    }
  }
  for (const path of definition.credentialInputPaths) {
    if (!schemaAllowsPath(definition.inputSchema, path)) {
      throw new Error(
        `primitive ${definition.ref} declares unknown credential input path "${path}"`,
      );
    }
  }
}

/** Validate a schema reference or the deterministic inline authoring subset. */
export function validatePrimitiveSchema(
  schema: PrimitiveSchema,
  path: string,
): void {
  if (typeof schema === "string") {
    if (schema.length === 0) throw new Error(`${path} reference must not be empty`);
    return;
  }
  validateSchemaNode(schema, path, new WeakSet());
}

function collectInputFields(
  definition: PrimitiveDefinitionV2,
  root: Readonly<Record<string, unknown>>,
): PrimitiveAuthoringField[] {
  const fields: PrimitiveAuthoringField[] = [];
  walkSchema(definition, root, "", "", true, fields, new WeakSet());
  const knownPaths = new Set(fields.map((field) => field.path));
  const declaredPaths = new Set([
    ...Object.keys(definition.inputPathClassifications ?? {}),
    ...definition.credentialInputPaths,
  ]);
  for (const path of [...declaredPaths].sort()) {
    if (knownPaths.has(path)) continue;
    const credential = definition.credentialInputPaths.includes(path);
    fields.push(
      Object.freeze({
        path,
        jsonPointer: pointerForPath(path),
        valueType: credential ? "credential" : "unknown",
        required: false,
        leaf: true,
        classification: credential
          ? "secret"
          : definition.inputPathClassifications?.[path] ?? "unclassified",
        credential,
      }),
    );
  }
  return fields.sort((left, right) => left.path.localeCompare(right.path));
}

function walkSchema(
  definition: PrimitiveDefinitionV2,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  pointer: string,
  required: boolean,
  fields: PrimitiveAuthoringField[],
  seen: WeakSet<object>,
): void {
  if (seen.has(schema)) {
    throw new TypeError(`primitive ${definition.ref} input schema is cyclic`);
  }
  seen.add(schema);
  const type = schemaType(schema);
  const properties = recordValue(schema["properties"]);
  const itemSchema = recordValue(schema["items"]);
  const leaf =
    type !== "object" &&
    type !== "array" &&
    properties === undefined &&
    itemSchema === undefined;

  if (path.length > 0) {
    const credential = definition.credentialInputPaths.includes(path);
    const classification =
      credential
        ? "secret"
        : classificationForPath(
            path,
            definition.inputPathClassifications ?? {},
          );
    fields.push(
      Object.freeze({
        path,
        jsonPointer: pointer,
        valueType: credential ? "credential" : type,
        required,
        leaf,
        classification,
        credential,
        ...(typeof schema["title"] === "string"
          ? { title: schema["title"] }
          : {}),
        ...(typeof schema["description"] === "string"
          ? { description: schema["description"] }
          : {}),
        ...(Array.isArray(schema["enum"])
          ? { enum: Object.freeze([...schema["enum"]]) }
          : {}),
      }),
    );
  }

  if (properties !== undefined) {
    const requiredProperties = new Set(
      Array.isArray(schema["required"])
        ? schema["required"].filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    );
    for (const [name, child] of Object.entries(properties).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const childSchema = recordValue(child);
      if (childSchema === undefined) continue;
      walkSchema(
        definition,
        childSchema,
        joinPath(path, name),
        `${pointer}/properties/${escapePointer(name)}`,
        required && requiredProperties.has(name),
        fields,
        seen,
      );
    }
  }

  if (itemSchema !== undefined) {
    walkSchema(
      definition,
      itemSchema,
      joinPath(path, "*"),
      `${pointer}/items`,
      required,
      fields,
      seen,
    );
  }
  seen.delete(schema);
}

function validateSchemaNode(
  schema: Readonly<Record<string, unknown>>,
  path: string,
  seen: WeakSet<object>,
): void {
  if (seen.has(schema)) throw new TypeError(`${path} is cyclic`);
  seen.add(schema);
  const rawType = schema["type"];
  if (
    rawType !== undefined &&
    (typeof rawType !== "string" || !SCHEMA_TYPES.has(rawType))
  ) {
    throw new Error(`${path}.type must be a supported JSON Schema type`);
  }
  const properties = schema["properties"];
  if (
    properties !== undefined &&
    (recordValue(properties) === undefined || Array.isArray(properties))
  ) {
    throw new Error(`${path}.properties must be an object`);
  }
  if (properties !== undefined && rawType !== undefined && rawType !== "object") {
    throw new Error(`${path} declares properties but is not an object`);
  }
  const required = schema["required"];
  if (
    required !== undefined &&
    (!Array.isArray(required) ||
      required.some((entry) => typeof entry !== "string") ||
      new Set(required).size !== required.length)
  ) {
    throw new Error(`${path}.required must contain unique property names`);
  }
  const propertyRecord = recordValue(properties);
  if (propertyRecord !== undefined) {
    for (const requiredName of (required as string[] | undefined) ?? []) {
      if (!(requiredName in propertyRecord)) {
        throw new Error(
          `${path}.required references unknown property "${requiredName}"`,
        );
      }
    }
    for (const [name, child] of Object.entries(propertyRecord)) {
      const childSchema = recordValue(child);
      if (childSchema === undefined) {
        throw new Error(`${path}.properties.${name} must be an object schema`);
      }
      validateSchemaNode(childSchema, `${path}.properties.${name}`, seen);
    }
  }
  const items = schema["items"];
  if (items !== undefined) {
    const itemSchema = recordValue(items);
    if (itemSchema === undefined) {
      throw new Error(`${path}.items must be an object schema`);
    }
    if (rawType !== undefined && rawType !== "array") {
      throw new Error(`${path} declares items but is not an array`);
    }
    validateSchemaNode(itemSchema, `${path}.items`, seen);
  }
  seen.delete(schema);
}

function classificationForPath(
  path: string,
  classifications: Readonly<Record<string, FlowDataClassification>>,
): FlowDataClassification | "unclassified" {
  const segments = path.split(".");
  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = segments.slice(0, length).join(".");
    const exact = classifications[candidate];
    if (exact !== undefined) return exact;
    const wildcard = segments
      .slice(0, length)
      .map((segment) => (segment === "*" ? "*" : segment))
      .join(".");
    const classified = classifications[wildcard];
    if (classified !== undefined) return classified;
  }
  return "unclassified";
}

function valueTypeFromSchema(
  schema: PrimitiveSchema,
): PrimitiveAuthoringValueType {
  if (typeof schema === "string") return "unknown";
  return schemaType(schema);
}

function schemaType(
  schema: Readonly<Record<string, unknown>>,
): PrimitiveAuthoringValueType {
  const type = schema["type"];
  return typeof type === "string" && SCHEMA_TYPES.has(type)
    ? (type as PrimitiveAuthoringValueType)
    : "unknown";
}

function recordValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function schemaAllowsPath(
  root: Readonly<Record<string, unknown>>,
  path: string,
): boolean {
  let current: Readonly<Record<string, unknown>> = root;
  for (const segment of path.split(".")) {
    if (segment === "*") {
      const items = recordValue(current["items"]);
      if (items !== undefined) {
        current = items;
        continue;
      }
      return current["additionalProperties"] !== false;
    }
    const properties = recordValue(current["properties"]);
    const child = properties === undefined ? undefined : recordValue(properties[segment]);
    if (child !== undefined) {
      current = child;
      continue;
    }
    const additional = current["additionalProperties"];
    if (additional === false) return false;
    const additionalSchema = recordValue(additional);
    if (additionalSchema !== undefined) current = additionalSchema;
  }
  return true;
}

function pointerForPath(path: string): string {
  return path
    .split(".")
    .map((segment) =>
      segment === "*" ? "items" : `properties/${escapePointer(segment)}`,
    )
    .map((segment) => `/${segment}`)
    .join("");
}

function joinPath(parent: string, child: string): string {
  return parent.length === 0 ? child : `${parent}.${child}`;
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}
