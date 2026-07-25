import type { PrimitiveSchema } from "@dzupagent/flow-dsl";

export function validateSimulationValue(
  value: unknown,
  schema: PrimitiveSchema,
  path: string
): readonly string[] {
  if (typeof schema === "string") {
    return Object.freeze([
      `${path}: external schema reference ${schema} is not supported by the inactive local simulator`,
    ]);
  }
  return Object.freeze(validateJsonSchema(value, schema, path));
}

function validateJsonSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string
): string[] {
  const errors: string[] = [];
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => same(item, value))
  ) {
    errors.push(`${path}: value is not in the declared enum`);
    return errors;
  }

  const type = schema.type;
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push(`${path}: expected ${type}`);
    return errors;
  }

  if (type === "object" && isRecord(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string"
        )
      : [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${path}.${key}: required value is missing`);
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${path}.${key}: additional property is forbidden`);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in value) || !isRecord(childSchema)) continue;
      errors.push(
        ...validateJsonSchema(value[key], childSchema, `${path}.${key}`)
      );
    }
  }

  if (type === "array" && Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => {
      errors.push(
        ...validateJsonSchema(
          item,
          schema.items as Readonly<Record<string, unknown>>,
          `${path}[${index}]`
        )
      );
    });
  }

  if (type === "string" && typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      errors.push(
        `${path}: string is shorter than minLength ${schema.minLength}`
      );
    }
    if (
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      errors.push(
        `${path}: string is longer than maxLength ${schema.maxLength}`
      );
    }
  }
  return errors;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => same(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && same(left[key], right[key])
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
