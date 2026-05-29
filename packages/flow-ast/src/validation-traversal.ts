import type { FlowNode, ValidationErrorCode } from "./types.js";
import { joinPath } from "./validation-helpers.js";

export interface ValidationTraversalIssue {
  path: string;
  code: ValidationErrorCode;
  message: string;
}

export function validateCanonicalNodeIds(
  node: FlowNode,
  path: string,
  issues: ValidationTraversalIssue[],
  seen: Map<string, string>
): void {
  if (typeof node.id !== "string" || node.id.length === 0) {
    issues.push({
      path: joinPath(path, "id"),
      code: "MISSING_REQUIRED_FIELD",
      message: "canonical document nodes must define a non-empty id",
    });
  } else {
    const priorPath = seen.get(node.id);
    if (priorPath !== undefined) {
      issues.push({
        path: joinPath(path, "id"),
        code: "DUPLICATE_NODE_ID",
        message: `duplicate node id "${node.id}" first seen at ${priorPath}`,
      });
    } else {
      seen.set(node.id, path);
    }
  }

  switch (node.type) {
    case "sequence":
      node.nodes.forEach((child, index) => {
        validateCanonicalNodeIds(
          child,
          `${joinPath(path, "nodes")}[${index}]`,
          issues,
          seen
        );
      });
      return;
    case "for_each":
      node.body.forEach((child, index) => {
        validateCanonicalNodeIds(
          child,
          `${joinPath(path, "body")}[${index}]`,
          issues,
          seen
        );
      });
      return;
    case "branch":
      node.then.forEach((child, index) => {
        validateCanonicalNodeIds(
          child,
          `${joinPath(path, "then")}[${index}]`,
          issues,
          seen
        );
      });
      node.else?.forEach((child, index) => {
        validateCanonicalNodeIds(
          child,
          `${joinPath(path, "else")}[${index}]`,
          issues,
          seen
        );
      });
      return;
    case "approval":
      node.onApprove.forEach((child, index) => {
        validateCanonicalNodeIds(
          child,
          `${joinPath(path, "onApprove")}[${index}]`,
          issues,
          seen
        );
      });
      node.onReject?.forEach((child, index) => {
        validateCanonicalNodeIds(
          child,
          `${joinPath(path, "onReject")}[${index}]`,
          issues,
          seen
        );
      });
      return;
    case "persona":
    case "route":
      node.body.forEach((child, index) => {
        validateCanonicalNodeIds(
          child,
          `${joinPath(path, "body")}[${index}]`,
          issues,
          seen
        );
      });
      return;
    case "parallel":
      node.branches.forEach((branch, branchIndex) => {
        branch.forEach((child, childIndex) => {
          validateCanonicalNodeIds(
            child,
            `${joinPath(path, "branches")}[${branchIndex}][${childIndex}]`,
            issues,
            seen
          );
        });
      });
      return;
    case "try_catch":
      node.body.forEach((child, index) => {
        validateCanonicalNodeIds(
          child,
          `${joinPath(path, "body")}[${index}]`,
          issues,
          seen
        );
      });
      node.catch.forEach((child, index) => {
        validateCanonicalNodeIds(
          child,
          `${joinPath(path, "catch")}[${index}]`,
          issues,
          seen
        );
      });
      return;
    case "loop":
      node.body.forEach((child, index) => {
        validateCanonicalNodeIds(
          child,
          `${joinPath(path, "body")}[${index}]`,
          issues,
          seen
        );
      });
      return;
    case "action":
    case "clarification":
    case "complete":
    case "spawn":
    case "classify":
    case "emit":
    case "memory":
    case "set":
    case "checkpoint":
    case "restore":
    case "http":
    case "wait":
    case "subflow":
    case "prompt":
    case "return_to":
    case "agent":
    case "validate":
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "knowledge.write":
    case "knowledge.query":
      return;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
    }
  }
}
