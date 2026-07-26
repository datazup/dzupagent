import type {
  FlowExpression,
  FlowExpressionAnalysis,
} from "@dzupagent/flow-ast";
import {
  isFlowExpression as isCanonicalFlowExpression,
  parseFlowReferenceExpression,
  type FlowReferenceAnalysisOptions,
  type ParsedFlowReference,
} from "@dzupagent/flow-ast/expressions";
import type {
  FlowReferencePortBindings,
  FlowReferenceTypeBindings,
  FlowReferenceValueType,
} from "../types.js";
import {
  resolveReferenceValueType,
  type ReferenceContractIssue,
} from "./reference-contracts.js";

function isFlowExpression(value: unknown): value is FlowExpression {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.exprJs === "string") return true;
  switch (record.op) {
    case "literal":
      return "value" in record;
    case "ref":
      return typeof record.path === "string";
    case "and":
    case "or":
      return Array.isArray(record.args);
    case "not":
    case "exists":
    case "empty":
      return "arg" in record;
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return "left" in record && "right" in record;
    case "contains":
      return "collection" in record && "value" in record;
    case "in":
      return "value" in record && "collection" in record;
    default:
      return false;
  }
}

function childExpressions(expr: FlowExpression): FlowExpression[] {
  if ("exprJs" in expr) return [];
  switch (expr.op) {
    case "literal":
    case "ref":
      return [];
    case "and":
    case "or":
      return expr.args;
    case "not":
    case "exists":
    case "empty":
      return [expr.arg];
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return [expr.left, expr.right];
    case "contains":
      return [expr.collection, expr.value];
    case "in":
      return [expr.value, expr.collection];
    default: {
      const _exhaustive: never = expr;
      void _exhaustive;
      return [];
    }
  }
}

export function analyzeFlowExpression(
  expr: FlowExpression,
  referenceOptions: FlowReferenceAnalysisOptions = {},
): FlowExpressionAnalysis {
  if (!isFlowExpression(expr)) {
    return {
      deterministic: false,
      refs: [],
      warnings: ["INVALID_EXPRESSION_NODE"],
    };
  }

  if ("exprJs" in expr) {
    return {
      deterministic: false,
      refs: [],
      warnings: ["RAW_JS_EXPRESSION"],
    };
  }
  if (expr.op === "ref") {
    const parsed = parseFlowReferenceExpression(expr.path, {
      ...referenceOptions,
      useSite: referenceOptions.useSite ?? "required-value",
    });
    return {
      deterministic: parsed.ok,
      refs:
        parsed.reference !== undefined ? [parsed.reference.source] : [expr.path],
      warnings: parsed.diagnostics.map((diagnostic) => diagnostic.code),
    };
  }
  if (expr.op === "literal") {
    return { deterministic: true, refs: [], warnings: [] };
  }

  const children = childExpressions(expr);
  const invalidChildCount = children.filter(
    (child) => !isFlowExpression(child),
  ).length;
  const nested = children
    .filter(isFlowExpression)
    .map((child) => analyzeFlowExpression(child, referenceOptions));

  return {
    deterministic:
      invalidChildCount === 0 && nested.every((item) => item.deterministic),
    refs: [...new Set(nested.flatMap((item) => item.refs))],
    warnings: [
      ...new Set([
        ...nested.flatMap((item) => item.warnings),
        ...(invalidChildCount > 0 ? ["INVALID_EXPRESSION_NODE"] : []),
      ]),
    ],
  };
}

export interface FlowExpressionContractIssue {
  readonly code: string;
  readonly message: string;
  /** Canonical path below the FlowExpression root. */
  readonly path: string;
  readonly start?: number;
  readonly end?: number;
}

export interface FlowExpressionReferenceSite {
  readonly path: string;
  readonly reference: ParsedFlowReference;
}

export interface FlowExpressionContractAnalysis {
  readonly deterministic: boolean;
  readonly refs: readonly string[];
  readonly resultType: FlowReferenceValueType;
  readonly issues: readonly FlowExpressionContractIssue[];
  readonly referenceSites: readonly FlowExpressionReferenceSite[];
}

