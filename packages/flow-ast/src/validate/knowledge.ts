import type {
  FlowNode,
  KnowledgeWriteNode,
  KnowledgeQueryNode,
} from "../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../validation-helpers.js";
import { validateCommonNodeFields } from "./shared.js";
import type { SchemaIssue } from "./shared.js";

export function validateKnowledgeWrite(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  const scope = obj["scope"];
  if (typeof scope !== "string" || scope.length === 0) {
    issues.push({
      path: joinPath(path, "scope"),
      code: "MISSING_REQUIRED_FIELD",
      message: `knowledge.write.scope is required (non-empty string), received ${describeJsType(
        scope
      )}`,
    });
    return null;
  }

  if (!("entry" in obj)) {
    issues.push({
      path: joinPath(path, "entry"),
      code: "MISSING_REQUIRED_FIELD",
      message: "knowledge.write.entry is required",
    });
    return null;
  }

  const node: KnowledgeWriteNode = {
    type: "knowledge.write",
    ...common,
    scope,
    entry: obj["entry"],
  };

  return node;
}

export function validateKnowledgeQuery(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  const filter = obj["filter"];
  if (!isPlainObject(filter)) {
    issues.push({
      path: joinPath(path, "filter"),
      code: "MISSING_REQUIRED_FIELD",
      message: `knowledge.query.filter is required (object), received ${describeJsType(
        filter
      )}`,
    });
    return null;
  }

  const output = obj["output"];
  if (typeof output !== "string" || output.length === 0) {
    issues.push({
      path: joinPath(path, "output"),
      code: "MISSING_REQUIRED_FIELD",
      message: `knowledge.query.output is required (non-empty string), received ${describeJsType(
        output
      )}`,
    });
    return null;
  }

  const node: KnowledgeQueryNode = {
    type: "knowledge.query",
    ...common,
    filter,
    output,
  };

  return node;
}
