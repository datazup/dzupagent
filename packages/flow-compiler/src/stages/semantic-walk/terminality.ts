import {
  checkUnreachableAfterComplete,
  type FlowNode,
  type ValidationError,
} from "@dzupagent/flow-ast";

// ---------------------------------------------------------------------------
// Terminal-continuation validation (DSL-03)
// ---------------------------------------------------------------------------

/**
 * A terminal node must never have a normal continuation. `complete` declares
 * the flow finished; any later sibling in the same child list is unreachable —
 * the lowerer refuses to wire an edge to it, so it silently never runs.
 *
 * Surface that as a hard error for every admission profile. A compiler profile
 * may narrow behavior but must never make structurally dead work executable.
 * The flow-ast pass owns traversal and diagnostic identity so direct semantic
 * callers and the standard compiler pipeline cannot drift apart.
 */
export function validateTerminalContinuations(
  ast: FlowNode,
  errors: ValidationError[]
): void {
  errors.push(
    ...checkUnreachableAfterComplete(ast).map((diagnostic) => ({
      nodeType: diagnostic.unreachableType,
      nodePath: diagnostic.unreachablePath,
      code: diagnostic.code,
      category: "control" as const,
      message: diagnostic.message,
    }))
  );
}
