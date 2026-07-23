import type { FlowNode } from "@dzupagent/flow-ast";
import {
  analyzeFlowTemplateReferences,
  type FlowReferenceUseSite,
} from "@dzupagent/flow-ast/expressions";

import type { WalkContext } from "./semantic-context.js";
import {
  nodeFieldSpan,
  type SemanticDiagnostic,
} from "./semantic-diagnostic.js";
import { analyzeReferenceContract } from "./reference-contracts.js";

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

export interface NodeTemplateReferenceSite {
  readonly source: string;
  readonly path: string;
  readonly useSite: FlowReferenceUseSite;
}

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
  for (const site of collectNodeTemplateReferenceSites(node, path)) {
    validateTemplateSource(node, site, ctx);
  }
}

/** Collect executable template-bearing strings without analyzing child nodes. */
export function collectNodeTemplateReferenceSites(
  node: FlowNode,
  path: string,
): NodeTemplateReferenceSite[] {
  const sites: NodeTemplateReferenceSite[] = [];
  for (const [field, value] of Object.entries(node)) {
    if (CHILD_NODE_FIELDS.has(field)) continue;
    if (isControlReferenceField(node, field)) continue;
    if (field === "meta") {
      collectGovernanceMetadata(value, `${path}.meta`, sites);
      continue;
    }

    collectTemplateValues(
      value,
      `${path}.${field}`,
      useSiteForField(field),
      sites,
    );
  }
  return sites;
}

function collectGovernanceMetadata(
  value: unknown,
  path: string,
  sites: NodeTemplateReferenceSite[],
): void {
  if (!isRecord(value)) return;
  for (const [field, nested] of Object.entries(value)) {
    if (!GOVERNANCE_META_FIELDS.has(field)) continue;
    collectTemplateValues(nested, `${path}.${field}`, "policy", sites);
  }
}

function collectTemplateValues(
  value: unknown,
  path: string,
  useSite: FlowReferenceUseSite,
  sites: NodeTemplateReferenceSite[],
): void {
  if (typeof value === "string") {
    if (!value.includes("{{") && !value.includes("}}")) return;
    sites.push({ source: value, path, useSite });
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectTemplateValues(
        value[index],
        `${path}[${index}]`,
        useSite,
        sites,
      );
    }
    return;
  }

  if (!isRecord(value)) return;
  for (const [field, nested] of Object.entries(value)) {
    if (OPAQUE_SCHEMA_FIELDS.has(field)) continue;
    collectTemplateValues(
      nested,
      `${path}.${field}`,
      useSite === "policy" || POLICY_FIELDS.has(field)
        ? "policy"
        : useSite,
      sites,
    );
  }
}

function validateTemplateSource(
  node: FlowNode,
  site: NodeTemplateReferenceSite,
  ctx: WalkContext,
): void {
  const analysis = analyzeFlowTemplateReferences(site.source, {
    policy: ctx.referencePolicy,
    useSite: site.useSite,
    sourcePath: site.path,
    ...(ctx.referenceBindings !== undefined
      ? { knownBindings: ctx.referenceBindings }
      : {}),
  });
  for (const diagnostic of analysis.diagnostics) {
    pushDiagnostic(
      node,
      diagnostic.severity,
      diagnostic.sourcePath ?? site.path,
      site.useSite,
      `[${diagnostic.code}] ${diagnostic.message}`,
      ctx,
      nodeFieldSpan(diagnostic.start, diagnostic.end),
    );
  }

  for (const reference of analysis.references) {
    for (const issue of analyzeReferenceContract(
      reference,
      analysis.form,
      {
        ...(ctx.referenceTypeBindings !== undefined
          ? { typeBindings: ctx.referenceTypeBindings }
          : {}),
        ...(ctx.referencePortBindings !== undefined
          ? { portBindings: ctx.referencePortBindings }
          : {}),
      },
    )) {
      pushDiagnostic(
        node,
        ctx.referencePolicy === "strict" ? "error" : "warning",
        site.path,
        site.useSite,
        `[${issue.code}] ${issue.message}`,
        ctx,
        nodeFieldSpan(reference.start, reference.end),
      );
    }
  }
}

function pushDiagnostic(
  node: FlowNode,
  severity: "warning" | "error",
  path: string,
  useSite: FlowReferenceUseSite,
  message: string,
  ctx: WalkContext,
  span?: SemanticDiagnostic["span"],
): void {
  const validationError: SemanticDiagnostic = {
    nodeType: node.type,
    nodePath: path,
    code: "INVALID_REFERENCE",
    category: useSite === "policy" ? "policy" : "resolution",
    message,
    ...(span !== undefined ? { span } : {}),
  };
  if (severity === "error") {
    ctx.errors.push(validationError);
  } else {
    ctx.warnings.push(validationError);
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
