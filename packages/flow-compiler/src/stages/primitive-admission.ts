import type {
  FlowDataClassification,
  FlowNode,
  ValidationErrorCode,
} from "@dzupagent/flow-ast";
import type {
  FlowTemplateForm,
  ParsedFlowReference,
} from "@dzupagent/flow-ast/expressions";
import { primitiveKind } from "@dzupagent/flow-dsl";

import type { CompilationSourceSpan } from "../types.js";
import { resolveReferenceValueType } from "./reference-contracts.js";
import { classificationForReference } from "./reference-classifications.js";
import type { WalkContext } from "./semantic-context.js";
import { resolveBuiltInPrimitiveDefinition } from "./primitive-reference-ports.js";

const CLASSIFICATION_ORDER: Record<FlowDataClassification, number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
  secret: 3,
};

export interface PrimitiveAdmissionResult {
  readonly authorizedCredentialHandle: boolean;
}

/**
 * Enforce the resolved V2 primitive input contract for one reference.
 *
 * Credential handles are opaque values: a primitive must explicitly allow the
 * exact input path, and the handle must remain an unfiltered whole value.
 */
export function validatePrimitiveReferenceAdmission(
  node: FlowNode,
  nodePath: string,
  sitePath: string,
  reference: ParsedFlowReference,
  form: FlowTemplateForm,
  span: CompilationSourceSpan | undefined,
  ctx: WalkContext,
): PrimitiveAdmissionResult {
  const definition = resolveBuiltInPrimitiveDefinition(node.type);
  if (definition === undefined) {
    return { authorizedCredentialHandle: false };
  }

  const valueType = resolveReferenceValueType(reference, {
    ...(ctx.referenceTypeBindings !== undefined
      ? { typeBindings: ctx.referenceTypeBindings }
      : {}),
    ...(ctx.referencePortBindings !== undefined
      ? { portBindings: ctx.referencePortBindings }
      : {}),
  });
  const classification = classificationForReference(
    reference,
    ctx.referenceClassificationBindings,
    ctx.referencePortClassificationBindings,
  );
  const inputPath = relativeInputPath(nodePath, sitePath);

  if (valueType === "credential") {
    let authorized = true;
    if (form !== "whole-value") {
      authorized = false;
      pushPolicyDiagnostic(
        node,
        sitePath,
        "CREDENTIAL_HANDLE_INTERPOLATION",
        `credential handle "${reference.source}" must be passed as an opaque whole value, never interpolated into text`,
        span,
        ctx,
      );
    }
    if (reference.filters.length > 0) {
      authorized = false;
      pushPolicyDiagnostic(
        node,
        sitePath,
        "CREDENTIAL_HANDLE_TRANSFORM_FORBIDDEN",
        `credential handle "${reference.source}" cannot use filters or transforms`,
        span,
        ctx,
      );
    }
    if (
      definition.credentialInputs === "forbidden" ||
      !definition.credentialInputPaths.some((pattern) =>
        matchesInputPath(pattern, inputPath),
      )
    ) {
      authorized = false;
      pushPolicyDiagnostic(
        node,
        sitePath,
        "CREDENTIAL_HANDLE_NOT_ALLOWED",
        `primitive "${primitiveKind(definition)}@${definition.version}" does not accept a credential handle at input path "${inputPath}"`,
        span,
        ctx,
      );
    }
    return { authorizedCredentialHandle: authorized };
  }

  if (
    classification !== undefined &&
    !definition.acceptedInputClassifications.includes(classification)
  ) {
    pushPolicyDiagnostic(
      node,
      sitePath,
      "PRIMITIVE_INPUT_CLASSIFICATION_DENIED",
      `primitive "${primitiveKind(definition)}@${definition.version}" does not accept ${classification} data at "${inputPath}"`,
      span,
      ctx,
    );
  }

  if (
    classification !== undefined &&
    definition.redactionRequiredAbove !== undefined &&
    isAbove(classification, definition.redactionRequiredAbove) &&
    !satisfiesRedactionObligation(node)
  ) {
    pushPolicyDiagnostic(
      node,
      sitePath,
      "PRIMITIVE_REDACTION_REQUIRED",
      `primitive "${primitiveKind(definition)}@${definition.version}" requires reviewed redaction above ${definition.redactionRequiredAbove}`,
      span,
      ctx,
    );
  }

  return { authorizedCredentialHandle: false };
}

function relativeInputPath(nodePath: string, sitePath: string): string {
  const prefix = `${nodePath}.`;
  return sitePath.startsWith(prefix) ? sitePath.slice(prefix.length) : sitePath;
}

function matchesInputPath(pattern: string, actual: string): boolean {
  const expectedSegments = pattern.split(".");
  const actualSegments = actual.split(".");
  if (expectedSegments.length !== actualSegments.length) return false;
  return expectedSegments.every(
    (segment, index) =>
      segment === "*" || segment === actualSegments[index],
  );
}

function isAbove(
  classification: FlowDataClassification,
  threshold: FlowDataClassification,
): boolean {
  return CLASSIFICATION_ORDER[classification] > CLASSIFICATION_ORDER[threshold];
}

function satisfiesRedactionObligation(node: FlowNode): boolean {
  return node.type === "evidence.write" && node.redact === true;
}

function pushPolicyDiagnostic(
  node: FlowNode,
  nodePath: string,
  code: ValidationErrorCode,
  message: string,
  span: CompilationSourceSpan | undefined,
  ctx: WalkContext,
): void {
  const diagnostic = {
    nodeType: node.type,
    nodePath,
    code,
    category: "policy" as const,
    message,
    ...(span !== undefined ? { span } : {}),
  };
  if (ctx.referencePolicy === "strict") {
    ctx.errors.push(diagnostic);
  } else {
    ctx.warnings.push(diagnostic);
  }
}
