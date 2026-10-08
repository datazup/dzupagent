/**
 * v2-pipeline-retry.ts — lower V2 `retry:` onto `PipelineRuntime` nodes
 * (DZA-DSL-V2-EXECUTOR-S5-20261008-R2).
 *
 * Only the opt-in `pipeline` target admits a retry binding, and only on an
 * unguarded top-level step with deterministic backoff. The lowered policy
 * reproduces the local-host oracle (`host-step.ts`): `maxAttempts` total
 * attempts, exact-code matching, and `fixed` / `exponential` delays capped at
 * `maxMs`. `jitter: "full"` draws from the oracle's digest seed, which the
 * runtime cannot reproduce, so it stays refused.
 *
 * @module compile-orchestrator/v2-pipeline-retry
 */

import type { DslV2RetryPolicyBinding } from "@dzupagent/flow-dsl";
import type { NodeRetryPolicy } from "@dzupagent/runtime-contracts/pipeline-artifact";

const TOP_LEVEL_STEP = /^root\.steps\[(\d+)\]$/;

/** Why a binding cannot lower onto `pipeline`, or `undefined` when it can. */
export function pipelineRetryRefusal(
  binding: DslV2RetryPolicyBinding,
): string | undefined {
  if (binding.retry.backoff?.jitter === "full") {
    return 'full jitter draws from the local-host seed, which PipelineRuntime cannot reproduce; use jitter "none"';
  }
  if (!isTopLevelStep(binding.authoredPath)) {
    return "retry is admitted only on top-level steps";
  }
  return undefined;
}

/** The runtime retry fields equivalent to one V2 retry contract. */
export function lowerPipelineRetry(binding: DslV2RetryPolicyBinding): {
  readonly retries: number;
  readonly retryPolicy: NodeRetryPolicy;
} {
  const { backoff, match, maxAttempts } = binding.retry;
  return {
    retries: maxAttempts - 1,
    retryPolicy: {
      retryableErrorCodes: [...match],
      initialBackoffMs: backoff?.initialMs ?? 0,
      maxBackoffMs: backoff?.maxMs ?? 0,
      multiplier: backoff?.strategy === "exponential" ? 2 : 1,
      jitter: false,
    },
  };
}

/** Whether an authored path names a top-level step (`root.steps[N]`). */
export function isTopLevelStep(authoredPath: string): boolean {
  return TOP_LEVEL_STEP.test(authoredPath);
}

interface LoweredNode {
  source?: { path?: string; nodeType?: string };
}

/**
 * The single lowered node that carries a top-level primitive step, or
 * `undefined` when there is none or more than one (e.g. a guarded step,
 * which lowers to a branch).
 */
export function topLevelStepNode(
  artifact: unknown,
  binding: { readonly authoredPath: string; readonly primitiveRef: string },
): Record<string, unknown> | undefined {
  const nodes = (artifact as { nodes?: LoweredNode[] }).nodes ?? [];
  const index = TOP_LEVEL_STEP.exec(binding.authoredPath)?.[1];
  if (index === undefined) return undefined;
  const nodeType = loweredNodeType(binding.primitiveRef);
  const targets = nodes.filter(
    (node) =>
      node.source?.path === `root.nodes[${index}]` &&
      node.source.nodeType === nodeType,
  );
  return targets.length === 1
    ? (targets[0] as Record<string, unknown>)
    : undefined;
}

/**
 * Attach the admitted retry bindings to the lowered artifact in place.
 * Returns the authored paths whose step has no single primitive node to carry
 * the policy, so the caller fails closed instead of dropping the retry.
 */
export function applyPipelineRetries(
  artifact: unknown,
  bindings: readonly DslV2RetryPolicyBinding[],
): string[] {
  const unmapped: string[] = [];
  for (const binding of bindings) {
    const target = topLevelStepNode(artifact, binding);
    if (target === undefined) {
      unmapped.push(binding.authoredPath);
      continue;
    }
    Object.assign(target, lowerPipelineRetry(binding));
  }
  return unmapped;
}

/**
 * The source node type a primitive step lowers to: its kind
 * (`primitive://adapter.run@1` -> `adapter.run`), except `agent.run`, which
 * flow-dsl lowers to a V1 `action`.
 */
function loweredNodeType(ref: string): string {
  const kind = ref.replace(/^primitive:\/\//, "").replace(/@[^@]*$/, "");
  return kind === "agent.run" ? "action" : kind;
}
