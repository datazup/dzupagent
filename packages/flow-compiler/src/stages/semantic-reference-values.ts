import type { FlowNode } from "@dzupagent/flow-ast";
import {
  analyzeFlowTemplateReferences,
  parseFlowReferenceExpression,
  type FlowReferenceUseSite,
  type ParsedFlowReference,
} from "@dzupagent/flow-ast/expressions";

import type { WalkContext } from "./semantic-context.js";
import {
  nodeFieldSpan,
  type SemanticDiagnostic,
  type SemanticRelativeQuickFix,
} from "./semantic-diagnostic.js";
import { analyzeReferenceContract } from "./reference-contracts.js";
import { classificationForReference } from "./reference-classifications.js";
import { validatePrimitiveReferenceAdmission } from "./primitive-admission.js";
import { canonicalReferenceRootFixes } from "./reference-quick-fixes.js";

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

export type FlowClassificationSink =
  | "provider-prompt"
  | "tool-input"
  | "command"
  | "event-log"
  | "evidence"
  | "persistence"
  | "artifact"
  | "human-prompt";

export interface NodeTemplateReferenceSite {
  readonly source: string;
  readonly path: string;
  readonly useSite: FlowReferenceUseSite;
  readonly syntax: "template" | "state-key";
  readonly classificationSink?: FlowClassificationSink;
}

interface CollectTemplateOptions {
  readonly stateKey?: boolean;
  readonly classificationSink?: FlowClassificationSink;
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
    validateTemplateSource(node, path, site, ctx);
  }
}

/** Collect executable reference-bearing strings without analyzing child nodes. */
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
      {
        stateKey: isDirectStateKeyField(node, field),
        classificationSink: classificationSinkForField(node, field),
      },
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
    collectTemplateValues(nested, `${path}.${field}`, "policy", sites, {});
  }
}

function collectTemplateValues(
  value: unknown,
  path: string,
  useSite: FlowReferenceUseSite,
  sites: NodeTemplateReferenceSite[],
  options: CollectTemplateOptions,
): void {
  if (typeof value === "string") {
    const hasTemplate = value.includes("{{") || value.includes("}}");
    if (!hasTemplate && !options.stateKey) return;
    sites.push({
      source: value,
      path,
      useSite,
      syntax: hasTemplate ? "template" : "state-key",
      ...(options.classificationSink !== undefined
        ? { classificationSink: options.classificationSink }
        : {}),
    });
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectTemplateValues(
        value[index],
        `${path}[${index}]`,
        useSite,
        sites,
        options,
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
      options,
    );
  }
}

function validateTemplateSource(
  node: FlowNode,
  nodePath: string,
  site: NodeTemplateReferenceSite,
  ctx: WalkContext,
): void {
  if (site.syntax === "state-key") {
    validateDirectStateKeyFlow(node, nodePath, site, ctx);
    return;
  }
  const analysis = analyzeFlowTemplateReferences(site.source, {
    policy: ctx.referencePolicy,
    useSite: site.useSite,
    sourcePath: site.path,
    ...(ctx.referenceBindings !== undefined
      ? { knownBindings: ctx.referenceBindings }
      : {}),
  });

  for (const diagnostic of analysis.diagnostics) {
    const fixes = canonicalReferenceRootFixes(
      diagnostic,
      analysis.references,
      ctx.referenceBindings,
    );
    pushDiagnostic(
      node,
      diagnostic.severity,
      diagnostic.sourcePath ?? site.path,
      site.useSite,
      `[${diagnostic.code}] ${diagnostic.message}`,
      ctx,
      nodeFieldSpan(diagnostic.start, diagnostic.end),
      fixes,
    );
  }

  for (const reference of analysis.references) {
    const span = nodeFieldSpan(reference.start, reference.end);
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
        span,
      );
    }
    const admission = validatePrimitiveReferenceAdmission(
      node,
      nodePath,
      site.path,
      reference,
      analysis.form,
      span,
      ctx,
    );
    if (
      !admission.authorizedCredentialHandle &&
      !admission.authorizedClassifiedInput
    ) {
      validateClassifiedFlow(node, site, reference, span, ctx);
    }
  }
}

function validateClassifiedFlow(
  node: FlowNode,
  site: NodeTemplateReferenceSite,
  reference: ParsedFlowReference,
  span: SemanticDiagnostic["span"],
  ctx: WalkContext,
): void {
  if (site.classificationSink === undefined) return;
  const classification = classificationForReference(
    reference,
    ctx.referenceClassificationBindings,
    ctx.referencePortClassificationBindings,
  );
  pushUnsafeDataFlow(node, site, classification, reference.source, span, ctx);
}

