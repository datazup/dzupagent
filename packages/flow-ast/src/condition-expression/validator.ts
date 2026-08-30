/**
 * Validation of the legacy runtime condition subset: structural checks over
 * the same grammar the evaluator walks, plus strict-reference validation
 * delegated to the reference-expression parser.
 *
 * Internal to the condition-expression engine; consume the engine through
 * `../condition-expression.js`.
 */

import {
  parseFlowReferenceExpression,
  type FlowReferenceBindings,
  type FlowReferencePolicy,
} from "../reference-expression.js";

import {
  findTopLevelComparison,
  isNumberLiteral,
  isPathExpression,
  isQuotedString,
  splitTopLevel,
  stripWrappingParens,
} from "./source-scan.js";

export type FlowConditionValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export interface FlowConditionValidationOptions {
  referencePolicy?: FlowReferencePolicy;
  allowedRoots?: readonly string[];
  knownBindings?: FlowReferenceBindings;
}

type TemplateNormalizationResult =
  | { valid: true; source: string }
  | { valid: false; reason: string };

export function validateConditionSource(
  source: string,
  options: FlowConditionValidationOptions,
): FlowConditionValidationResult {
  const trimmed = stripWrappingParens(source.trim());
  if (trimmed.length === 0)
    return { valid: false, reason: "condition expression is empty" };

  const orParts = splitTopLevel(trimmed, "||");
  if (orParts.length > 1) return validateParts(orParts, options);

  const andParts = splitTopLevel(trimmed, "&&");
  if (andParts.length > 1) return validateParts(andParts, options);

  if (trimmed.startsWith("!")) {
    return validateConditionSource(trimmed.slice(1), options);
  }

  const comparison = findTopLevelComparison(trimmed);
  if (comparison !== null) {
    const left = validateConditionOperand(comparison.left, options);
    if (!left.valid) return left;
    return validateConditionOperand(comparison.right, options);
  }

  return validateConditionOperand(trimmed, options);
}

function validateParts(
  parts: string[],
  options: FlowConditionValidationOptions,
): FlowConditionValidationResult {
  for (const part of parts) {
    const result = validateConditionSource(part, options);
    if (!result.valid) return result;
  }
  return { valid: true };
}

function validateConditionOperand(
  raw: string,
  options: FlowConditionValidationOptions,
): FlowConditionValidationResult {
  const value = raw.trim();
  if (value.length === 0)
    return { valid: false, reason: "condition operand is empty" };
  if (
    value === "true" ||
    value === "false" ||
    value === "null" ||
    value === "undefined" ||
    isQuotedString(value) ||
    isNumberLiteral(value)
  ) {
    return { valid: true };
  }
  if (isPathExpression(value)) {
    if (options.referencePolicy !== "strict") return { valid: true };
    return validateStrictConditionReference(value, options);
  }
  return {
    valid: false,
    reason: `unsupported condition operand "${value}" in runtime-supported expression subset`,
  };
}

export function normalizeTemplatesForValidation(
  source: string,
  options: FlowConditionValidationOptions,
): TemplateNormalizationResult {
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("{{", cursor);
    if (open === -1) {
      output += source.slice(cursor);
      break;
    }
    const close = source.indexOf("}}", open + 2);
    if (close === -1)
      return { valid: false, reason: "unterminated template expression" };
    output += source.slice(cursor, open);
    const path = source.slice(open + 2, close).trim();
    if (options.referencePolicy === "strict") {
      const validation = validateStrictConditionReference(path, options);
      if (!validation.valid) return validation;
    } else if (!isPathExpression(path)) {
      return { valid: false, reason: `unsupported template path "${path}"` };
    }
    // The template path was already validated above. Substitute a literal so
    // strict validation does not parse a synthetic identifier as a second,
    // disallowed reference root.
    output += "true";
    cursor = close + 2;
  }
  return { valid: true, source: output };
}

function validateStrictConditionReference(
  source: string,
  options: FlowConditionValidationOptions,
): FlowConditionValidationResult {
  const parsed = parseFlowReferenceExpression(source, {
    policy: "strict",
    useSite: "boolean-control",
    ...(options.allowedRoots !== undefined
      ? { allowedRoots: options.allowedRoots }
      : {}),
    ...(options.knownBindings !== undefined
      ? { knownBindings: options.knownBindings }
      : {}),
  });
  const diagnostic = parsed.diagnostics[0];
  if (!parsed.ok || parsed.reference === undefined) {
    return {
      valid: false,
      reason:
        diagnostic === undefined
          ? "invalid strict reference"
          : `${diagnostic.code} at ${diagnostic.start}-${diagnostic.end}: ${diagnostic.message}`,
    };
  }
  if (parsed.reference.filters.length > 0) {
    return {
      valid: false,
      reason:
        "reference filters are not supported in runtime condition expressions",
    };
  }
  if (parsed.reference.segments.some((segment) => segment.kind === "index")) {
    return {
      valid: false,
      reason:
        "indexed references are not supported in runtime condition expressions",
    };
  }
  return { valid: true };
}
