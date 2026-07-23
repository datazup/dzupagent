import type {
  FlowReferenceFilter,
  FlowTemplateForm,
  ParsedFlowReference,
} from "@dzupagent/flow-ast/expressions";

import type {
  FlowReferencePortBindings,
  FlowReferenceTypeBindings,
  FlowReferenceValueType,
} from "../types.js";

export type ReferenceContractIssueCode =
  | "MISSING_REFERENCE_PORT"
  | "REFERENCE_TYPE_MISMATCH";

export interface ReferenceContractIssue {
  readonly code: ReferenceContractIssueCode;
  readonly message: string;
}

export interface ReferenceContractOptions {
  readonly typeBindings?: FlowReferenceTypeBindings;
  readonly portBindings?: FlowReferencePortBindings;
}

/**
 * Validate contracts that need more than the root/name declaration table:
 * canonical step ports, scalar traversal, filter input types, and
 * scalar-compatible interpolation.
 */
export function analyzeReferenceContract(
  reference: ParsedFlowReference,
  form: FlowTemplateForm,
  options: ReferenceContractOptions,
): ReferenceContractIssue[] {
  const issues: ReferenceContractIssue[] = [];
  const type = resolveReferenceValueType(reference, options, issues);
  const filteredType = applyFilterTypes(reference.filters, type, issues);

  if (
    form === "interpolation" &&
    (filteredType === "object" || filteredType === "array")
  ) {
    issues.push({
      code: "REFERENCE_TYPE_MISMATCH",
      message:
        `reference "${reference.source}" resolves to ${filteredType}, but text interpolation requires a scalar-compatible value; ` +
        "use a whole-value reference or an explicit runtime-supported transformer",
    });
  }

  return issues;
}

export function resolveReferenceValueType(
  reference: ParsedFlowReference,
  options: ReferenceContractOptions,
  issues: ReferenceContractIssue[] = [],
): FlowReferenceValueType {
  const first = reference.segments[0];
  if (first?.kind !== "property") return "unknown";

  if (reference.root === "steps") {
    return resolveStepPortType(reference, first.key, options.portBindings, issues);
  }

  let type = options.typeBindings?.[reference.root]?.[first.key] ?? "unknown";
  for (const segment of reference.segments.slice(1)) {
    type = traverseType(reference, segment.kind, type, issues);
  }
  return type;
}

function resolveStepPortType(
  reference: ParsedFlowReference,
  stepId: string,
  portBindings: FlowReferencePortBindings | undefined,
  issues: ReferenceContractIssue[],
): FlowReferenceValueType {
  if (portBindings === undefined) return "unknown";

  const port = reference.segments[1];
  if (port?.kind !== "property") {
    issues.push({
      code: "MISSING_REFERENCE_PORT",
      message:
        `step reference "${reference.source}" must name a declared output port as steps.${stepId}.<port>`,
    });
    return "unknown";
  }

  const ports = portBindings[stepId];
  if (ports === undefined || !Object.prototype.hasOwnProperty.call(ports, port.key)) {
    const available = Object.keys(ports ?? {}).sort();
    issues.push({
      code: "MISSING_REFERENCE_PORT",
      message:
        `step output port "${stepId}.${port.key}" is not declared` +
        (available.length > 0
          ? `; available ports: ${available.join(", ")}`
          : "; this step has no canonical port contract"),
    });
    return "unknown";
  }

  let type = ports[port.key] ?? "unknown";
  for (const segment of reference.segments.slice(2)) {
    type = traverseType(reference, segment.kind, type, issues);
  }
  return type;
}

function traverseType(
  reference: ParsedFlowReference,
  segmentKind: "property" | "index",
  current: FlowReferenceValueType,
  issues: ReferenceContractIssue[],
): FlowReferenceValueType {
  if (current === "unknown" || current === "any") return current;
  if (current === "object") {
    if (segmentKind === "index") {
      issues.push({
        code: "REFERENCE_TYPE_MISMATCH",
        message: `reference "${reference.source}" indexes an object as an array`,
      });
    }
    return "unknown";
  }
  if (current === "array") {
    if (segmentKind === "property") {
      issues.push({
        code: "REFERENCE_TYPE_MISMATCH",
        message: `reference "${reference.source}" reads a named property from an array`,
      });
    }
    return "unknown";
  }

  issues.push({
    code: "REFERENCE_TYPE_MISMATCH",
    message: `reference "${reference.source}" traverses through scalar type ${current}`,
  });
  return "unknown";
}

function applyFilterTypes(
  filters: readonly FlowReferenceFilter[],
  initial: FlowReferenceValueType,
  issues: ReferenceContractIssue[],
): FlowReferenceValueType {
  let type = initial;
  for (const filter of filters) {
    switch (filter.name) {
      case "json":
        type = "string";
        break;
      case "length":
        if (!isUnknown(type) && type !== "string" && type !== "array" && type !== "object") {
          issues.push({
            code: "REFERENCE_TYPE_MISMATCH",
            message: `filter "length" cannot consume ${type}`,
          });
        }
        type = "number";
        break;
      case "upper":
      case "lower":
        if (!isUnknown(type) && type !== "string") {
          issues.push({
            code: "REFERENCE_TYPE_MISMATCH",
            message: `filter "${filter.name}" cannot consume ${type}`,
          });
        }
        type = "string";
        break;
      case "default":
        break;
      default:
        break;
    }
  }
  return type;
}

function isUnknown(type: FlowReferenceValueType): boolean {
  return type === "unknown" || type === "any";
}