function validateDirectStateKeyFlow(
  node: FlowNode,
  nodePath: string,
  site: NodeTemplateReferenceSite,
  ctx: WalkContext,
): void {
  const parsed = parseFlowReferenceExpression(
    `{{ state.${site.source} }}`,
  ).reference;
  if (parsed !== undefined) {
    const span = nodeFieldSpan(0, site.source.length);
    const admission = validatePrimitiveReferenceAdmission(
      node,
      nodePath,
      site.path,
      parsed,
      "whole-value",
      span,
      ctx,
    );
    if (
      admission.authorizedCredentialHandle ||
      admission.authorizedClassifiedInput
    ) return;
  }
  pushUnsafeDataFlow(
    node,
    site,
    ctx.referenceClassificationBindings?.["state"]?.[site.source],
    `state.${site.source}`,
    nodeFieldSpan(0, site.source.length),
    ctx,
  );
}

function pushUnsafeDataFlow(
  node: FlowNode,
  site: NodeTemplateReferenceSite,
  classification: "public" | "internal" | "sensitive" | "secret" | undefined,
  referenceSource: string,
  span: SemanticDiagnostic["span"],
  ctx: WalkContext,
): void {
  if (site.classificationSink === undefined) return;
  if (classification !== "sensitive" && classification !== "secret") return;
  if (
    site.classificationSink === "evidence" &&
    node.type === "evidence.write" &&
    node.redact === true
  ) {
    return;
  }

  const sink = site.classificationSink.replaceAll("-", " ");
  const detailCode = `${classification.toUpperCase()}_TO_${site.classificationSink
    .replaceAll("-", "_")
    .toUpperCase()}`;
  const diagnostic: SemanticDiagnostic = {
    nodeType: node.type,
    nodePath: site.path,
    code: "UNSAFE_DATA_FLOW",
    category: "policy",
    message:
      `[${detailCode}] ${classification} reference "${referenceSource}" ` +
      `cannot flow to ${sink} at "${site.path}" without an explicit reviewed ` +
      "redaction/declassification contract.",
    ...(span !== undefined ? { span } : {}),
  };
  if (ctx.referencePolicy === "strict") {
    ctx.errors.push(diagnostic);
  } else {
    ctx.warnings.push(diagnostic);
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
  fixes?: readonly SemanticRelativeQuickFix[],
): void {
  const validationError: SemanticDiagnostic = {
    nodeType: node.type,
    nodePath: path,
    code: "INVALID_REFERENCE",
    category: useSite === "policy" ? "policy" : "resolution",
    message,
    ...(span !== undefined ? { span } : {}),
    ...(fixes !== undefined && fixes.length > 0 ? { fixes } : {}),
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

function isDirectStateKeyField(node: FlowNode, field: string): boolean {
  return node.type === "evidence.write" && field === "source";
}

function classificationSinkForField(
  node: FlowNode,
  field: string,
): FlowClassificationSink | undefined {
  switch (node.type) {
    case "prompt":
      return field === "userPrompt" || field === "systemPrompt"
        ? "provider-prompt"
        : undefined;
    case "agent":
      return field === "instructions" || field === "input"
        ? "provider-prompt"
        : undefined;
    case "worker.dispatch":
      return field === "systemPrompt" ||
        field === "instructions" ||
        field === "input"
        ? "provider-prompt"
        : undefined;
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
      return field === "systemPrompt" ||
        field === "instructions" ||
        field === "input"
        ? "provider-prompt"
        : undefined;
    case "adapter.supervisor":
      return field === "systemPrompt" ||
        field === "goal" ||
        field === "input"
        ? "provider-prompt"
        : undefined;
    case "classify":
      return field === "prompt" ? "provider-prompt" : undefined;
    case "fleet.dispatch":
    case "fleet.contract-net":
      return field === "task" || field === "repos"
        ? "provider-prompt"
        : undefined;
    case "action":
      return field === "input" ? "tool-input" : undefined;
    case "shell.run":
      return field === "command" || field === "cwd"
        ? "command"
        : undefined;
    case "emit":
      return field === "payload" ? "event-log" : undefined;
    case "memory":
      return node.operation === "write" && field === "valueExpr"
        ? "persistence"
        : undefined;
    case "knowledge.write":
      return field === "entry" ? "persistence" : undefined;
    case "evidence.write":
      return field === "source" ? "evidence" : undefined;
    case "complete":
      return field === "result" ? "artifact" : undefined;
    case "approval":
    case "clarification":
      return field === "question" ? "human-prompt" : undefined;
    default:
      return undefined;
  }
}

function useSiteForField(field: string): FlowReferenceUseSite {
  return POLICY_FIELDS.has(field) ? "policy" : "value-interpolation";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
