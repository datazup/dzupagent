import type { SpddSwarmSubTask } from "../../types.js";
import { type ParseContext, describeJsType, joinPointer } from "../shared.js";

export function requireStringField(
  obj: Record<string, unknown>,
  field: string,
  nodeType: string,
  pointer: string,
  ctx: ParseContext
): string | null {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `${nodeType}.${field} must be a non-empty string, received ${describeJsType(
        value
      )}`,
      pointer: joinPointer(pointer, field),
    });
    return null;
  }
  return value;
}

export function requireArrayField(
  obj: Record<string, unknown>,
  field: string,
  nodeType: string,
  pointer: string,
  ctx: ParseContext
): unknown[] | null {
  const value = obj[field];
  if (!Array.isArray(value)) {
    ctx.errors.push({
      code: "EXPECTED_ARRAY",
      message: `${nodeType}.${field} must be an array, received ${describeJsType(
        value
      )}`,
      pointer: joinPointer(pointer, field),
    });
    return null;
  }
  return value;
}

export function requireSubTasksField(
  obj: Record<string, unknown>,
  nodeType: string,
  pointer: string,
  ctx: ParseContext
): SpddSwarmSubTask[] | null {
  const raw = requireArrayField(obj, "subTasks", nodeType, pointer, ctx);
  if (raw === null) return null;
  const subTasks: SpddSwarmSubTask[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const itemPointer = joinPointer(
      joinPointer(pointer, "subTasks"),
      String(i)
    );
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: `${nodeType}.subTasks items must be objects, received ${describeJsType(
          item
        )}`,
        pointer: itemPointer,
      });
      return null;
    }
    const record = item as Record<string, unknown>;
    const role = requireStringField(record, "role", nodeType, itemPointer, ctx);
    if (role === null) return null;
    const personaRef =
      typeof record.personaRef === "string" ? record.personaRef : undefined;
    const input =
      typeof record.input === "object" &&
      record.input !== null &&
      !Array.isArray(record.input)
        ? (record.input as Record<string, unknown>)
        : {};
    subTasks.push(
      personaRef === undefined ? { role, input } : { role, personaRef, input }
    );
  }
  return subTasks;
}
