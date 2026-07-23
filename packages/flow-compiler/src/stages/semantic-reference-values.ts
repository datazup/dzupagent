import type {
  FlowNode,
  ValidationError,
} from "@dzupagent/flow-ast";
import {
  analyzeFlowTemplateReferences,
  type FlowReferenceUseSite,
} from "@dzupagent/flow-ast/expressions";

import type { WalkContext } from "./semantic-context.js";

const CHILD_NODE_FIELDS = new Set([
  "nodes",
  "body",
  "then",
  "else",
  "catch",
  "branches",
  "onApprove",
  "onReject",
]);

const GOVERNANCE_META_FIELDS = new Set([
  "invocation",
  "requires",
  "produces",
  "updates",
  "artifacts",
  "evidence",
  "provenance",
  "review",
  "approval",
  "resume",
  "idempotency",
  "mutation",
  "conditions",
]);

const POLICY_FIELDS = new Set([
  "policy",
  "approval",
  "idempotency",
  "effectClass",
]);

const OPAQUE_SCHEMA_FIELDS = new Set([
  "schema",
  "schemaRef",
  "outputSchema",
  "resultSchema",
]);

/**
 * Analyze template references in every value-bearing field owned by one node.
 *
 * Child-node containers are skipped because the semantic dispatcher visits
 * each nested node separately. Conditions and for-each sources remain owned
 * by `semantic-condition.ts`, which also understands the runtime expression
 * subset and bare references.
 */
export function validateNodeTemplateReferences(
  node: FlowNode,
  path: string,
  ctx: WalkContext,
): void {
  for (const [field, value] of Object.entries(node)) {
    if (CHILD_NODE_FIELDS.has(field)) continue;
    if (isControlReferenceField(node, field)) continue;
    if (field === "meta") {
      validateGovernanceMetadata(node, value, `${path}.meta`, ctx);
      continue;
    }

    validateTemplateValue(
      node,
      value,
      `${path}.${field}`,
      useSiteForField(field),
      ctx,
    );
  }
}

function validateGovernanceMetadata(
  node: FlowNode,
  value: unknown,
  path: string,
  ctx: WalkContext,
): void {
  if (!isRecord(value)) return;
  for (const [field, nested] of Object.entries(value)) {
    if (!GOVERNANCE_META_FIELDS.has(field)) continue;
    validateTemplateValue(node, nested, `${path}.${field}`, "policy", ctx);
  }
}

function validateTemplateValue(
  node: FlowNode,
  value: unknown,
  path: string,
  useSite: FlowReferenceUseSite,
  ctx: WalkContext,
): void {
  if (typeof value === "string") {
    if (!value.includes("{{") && !value.includes("}}")) return;
    const analysis = analyzeFlowTemplateReferences(value, {
      policy: ctx.referencePolicy,
      useSite,
      sourcePath: path,
      ...(ctx.referenceBindings !== undefined
        ? { knownBindings: ctx.referenceBindings }
        : {}),
    });
    for (const diagnostic of analysis.diagnostics) {
      const validationError: ValidationError = {
        nodeType: node.type,
        nodePath: diagnostic.sourcePath ?? path,
        code: "INVALID_REFERENCE",
        category: useSite === "policy" ? "policy" : "resolution",
        message:
          `[${diagnostic.code}] ${diagnostic.message} ` +
          `(offsets ${diagnostic.start}-${diagnostic.end})`,
      };
      if (diagnostic.severity === "error") {
        ctx.errors.push(validationError);
      } else {
        ctx.warnings.push(validationError);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateTemplateValue(
        node,
        value[index],
        `${path}[${index}]`,
        useSite,
        ctx,
      );
    }
    return;
  }

  if (!isRecord(value)) return;
  for (const [field, nested] of Object.entries(value)) {
    if (OPAQUE_SCHEMA_FIELDS.has(field)) continue;
    validateTemplateValue(
      node,
      nested,
      `${path}.${field}`,
      useSite === "policy" || POLICY_FIELDS.has(field)
        ? "policy"
        : useSite,
      ctx,
    );
  }
}

function isControlReferenceField(
  node: FlowNode,
  field: string,
): boolean {
  if (
    field === "condition" &&
    (node.type === "branch" ||
      node.type === "loop" ||
      node.type === "return_to")
  ) {
    return true;
  }
  return field === "source" && node.type === "for_each";
}

function useSiteForField(field: string): FlowReferenceUseSite {
  return POLICY_FIELDS.has(field) ? "policy" : "value-interpolation";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
