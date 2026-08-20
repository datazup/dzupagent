/**
 * target-admission.ts — Stage 4 gates that ask whether the routed target can
 * represent the AST it was routed for.
 *
 * These run after routing and before lowering. Both are structural invariant
 * checks rather than user-facing validation: an AST reaching either of them has
 * already satisfied stages 1-3, so a violation means the router and the lowerer
 * disagree about what the target admits, not that the author wrote bad input.
 *
 * @module compile-orchestrator/target-admission
 */

import type { FlowNode } from "@dzupagent/flow-ast";

import { collectUnsupportedRuntimeNodes, hasOnError } from "../route-target.js";
import type { CompilationError, CompilationTarget } from "../types.js";

/**
 * Reject runtime leaves the selected target cannot represent.
 *
 * NOTE: unreachable through `runCompile` as the router is written today, and
 * deliberately kept anyway. `routeTarget` sends any flow carrying a runtime
 * leaf to `planning-dag`, which admits all of them; the only way to outrank
 * that bit is a `for_each` or `loop`, and either one makes the `pipeline`
 * target's artifact anchor true. The collector below is exercised directly by
 * `compile-runtime-nodes.test.ts` -- it is this *pipeline branch* that no input
 * currently reaches, so do not write a test that appears to reach it.
 *
 * It stays because the guard's premise is the router's routing rule, not the
 * AST: a new runtime leaf type added to the lowerer's unsupported set without
 * a matching `RUNTIME_LEAF` bit in `computeFeatureBitmask` would route to a
 * target that cannot lower it, and this is what turns that into a diagnostic
 * instead of a malformed artifact.
 */
export function collectUnsupportedRuntimeNodeErrors(
  ast: FlowNode,
  target: CompilationTarget,
): CompilationError[] {
  return collectUnsupportedRuntimeNodes(ast, target).map((node) => ({
    stage: 4 as const,
    code: "UNSUPPORTED_RUNTIME_NODE_FOR_TARGET",
    message:
      `Node type "${node.type}" at "${node.path}" is valid in the AST but cannot be represented by ` +
      `the "${target}" generic compiler target. Use a runtime that executes this node kind or add a ` +
      "reviewed executable target contract before emitting artifacts.",
    nodePath: node.path,
    category: "lowering",
  }));
}

/**
 * Defense-in-depth: a skill-chain-targeted flow must not carry `on_error`.
 *
 * `validateShape` (stage 2) already catches this via OI-4. This backstop fires
 * only for a caller that constructs an AST directly and bypasses stage 2, which
 * is why it is expressed as an invariant here rather than folded into the
 * stage-2 rule.
 */
export function collectSkillChainOnErrorErrors(
  ast: FlowNode,
  target: CompilationTarget,
): CompilationError[] {
  if (target !== "skill-chain" || !hasOnError(ast)) return [];
  return [
    {
      stage: 4,
      code: "UNSUPPORTED_FIELD",
      message: "on_error is only legal in pipeline-targeted flows",
      nodePath: "root",
      category: "lowering",
    },
  ];
}
