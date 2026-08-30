/**
 * Reference-expression parsing — the INTERNAL support library shared by the
 * expression facilities (expressions analysis, the typed condition
 * evaluator, and the legacy condition validator). Per
 * `packages/flow-ast/EXPRESSIONS.md` it is not exported from the package;
 * consume references through one of the three engines instead.
 */

export * from "./reference-expression/types.js";
export {
  isFlowReferenceValue,
  flowReference,
} from "./reference-expression/value.js";
export { parseFlowReferenceExpression } from "./reference-expression/parser.js";
export { analyzeFlowTemplateReferences } from "./reference-expression/template-analysis.js";
