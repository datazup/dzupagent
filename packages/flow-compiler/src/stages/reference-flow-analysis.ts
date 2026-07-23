import type { FlowNode } from "@dzupagent/flow-ast";
import {
  analyzeFlowTemplateReferences,
  type FlowReferenceBindings,
  type FlowReferencePolicy,
  type ParsedFlowReference,
} from "@dzupagent/flow-ast/expressions";

import type {
  FlowReferencePortBindings,
  FlowReferenceTypeBindings,
} from "../types.js";
import {
  analyzeReferenceContract,
  resolveReferenceValueType,
} from "./reference-contracts.js";
import {
  addAvailable,
  addNodeStateOutputs,
  availabilityFromBindings,
  cloneAvailability,
  intersectAvailability,
  unionAvailability,
  type ReferenceAvailability,
} from "./reference-flow-analysis/availability.js";
import { scanControlReferences } from "./reference-flow-analysis/control-references.js";
import { collectNodeTemplateReferenceSites } from "./semantic-reference-values.js";
import {
  nodeFieldSpan,
  type SemanticDiagnostic,
} from "./semantic-diagnostic.js";

export interface ReferenceFlowAnalysisOptions {
  readonly policy: FlowReferencePolicy;
  readonly declarationBindings?: FlowReferenceBindings;
  readonly initialBindings?: FlowReferenceBindings;
  readonly typeBindings?: FlowReferenceTypeBindings;
  readonly portBindings?: FlowReferencePortBindings;
}

export interface ReferenceFlowAnalysisResult {
  readonly errors: SemanticDiagnostic[];
  readonly warnings: SemanticDiagnostic[];
}

/**
 * Deterministic, declaration-level control-flow analysis for strict v1
 * references. It proves first-segment availability; it does not evaluate
 * values, providers, or runtime conditions.
 */
export function analyzeReferenceFlow(
  root: FlowNode,
  options: ReferenceFlowAnalysisOptions,
): ReferenceFlowAnalysisResult {
  const errors: SemanticDiagnostic[] = [];
  const warnings: SemanticDiagnostic[] = [];
  visitNode(
    root,
    "root",
    availabilityFromBindings(options.initialBindings),
    options,
    errors,
    warnings,
  );
  return { errors, warnings };
}

function visitNode(
  node: FlowNode,
  path: string,
  incoming: ReferenceAvailability,
  options: ReferenceFlowAnalysisOptions,
  errors: SemanticDiagnostic[],
  warnings: SemanticDiagnostic[],
): ReferenceAvailability {
  analyzeNodeReferences(node, path, incoming, options, errors, warnings);

  let outgoing: ReferenceAvailability;
  switch (node.type) {
    case "sequence":
      outgoing = visitNodes(
        node.nodes,
        `${path}.nodes`,
        incoming,
        options,
        errors,
        warnings,
      );
      break;
    case "branch": {
      const thenResult = visitNodes(
        node.then,
        `${path}.then`,
        incoming,
        options,
        errors,
        warnings,
      );
      const elseResult =
        node.else === undefined
          ? cloneAvailability(incoming)
          : visitNodes(
              node.else,
              `${path}.else`,
              incoming,
              options,
              errors,
              warnings,
            );
      outgoing = intersectAvailability(thenResult, elseResult);
      break;
    }
    case "parallel": {
      const branches = node.branches.map((branch, branchIndex) =>
        visitNodes(
          branch,
          `${path}.branches[${branchIndex}]`,
          incoming,
          options,
          errors,
          warnings,
        ),
      );
      outgoing = unionAvailability(incoming, ...branches);
      break;
    }
    case "approval": {
      const approved = visitNodes(
        node.onApprove,
        `${path}.onApprove`,
        incoming,
        options,
        errors,
        warnings,
      );
      const rejected =
        node.onReject === undefined
          ? cloneAvailability(incoming)
          : visitNodes(
              node.onReject,
              `${path}.onReject`,
              incoming,
              options,
              errors,
              warnings,
            );
      outgoing = intersectAvailability(approved, rejected);
      break;
    }
    case "try_catch": {
      const body = visitNodes(
        node.body,
        `${path}.body`,
        incoming,
        options,
        errors,
        warnings,
      );
      const catchIncoming = cloneAvailability(incoming);
      addAvailable(catchIncoming, "state", node.errorVar ?? "error");
      const caught = visitNodes(
        node.catch,
        `${path}.catch`,
        catchIncoming,
        options,
        errors,
        warnings,
      );
      outgoing = intersectAvailability(body, caught);
      break;
    }
    case "for_each": {
      const bodyIncoming = cloneAvailability(incoming);
      addAvailable(bodyIncoming, "state", node.as);
      addAvailable(bodyIncoming, "loop", "item");
      addAvailable(bodyIncoming, "loop", "index");
      visitNodes(
        node.body,
        `${path}.body`,
        bodyIncoming,
        options,
        errors,
        warnings,
      );
      outgoing = cloneAvailability(incoming);
      if (node.collect !== undefined) {
        addAvailable(outgoing, "state", node.collect.into);
      }
      if (node.accumulator !== undefined) {
        addAvailable(outgoing, "state", node.accumulator.key);
      }
      break;
    }
    case "loop": {
      const bodyIncoming = cloneAvailability(incoming);
      addAvailable(bodyIncoming, "loop", "index");
      visitNodes(
        node.body,
        `${path}.body`,
        bodyIncoming,
        options,
        errors,
        warnings,
      );
      // A condition loop can execute zero times, so body writes do not
      // dominate its continuation.
      outgoing = cloneAvailability(incoming);
      break;
    }
    case "persona":
    case "route":
      outgoing = visitNodes(
        node.body,
        `${path}.body`,
        incoming,
        options,
        errors,
        warnings,
      );
      break;
    default:
      outgoing = cloneAvailability(incoming);
      addNodeStateOutputs(node, outgoing);
      break;
  }

  if (node.id !== undefined && node.id.length > 0) {
    addAvailable(outgoing, "steps", node.id);
  }
  return outgoing;
}

