import type { MemoryNode } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "../errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeCommonNodeFields,
  reportUnsupportedFields,
} from "../normalize-value-helpers.js";
import type { DslDiagnostic } from "../types.js";

const MEMORY_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "operation",
  "tier",
  "key",
  "valueExpr",
  "value_expr",
  "outputVar",
  "output_var",
  "query",
  "limit",
]);

const MEMORY_OPERATIONS = new Set(["read", "write", "list", "search"]);
const MEMORY_TIERS = new Set(["session", "project", "workspace"]);

export function normalizeMemory(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): MemoryNode {
  reportUnsupportedFields(raw, MEMORY_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const operation =
    raw.operation === "read" ||
    raw.operation === "write" ||
    raw.operation === "list" ||
    raw.operation === "search"
      ? raw.operation
      : "read";

  const tier =
    raw.tier === "session" || raw.tier === "project" || raw.tier === "workspace"
      ? raw.tier
      : "session";

  const node: MemoryNode = {
    type: "memory",
    ...base,
    operation,
    tier,
  };

  if (!MEMORY_OPERATIONS.has(String(raw.operation ?? ""))) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message:
        'memory.operation is required and must be "read", "write", "list", or "search"',
      path: `${path}.operation`,
    });
  }

  if (!MEMORY_TIERS.has(String(raw.tier ?? ""))) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message:
        'memory.tier is required and must be "session", "project", or "workspace"',
      path: `${path}.tier`,
    });
  }

  if (typeof raw.key === "string") {
    node.key = raw.key;
  } else if (raw.key !== undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "memory.key must be a string",
      path: `${path}.key`,
    });
  }

  const valueExprRaw = raw.valueExpr ?? raw.value_expr;
  if (typeof valueExprRaw === "string") {
    node.valueExpr = valueExprRaw;
  } else if (valueExprRaw !== undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "memory.valueExpr must be a string template expression",
      path: `${path}.valueExpr`,
    });
  }

  if (operation === "write") {
    if (!node.key) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.MISSING_REQUIRED_FIELD,
        message: 'memory.key is required when operation is "write"',
        path: `${path}.key`,
      });
    }
    if (!node.valueExpr) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.MISSING_REQUIRED_FIELD,
        message: 'memory.valueExpr is required when operation is "write"',
        path: `${path}.valueExpr`,
      });
    }
  }

  const outputVarRaw = raw.outputVar ?? raw.output_var;
  if (typeof outputVarRaw === "string") {
    node.outputVar = outputVarRaw;
  } else if (outputVarRaw !== undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "memory.outputVar must be a string",
      path: `${path}.outputVar`,
    });
  }

  if (typeof raw.query === "string") {
    node.query = raw.query;
  } else if (raw.query !== undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "memory.query must be a string template expression",
      path: `${path}.query`,
    });
  }

  if (
    typeof raw.limit === "number" &&
    Number.isInteger(raw.limit) &&
    raw.limit > 0
  ) {
    node.limit = raw.limit;
  } else if (raw.limit !== undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "memory.limit must be a positive integer",
      path: `${path}.limit`,
    });
  }

  if (operation === "search" && !node.query) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: 'memory.query is required when operation is "search"',
      path: `${path}.query`,
    });
  }

  return node;
}
