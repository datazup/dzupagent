/**
 * LEGACY string-condition engine — the curated public facade.
 *
 * This is the string-source expression subset (`{{ … }}` templates, `&&`,
 * `||`, `!`, the fixed comparison operators) that runtime edges authored as
 * raw strings still use. Per the flow-ast expression policy
 * (`packages/flow-ast/EXPRESSIONS.md`): NEW code authors structured
 * `FlowExpression` conditions and evaluates them through
 * `@dzupagent/flow-ast/typed-condition-evaluator`; this engine is kept for
 * the shipped string-condition surface and gains no new capabilities.
 *
 * Implementation lives in `condition-expression/` (source-scan,
 * state-templates, evaluator, validator); only this facade is public. The
 * root barrel star-exports this module, so everything exported here is
 * root-visible — keep the surface to the three functions and two types.
 */

import { evaluateConditionSource } from "./condition-expression/evaluator.js";
import {
  getWholeTemplatePath,
  renderTemplateText,
  resolveFlowStatePath,
} from "./condition-expression/state-templates.js";
import { containsDisallowedConstruct } from "./condition-expression/source-scan.js";
import {
  normalizeTemplatesForValidation,
  validateConditionSource,
  type FlowConditionValidationOptions,
  type FlowConditionValidationResult,
} from "./condition-expression/validator.js";

export type {
  FlowConditionValidationOptions,
  FlowConditionValidationResult,
} from "./condition-expression/validator.js";

export function resolveFlowTemplateExpression(
  expr: string,
  state: Record<string, unknown>,
): unknown {
  const wholeTemplate = getWholeTemplatePath(expr);
  if (wholeTemplate !== null) return resolveFlowStatePath(wholeTemplate, state);
  return renderTemplateText(expr, state);
}

export function resolveFlowConditionExpression(
  expr: string,
  state: Record<string, unknown>,
): unknown {
  const wholeTemplate = getWholeTemplatePath(expr);
  if (wholeTemplate !== null) return resolveFlowStatePath(wholeTemplate, state);
  return evaluateConditionSource(renderTemplateText(expr, state), state);
}

export function validateFlowConditionExpression(
  expr: string,
  options: FlowConditionValidationOptions = {},
): FlowConditionValidationResult {
  const trimmed = expr.trim();
  if (trimmed.length === 0)
    return { valid: false, reason: "condition expression is empty" };
  if (containsDisallowedConstruct(trimmed)) {
    return {
      valid: false,
      reason: "condition expression contains a disallowed construct",
    };
  }

  const normalized = normalizeTemplatesForValidation(trimmed, options);
  if (!normalized.valid) return normalized;
  return validateConditionSource(normalized.source, options);
}