function visitNodes(
  nodes: readonly FlowNode[],
  pathPrefix: string,
  incoming: ReferenceAvailability,
  options: ReferenceFlowAnalysisOptions,
  errors: SemanticDiagnostic[],
  warnings: SemanticDiagnostic[],
): ReferenceAvailability {
  let current = cloneAvailability(incoming);
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    current = visitNode(
      node,
      `${pathPrefix}[${index}]`,
      current,
      options,
      errors,
      warnings,
    );
  }
  return current;
}

function analyzeNodeReferences(
  node: FlowNode,
  path: string,
  available: ReferenceAvailability,
  options: ReferenceFlowAnalysisOptions,
  errors: SemanticDiagnostic[],
  warnings: SemanticDiagnostic[],
): void {
  for (const site of collectNodeTemplateReferenceSites(node, path)) {
    const analysis = analyzeFlowTemplateReferences(site.source, {
      policy: options.policy,
      useSite: site.useSite,
      sourcePath: site.path,
      ...(options.declarationBindings !== undefined
        ? { knownBindings: options.declarationBindings }
        : {}),
    });
    for (const reference of analysis.references) {
      validateAvailability(
        node,
        reference,
        site.path,
        available,
        options,
        errors,
        warnings,
      );
    }
  }

  const control = controlReferenceSite(node, path);
  if (control === undefined) return;
  const references = scanControlReferences(control.source, options);
  for (const reference of references) {
    validateAvailability(
      node,
      reference,
      control.path,
      available,
      options,
      errors,
      warnings,
    );
    for (const issue of analyzeReferenceContract(reference, "whole-value", {
      ...(options.typeBindings !== undefined
        ? { typeBindings: options.typeBindings }
        : {}),
      ...(options.portBindings !== undefined
        ? { portBindings: options.portBindings }
        : {}),
    })) {
      pushIssue(
        node,
        control.path,
        issue.code,
        issue.message,
        options.policy,
        errors,
        warnings,
        nodeFieldSpan(reference.start, reference.end),
      );
    }
  }

  if (node.type === "for_each" && references.length === 1) {
    const type = resolveReferenceValueType(references[0]!, {
      ...(options.typeBindings !== undefined
        ? { typeBindings: options.typeBindings }
        : {}),
      ...(options.portBindings !== undefined
        ? { portBindings: options.portBindings }
        : {}),
    });
    if (type !== "unknown" && type !== "any" && type !== "array") {
      pushIssue(
        node,
        control.path,
        "REFERENCE_TYPE_MISMATCH",
        `for_each.source resolves to ${type}, but iteration requires an array`,
        options.policy,
        errors,
        warnings,
        nodeFieldSpan(references[0]!.start, references[0]!.end),
      );
    }
  }
}

function validateAvailability(
  node: FlowNode,
  reference: ParsedFlowReference,
  path: string,
  available: ReferenceAvailability,
  options: ReferenceFlowAnalysisOptions,
  errors: SemanticDiagnostic[],
  warnings: SemanticDiagnostic[],
): void {
  const first = reference.segments[0];
  if (first?.kind !== "property") return;
  const declared = options.declarationBindings?.[reference.root];
  if (declared === undefined || !declared.includes(first.key)) return;
  if (available.get(reference.root)?.has(first.key) === true) return;

  pushIssue(
    node,
    path,
    "REFERENCE_NOT_AVAILABLE",
    `reference "${reference.root}.${first.key}" is declared but is not available on every control-flow path reaching this node`,
    options.policy,
    errors,
    warnings,
    nodeFieldSpan(reference.start, reference.end),
  );
}

function controlReferenceSite(
  node: FlowNode,
  path: string,
): { source: string; path: string } | undefined {
  switch (node.type) {
    case "branch":
    case "loop":
    case "return_to":
      return { source: node.condition, path: `${path}.condition` };
    case "for_each":
      return { source: node.source, path: `${path}.source` };
    default:
      return undefined;
  }
}

function pushIssue(
  node: FlowNode,
  path: string,
  code: string,
  message: string,
  policy: FlowReferencePolicy,
  errors: SemanticDiagnostic[],
  warnings: SemanticDiagnostic[],
  span?: SemanticDiagnostic["span"],
): void {
  const diagnostic: SemanticDiagnostic = {
    nodeType: node.type,
    nodePath: path,
    code: "INVALID_REFERENCE",
    category: "resolution",
    message: `[${code}] ${message}`,
    ...(span !== undefined ? { span } : {}),
  };
  if (policy === "strict") {
    errors.push(diagnostic);
  } else {
    warnings.push(diagnostic);
  }
}
