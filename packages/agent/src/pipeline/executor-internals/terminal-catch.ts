/**
 * Exact-code terminal catch for a node's final failure.
 *
 * The persisted shape is `PipelineNodeBase.terminalCatch` in
 * `@dzupagent/runtime-contracts/pipeline-artifact`, read here through the
 * typed `PipelineNode` so contract drift fails the typecheck. The runtime
 * guards stay: a persisted definition is still untrusted JSON.
 *
 * @module pipeline/executor-internals/terminal-catch
 */

import type { PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type { NodeResult } from "../pipeline-runtime-types.js";

export type TerminalCatchOutcome =
  | { action: "continue" | "complete" }
  | { action: "fail"; failureCode: string };

/**
 * The clause outcome for a failed node result, or `undefined` when the node
 * declares no catch, the result carries no string `errorMetadata.code`, or no
 * clause lists that code exactly.
 */
export function matchTerminalCatch(
  node: Pick<PipelineNode, "terminalCatch">,
  result: NodeResult,
): TerminalCatchOutcome | undefined {
  const policy = node.terminalCatch;
  if (policy === undefined || !Array.isArray(policy.clauses)) return undefined;
  const code = result.errorMetadata?.["code"];
  if (typeof code !== "string") return undefined;

  const clause = policy.clauses.find((item) =>
    item.errorCodes.includes(code),
  );
  if (clause === undefined) return undefined;
  if (clause.action === "continue" || clause.action === "complete") {
    return { action: clause.action };
  }
  if (clause.action === "fail" && typeof clause.failureCode === "string") {
    return { action: "fail", failureCode: clause.failureCode };
  }
  return undefined;
}
