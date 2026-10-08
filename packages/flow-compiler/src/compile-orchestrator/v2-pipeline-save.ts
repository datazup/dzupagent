/**
 * v2-pipeline-save.ts — lower V2 multi-port `save:` onto `PipelineRuntime`
 * nodes (DZA-DSL-V2-EXECUTOR-S5-20261008-S2).
 *
 * Only the opt-in `pipeline` target admits a multi-port save, and only on an
 * unguarded top-level step: loop, for-each and fork body executors do not
 * consult `stateWrites`. Each authored binding becomes one exact-port state
 * write, matching the local-host oracle (`host-step.ts`): written together on
 * success, a missing optional port skipped, nothing written on failure.
 *
 * Ports classified `secret` stay refused because pipeline state is persisted
 * to checkpoints. Value schemas are not carried; the handler owns them.
 *
 * @module compile-orchestrator/v2-pipeline-save
 */

import type { DslV2MultiPortSaveBinding } from "@dzupagent/flow-dsl";
import type { NodeStateWritePolicy } from "@dzupagent/runtime-contracts/pipeline-artifact";

import { isTopLevelStep, topLevelStepNode } from "./v2-pipeline-retry.js";

/** Why a binding cannot lower onto `pipeline`, or `undefined` when it can. */
export function pipelineSaveRefusal(
  binding: DslV2MultiPortSaveBinding,
): string | undefined {
  if (!isTopLevelStep(binding.authoredPath)) {
    return "multi-port save is admitted only on top-level steps";
  }
  const restricted = binding.save.bindings.find(
    (item) => item.source.classification === "secret",
  );
  if (restricted !== undefined) {
    return `port "${restricted.port}" is classified secret and pipeline state is checkpointed`;
  }
  return undefined;
}

/** The runtime state writes equivalent to one V2 multi-port save. */
export function lowerPipelineSave(
  binding: DslV2MultiPortSaveBinding,
): NodeStateWritePolicy {
  return {
    bindings: binding.save.bindings.map((item) => ({
      port: item.port,
      key: item.destination.key,
      cardinality: item.source.cardinality,
    })),
  };
}

/**
 * Attach the admitted save bindings to the lowered artifact in place.
 * Returns the authored paths whose step has no single primitive node to carry
 * the save, so the caller fails closed instead of dropping it.
 */
export function applyPipelineSaves(
  artifact: unknown,
  bindings: readonly DslV2MultiPortSaveBinding[],
): string[] {
  const unmapped: string[] = [];
  for (const binding of bindings) {
    const target = topLevelStepNode(artifact, binding);
    if (target === undefined) {
      unmapped.push(binding.authoredPath);
      continue;
    }
    target.stateWrites = lowerPipelineSave(binding);
  }
  return unmapped;
}
