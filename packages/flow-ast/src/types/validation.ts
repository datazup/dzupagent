import type { FlowDiagnosticCategory } from "./primitives.js";
import type { FlowNode } from "./nodes.js";

// Validation errors produced by Stage 3 semantic validator
export interface ValidationError {
  nodeType: FlowNode["type"];
  nodePath: string; // dot-notation path in the AST, e.g. "root.nodes[2].body[0]"
  code: ValidationErrorCode;
  message: string;
  category?: FlowDiagnosticCategory;
}

export type ValidationErrorCode =
  | "UNRESOLVED_TOOL_REF"
  | "UNRESOLVED_PERSONA_REF"
  | "EMPTY_BODY"
  | "INVALID_CONDITION"
  | "INVALID_ENUM_VALUE"
  | "MISSING_REQUIRED_FIELD"
  | "DUPLICATE_NODE_ID"
  | "RESOLVER_INFRA_ERROR"
  | "UNRESOLVED_TOOLSET_REF"
  | "MISSING_TOOLSET_RESOLVER"
  | "INVALID_TOOLSET_RESOLVER_RESULT"
  | "TOOLSET_RESOLVER_INFRA_ERROR"
  | "UNRESOLVED_PROFILE_REF"
  | "MISSING_PROFILE_REGISTRY"
  | "PROFILE_RESOLVER_INFRA_ERROR"
  | "INVALID_REFERENCE"
  | "UNSAFE_DATA_FLOW"
  | "AMBIGUOUS_LOOP_BODY_OUTPUT"
  | "INVALID_TEMPLATE_FRONTMATTER"
  | "MISSING_REQUIRED_SECTION"
  | "UNKNOWN_FRONTMATTER_KEY"
  | "SPDD_ORDERING_VIOLATION";
