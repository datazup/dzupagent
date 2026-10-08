/**
 * v2-pipeline-catch.ts — lower V2 `catch:` onto `PipelineRuntime` nodes
 * (DZA-DSL-V2-EXECUTOR-S5-20261008-C2).
 *
 * Only the opt-in `pipeline` target admits a catch binding, and only on an
 * unguarded top-level step: loop, for-each and fork body executors do not
 * consult `terminalCatch`. Each authored clause becomes one exact-code
 * `terminalCatch` clause, matching the local-host oracle (`host-step.ts`):
 * `continue` goes on, `complete` ends the run completed, and `fail` fails it
 * with the authored code.
 *
 * @module compile-orchestrator/v2-pipeline-catch
 */

import type { DslV2TerminalCatchBinding } from "@dzupagent/flow-dsl";
import type { NodeTerminalCatchPolicy } from "@dzupagent/runtime-contracts/pipeline-artifact";

import { isTopLevelStep, topLevelStepNode } from "./v2-pipeline-retry.js";

/** Why a binding cannot lower onto `pipeline`, or `undefined` when it can. */
export function pipelineCatchRefusal(
  binding: DslV2TerminalCatchBinding,
): string | undefined {
  return isTopLevelStep(binding.authoredPath)
    ? undefined
    : "catch is admitted only on top-level steps";
}

/** The runtime terminal catch equivalent to one V2 catch contract. */
export function lowerPipelineCatch(
  binding: DslV2TerminalCatchBinding,
): NodeTerminalCatchPolicy {
  return {
    clauses: binding.catch.clauses.map((clause) => {
      const errorCodes = clause.matches.map((match) => match.errorCode);
      return clause.outcome.action === "fail"
        ? { errorCodes, action: "fail", failureCode: clause.outcome.code }
        : { errorCodes, action: clause.outcome.action };
    }),
  };
}

/**
 * Attach the admitted catch bindings to the lowered artifact in place.
 * Returns the authored paths whose step has no single primitive node to carry
 * the catch, so the caller fails closed instead of dropping it.
 */
export function applyPipelineCatches(
  artifact: unknown,
  bindings: readonly DslV2TerminalCatchBinding[],
): string[] {
  const unmapped: string[] = [];
  for (const binding of bindings) {
    const target = topLevelStepNode(artifact, binding);
    if (target === undefined) {
      unmapped.push(binding.authoredPath);
      continue;
    }
    target.terminalCatch = lowerPipelineCatch(binding);
  }
  return unmapped;
}