export interface FlowExpressionContractOptions
  extends FlowReferenceAnalysisOptions {
  readonly typeBindings?: FlowReferenceTypeBindings;
  readonly portBindings?: FlowReferencePortBindings;
  readonly requireKnownTypes?: boolean;
}

/**
 * Canonical semantic analysis for typed control expressions.
 *
 * This pass never evaluates an expression. It validates deterministic shape,
 * strict references, compatible operand types, and the statically known
 * result category consumed by branch/control admission.
 */
export function analyzeFlowExpressionContract(
  expr: FlowExpression,
  options: FlowExpressionContractOptions = {},
): FlowExpressionContractAnalysis {
  return analyzeContractNode(expr, "expression", options);
}

function analyzeContractNode(
  expr: FlowExpression,
  path: string,
  options: FlowExpressionContractOptions,
): FlowExpressionContractAnalysis {
  if (!isCanonicalFlowExpression(expr)) {
    return contractFailure(
      "INVALID_EXPRESSION_NODE",
      "typed condition contains a malformed expression node",
      path,
    );
  }
  if ("exprJs" in expr) {
    return contractFailure(
      "RAW_JS_EXPRESSION",
      "raw JavaScript expressions are nondeterministic and forbidden in typed conditions",
      path,
    );
  }
  if (expr.op === "literal") {
    return contractSuccess(literalType(expr.value));
  }
  if (expr.op === "ref") {
    const referencePath = `${path}.path`;
    const parsed = parseFlowReferenceExpression(expr.path, {
      ...options,
      policy: options.policy ?? "strict",
      useSite: "boolean-control",
      sourcePath: referencePath,
    });
    const issues: FlowExpressionContractIssue[] = parsed.diagnostics.map(
      (diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        path: referencePath,
        start: diagnostic.start,
        end: diagnostic.end,
      }),
    );
    const reference = parsed.reference;
    if (reference === undefined) {
      return {
        deterministic: false,
        refs: Object.freeze([expr.path]),
        resultType: "unknown",
        issues: Object.freeze(issues),
        referenceSites: Object.freeze([]),
      };
    }
    const typeIssues: ReferenceContractIssue[] = [];
    const resultType = resolveReferenceValueType(
      reference,
      {
        ...(options.typeBindings === undefined
          ? {}
          : { typeBindings: options.typeBindings }),
        ...(options.portBindings === undefined
          ? {}
          : { portBindings: options.portBindings }),
      },
      typeIssues,
    );
    issues.push(
      ...typeIssues.map((issue) => ({
        ...issue,
        path: referencePath,
      })),
    );
    if (
      options.requireKnownTypes === true &&
      (resultType === "unknown" || resultType === "any")
    ) {
      issues.push({
        code: "EXPRESSION_TYPE_UNKNOWN",
        message:
          `typed condition reference "${reference.source}" requires a declared value type`,
        path: referencePath,
      });
    }
    return {
      deterministic: parsed.ok && issues.length === 0,
      refs: Object.freeze([reference.source]),
      resultType,
      issues: Object.freeze(issues),
      referenceSites: Object.freeze([{ path: referencePath, reference }]),
    };
  }

  const children = expressionChildren(expr, path).map((child) => ({
    path: child.path,
    analysis: analyzeContractNode(child.expression, child.path, options),
  }));
  const issues = children.flatMap((child) => child.analysis.issues);
  const refs = [...new Set(children.flatMap((child) => child.analysis.refs))];
  const referenceSites = children.flatMap(
    (child) => child.analysis.referenceSites,
  );
  const deterministic = children.every(
    (child) => child.analysis.deterministic,
  );
  const childTypes = children.map((child) => child.analysis.resultType);

  const pushTypeIssue = (message: string): void => {
    issues.push({
      code: "EXPRESSION_TYPE_MISMATCH",
      message,
      path,
    });
  };

  let resultType: FlowReferenceValueType = "boolean";
  switch (expr.op) {
    case "and":
    case "or":
      if (childTypes.some((type) => type !== "boolean")) {
        pushTypeIssue(
          `${expr.op} requires boolean operands; received ${childTypes.join(", ")}`,
        );
      }
      break;
    case "not":
      if (childTypes[0] !== "boolean") {
        pushTypeIssue(`not requires a boolean operand; received ${childTypes[0]}`);
      }
      break;
    case "eq":
    case "ne": {
      const [left, right] = childTypes;
      if (
        left === undefined ||
        right === undefined ||
        isUnknownType(left) ||
        isUnknownType(right) ||
        (left !== right && left !== "null" && right !== "null")
      ) {
        pushTypeIssue(
          `${expr.op} requires declared compatible operand types; received ${left} and ${right}`,
        );
      }
      break;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const [left, right] = childTypes;
      if (
        left === undefined ||
        right === undefined ||
        left !== right ||
        (left !== "number" && left !== "string")
      ) {
        pushTypeIssue(
          `${expr.op} requires matching number or string operands; received ${left} and ${right}`,
        );
      }
      break;
    }
    case "exists":
      break;
    case "empty": {
      const type = childTypes[0];
      if (
        type !== "string" &&
        type !== "array" &&
        type !== "object" &&
        type !== "null"
      ) {
        pushTypeIssue(
          `empty requires a string, array, object, or null operand; received ${type}`,
        );
      }
      break;
    }
    case "contains": {
      const [collection, value] = childTypes;
      if (
        !(
          (collection === "string" && value === "string") ||
          (collection === "array" && value !== "credential" && value !== undefined)
        )
      ) {
        pushTypeIssue(
          `contains requires a compatible string or array collection; received ${collection} and ${value}`,
        );
      }
      break;
    }
    case "in": {
      const [value, collection] = childTypes;
      if (
        !(
          (collection === "string" && value === "string") ||
          (collection === "array" && value !== "credential" && value !== undefined)
        )
      ) {
        pushTypeIssue(
          `in requires a compatible string or array collection; received ${value} and ${collection}`,
        );
      }
      break;
    }
    default:
      resultType = "unknown";
  }

  return {
    deterministic: deterministic && issues.length === 0,
    refs: Object.freeze(refs),
    resultType,
    issues: Object.freeze(issues),
    referenceSites: Object.freeze(referenceSites),
  };
}

