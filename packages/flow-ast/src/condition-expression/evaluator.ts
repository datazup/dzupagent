/**
 * Evaluation of the legacy runtime condition subset against flow state:
 * boolean composition (`||`, `&&`, `!`), the fixed comparison-operator set,
 * and literal/path operand resolution.
 *
 * Internal to the condition-expression engine; consume the engine through
 * `../condition-expression.js`.
 */

import {
  findTopLevelComparison,
  isNumberLiteral,
  isPathExpression,
  isQuotedString,
  splitTopLevel,
  stripWrappingParens,
} from "./source-scan.js";
import { resolveFlowStatePath } from "./state-templates.js";

export function evaluateConditionSource(
  source: string,
  state: Record<string, unknown>,
): unknown {
  const trimmed = stripWrappingParens(source.trim());
  if (trimmed.length === 0) return false;

  const orParts = splitTopLevel(trimmed, "||");
  if (orParts.length > 1)
    return orParts.some((part) =>
      Boolean(evaluateConditionSource(part, state)),
    );

  const andParts = splitTopLevel(trimmed, "&&");
  if (andParts.length > 1)
    return andParts.every((part) =>
      Boolean(evaluateConditionSource(part, state)),
    );

  if (trimmed.startsWith("!"))
    return !Boolean(evaluateConditionSource(trimmed.slice(1), state));

  const comparison = findTopLevelComparison(trimmed);
  if (comparison !== null) {
    const left = resolveConditionOperand(comparison.left, state);
    const right = resolveConditionOperand(comparison.right, state);
    switch (comparison.operator) {
      case "===":
      case "==":
        return left === right;
      case "!==":
      case "!=":
        return left !== right;
      case ">":
        return Number(left) > Number(right);
      case ">=":
        return Number(left) >= Number(right);
      case "<":
        return Number(left) < Number(right);
      case "<=":
        return Number(left) <= Number(right);
    }
  }

  return resolveConditionOperand(trimmed, state);
}

function resolveConditionOperand(
  raw: string,
  state: Record<string, unknown>,
): unknown {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "undefined") return undefined;
  if (isQuotedString(value)) return value.slice(1, -1);
  if (isNumberLiteral(value)) return Number(value);
  if (isPathExpression(value)) return resolveFlowStatePath(value, state);
  return undefined;
}
