import type {
  FlowExpression,
  FlowTypedCondition,
} from "@dzupagent/flow-ast";

import type { DslDiagnostic } from "../types.js";

export interface ParsedV2TypedCondition {
  readonly condition: FlowTypedCondition;
  /**
   * Canonical path below `typedCondition` -> authored path below `when`.
   * Only exact mappings are recorded; generated schema fields stay derived.
   */
  readonly sourceBindings: Readonly<Record<string, string>>;
}

interface ParseState {
  readonly diagnostics: DslDiagnostic[];
  readonly sourceBindings: Record<string, string>;
  nodes: number;
}

const MAX_EXPRESSION_NODES = 256;
const MAX_EXPRESSION_DEPTH = 32;
const NONDETERMINISTIC_KEYS = new Set([
  "exprJs",
  "http",
  "now",
  "provider",
  "random",
  "tool",
]);

/** Parse the bounded v2 keyed expression syntax directly into FlowExpression. */
export function parseV2TypedCondition(
  value: unknown,
  authoredPath: string,
  diagnostics: DslDiagnostic[],
): ParsedV2TypedCondition | null {
  const state: ParseState = {
    diagnostics,
    sourceBindings: {
      expression: "",
    },
    nodes: 0,
  };
  const expression = parseExpression(
    value,
    authoredPath,
    "",
    "expression",
    state,
    0,
  );
  if (expression === null) return null;
  return {
    condition: {
      schema: "dzupagent.flowTypedCondition/v1",
      expression,
    },
    sourceBindings: Object.freeze({ ...state.sourceBindings }),
  };
}

function parseExpression(
  value: unknown,
  authoredPath: string,
  authoredRelativePath: string,
  canonicalPath: string,
  state: ParseState,
  depth: number,
): FlowExpression | null {
  state.nodes += 1;
  if (state.nodes > MAX_EXPRESSION_NODES) {
    invalid(
      state,
      authoredPath,
      `typed condition exceeds ${MAX_EXPRESSION_NODES} expression nodes`,
    );
    return null;
  }
  if (depth > MAX_EXPRESSION_DEPTH) {
    invalid(
      state,
      authoredPath,
      `typed condition exceeds depth ${MAX_EXPRESSION_DEPTH}`,
    );
    return null;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    state.sourceBindings[`${canonicalPath}.value`] = authoredRelativePath;
    return { op: "literal", value };
  }
  if (!isRecord(value)) {
    invalid(
      state,
      authoredPath,
      "typed condition expression must be a scalar or one-key operator object",
    );
    return null;
  }

  const entries = Object.entries(value);
  if (entries.length !== 1) {
    invalid(
      state,
      authoredPath,
      "typed condition operator object must contain exactly one key",
    );
    return null;
  }
  const [operator, operand] = entries[0]!;
  const operatorPath = `${authoredPath}.${operator}`;
  const operatorRelativePath = joinRelative(authoredRelativePath, operator);

  if (NONDETERMINISTIC_KEYS.has(operator)) {
    state.diagnostics.push({
      phase: "normalize",
      code: "V2_NONDETERMINISTIC_CONDITION",
      message:
        `v2 typed condition operator "${operator}" may perform I/O or read nondeterministic state`,
      path: operatorPath,
    });
    return null;
  }

  if (operator === "ref") {
    if (typeof operand !== "string" || operand.length === 0) {
      invalid(state, operatorPath, "typed condition ref must be a non-empty string");
      return null;
    }
    state.sourceBindings[`${canonicalPath}.path`] = operatorRelativePath;
    return { op: "ref", path: operand };
  }

  if (operator === "all" || operator === "any") {
    if (!Array.isArray(operand) || operand.length === 0) {
      invalid(
        state,
        operatorPath,
        `typed condition ${operator} requires a non-empty array`,
      );
      return null;
    }
    const args = operand.map((item, index) =>
      parseExpression(
        item,
        `${operatorPath}[${index}]`,
        `${operatorRelativePath}[${index}]`,
        `${canonicalPath}.args[${index}]`,
        state,
        depth + 1,
      ),
    );
    if (args.some((item) => item === null)) return null;
    return {
      op: operator === "all" ? "and" : "or",
      args: args as FlowExpression[],
    };
  }

  if (
    operator === "not" ||
    operator === "exists" ||
    operator === "is_empty"
  ) {
    const arg = parseExpression(
      operand,
      operatorPath,
      operatorRelativePath,
      `${canonicalPath}.arg`,
      state,
      depth + 1,
    );
    if (arg === null) return null;
    return {
      op:
        operator === "is_empty"
          ? "empty"
          : operator,
      arg,
    };
  }

  const binaryOperator = canonicalBinaryOperator(operator);
  if (binaryOperator !== undefined) {
    if (!Array.isArray(operand) || operand.length !== 2) {
      invalid(
        state,
        operatorPath,
        `typed condition ${operator} requires exactly two operands`,
      );
      return null;
    }
    const left = parseExpression(
      operand[0],
      `${operatorPath}[0]`,
      `${operatorRelativePath}[0]`,
      binaryOperator === "contains" ? `${canonicalPath}.collection` : `${canonicalPath}.left`,
      state,
      depth + 1,
    );
    const right = parseExpression(
      operand[1],
      `${operatorPath}[1]`,
      `${operatorRelativePath}[1]`,
      binaryOperator === "contains" ? `${canonicalPath}.value` : `${canonicalPath}.right`,
      state,
      depth + 1,
    );
    if (left === null || right === null) return null;
    if (binaryOperator === "contains") {
      return { op: "contains", collection: left, value: right };
    }
    return { op: binaryOperator, left, right };
  }

  if (operator === "in") {
    if (!Array.isArray(operand) || operand.length !== 2) {
      invalid(state, operatorPath, "typed condition in requires exactly two operands");
      return null;
    }
    const item = parseExpression(
      operand[0],
      `${operatorPath}[0]`,
      `${operatorRelativePath}[0]`,
      `${canonicalPath}.value`,
      state,
      depth + 1,
    );
    const collection = parseExpression(
      operand[1],
      `${operatorPath}[1]`,
      `${operatorRelativePath}[1]`,
      `${canonicalPath}.collection`,
      state,
      depth + 1,
    );
    return item === null || collection === null
      ? null
      : { op: "in", value: item, collection };
  }

  invalid(
    state,
    operatorPath,
    `unsupported v2 typed condition operator "${operator}"`,
  );
  return null;
}

function canonicalBinaryOperator(
  operator: string,
): "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | undefined {
  switch (operator) {
    case "eq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains":
      return operator;
    case "neq":
      return "ne";
    default:
      return undefined;
  }
}

function invalid(state: ParseState, path: string, message: string): void {
  state.diagnostics.push({
    phase: "normalize",
    code: "V2_INVALID_TYPED_CONDITION",
    message,
    path,
  });
}

function joinRelative(parent: string, field: string): string {
  return parent.length === 0 ? field : `${parent}.${field}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