function expressionChildren(
  expr: Exclude<FlowExpression, { exprJs: string } | { op: "literal" } | { op: "ref" }>,
  path: string,
): Array<{ path: string; expression: FlowExpression }> {
  switch (expr.op) {
    case "and":
    case "or":
      return expr.args.map((expression, index) => ({
        path: `${path}.args[${index}]`,
        expression,
      }));
    case "not":
    case "exists":
    case "empty":
      return [{ path: `${path}.arg`, expression: expr.arg }];
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return [
        { path: `${path}.left`, expression: expr.left },
        { path: `${path}.right`, expression: expr.right },
      ];
    case "contains":
      return [
        { path: `${path}.collection`, expression: expr.collection },
        { path: `${path}.value`, expression: expr.value },
      ];
    case "in":
      return [
        { path: `${path}.value`, expression: expr.value },
        { path: `${path}.collection`, expression: expr.collection },
      ];
  }
}

function contractSuccess(
  resultType: FlowReferenceValueType,
): FlowExpressionContractAnalysis {
  return {
    deterministic: true,
    refs: Object.freeze([]),
    resultType,
    issues: Object.freeze([]),
    referenceSites: Object.freeze([]),
  };
}

function contractFailure(
  code: string,
  message: string,
  path: string,
): FlowExpressionContractAnalysis {
  return {
    deterministic: false,
    refs: Object.freeze([]),
    resultType: "unknown",
    issues: Object.freeze([{ code, message, path }]),
    referenceSites: Object.freeze([]),
  };
}

function literalType(
  value: string | number | boolean | null,
): FlowReferenceValueType {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function isUnknownType(type: FlowReferenceValueType): boolean {
  return type === "unknown" || type === "any";
}
