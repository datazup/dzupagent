/**
 * Exact-code terminal catch for a node's final failure.
 *
 * The persisted shape is `PipelineNodeBase.terminalCatch` in
 * `@dzupagent/runtime-contracts/pipeline-artifact`. It is mirrored
 * structurally here, as `RetryPolicy` mirrors `NodeRetryPolicy`, so the
 * runtime does not depend on a contract build that already carries the field.
 *
 * @module pipeline/executor-internals/terminal-catch
 */

import type { NodeResult } from "../pipeline-runtime-types.js";

export type TerminalCatchOutcome =
  | { action: "continue" | "complete" }
  | { action: "fail"; failureCode: string };

interface TerminalCatchClauseLike {
  errorCodes: readonly string[];
  action: string;
  failureCode?: string;
}

/**
 * The clause outcome for a failed node result, or `undefined` when the node
 * declares no catch, the result carries no string `errorMetadata.code`, or no
 * clause lists that code exactly.
 */
export function matchTerminalCatch(
  node: object,
  result: NodeResult,
): TerminalCatchOutcome | undefined {
  const policy = (node as { terminalCatch?: { clauses?: unknown } })
    .terminalCatch;
  if (policy === undefined || !Array.isArray(policy.clauses)) return undefined;
  const code = result.errorMetadata?.["code"];
  if (typeof code !== "string") return undefined;

  const clause = (policy.clauses as TerminalCatchClauseLike[]).find((item) =>
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
