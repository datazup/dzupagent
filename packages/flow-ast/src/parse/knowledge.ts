import type { KnowledgeWriteNode, KnowledgeQueryNode } from "../types.js";
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";

export function parseKnowledgeWrite(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): KnowledgeWriteNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);

  const scope = obj.scope;
  if (typeof scope !== "string" || scope.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `knowledge.write.scope must be a non-empty string, received ${describeJsType(
        scope
      )}`,
      pointer: joinPointer(pointer, "scope"),
    });
    return null;
  }

  if (!("entry" in obj)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "knowledge.write.entry is required",
      pointer: joinPointer(pointer, "entry"),
    });
    return null;
  }

  return {
    type: "knowledge.write",
    ...common,
    scope,
    entry: obj.entry,
  };
}

export function parseKnowledgeQuery(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): KnowledgeQueryNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);

  const filter = obj.filter;
  if (!isPlainObject(filter)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: `knowledge.query.filter must be an object, received ${describeJsType(
        filter
      )}`,
      pointer: joinPointer(pointer, "filter"),
    });
    return null;
  }

  const output = obj.output;
  if (typeof output !== "string" || output.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `knowledge.query.output must be a non-empty string, received ${describeJsType(
        output
      )}`,
      pointer: joinPointer(pointer, "output"),
    });
    return null;
  }

  return {
    type: "knowledge.query",
    ...common,
    filter,
    output,
  };
}
