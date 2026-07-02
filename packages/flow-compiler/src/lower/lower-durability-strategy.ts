/**
 * Stage 4 lowering — document-level durability checkpoint-strategy translation.
 *
 * W1 Slice 2 (checkpoint-vocab reconciliation, Option A). The AST and the
 * runtime disagree on the checkpoint-strategy vocabulary:
 *
 *   AST (FlowDurabilityPolicy.checkpoint.strategy):
 *     explicit | after_each_node | after_each_effect | after_each_branch
 *   Runtime (CheckpointStrategy, @dzupagent/core/pipeline):
 *     after_each_node | on_suspend | manual | none
 *
 * Only `after_each_node` overlaps by name. The runtime executor
 * (`pipeline-executor.ts`) has exactly two behaviors: `after_each_node`
 * checkpoints after every node; everything else (`manual`/`none`/`on_suspend`)
 * takes no per-node checkpoint. The AST's `after_each_effect` and
 * `after_each_branch` therefore have NO runtime execution path — they are
 * missing *semantics*, not missing enum slots.
 *
 * Rather than widen the shared runtime enum with inert values (the
 * declared-but-inert trap Slice 1 closed), this module keeps both enums as-is
 * and translates at lowering time:
 *
 *   after_each_node   → after_each_node   (1:1, real behavior)
 *   explicit          → manual            (author-triggered; runtime skips auto)
 *   after_each_effect → after_each_node   (coarsened — warned)
 *   after_each_branch → after_each_node   (coarsened — warned)
 *
 * `coarsened: true` signals the caller to emit an advisory compile warning so
 * the down-map is honest (warned, not silently pretended). When real
 * per-effect / per-branch checkpointing is implemented (a later slice), the
 * coarsened rows gain true targets with no author-facing change.
 *
 * @module lower/lower-durability-strategy
 */

import type { CheckpointStrategy } from "@dzupagent/core/pipeline";

/** AST-side checkpoint strategy vocabulary (FlowDurabilityPolicy.checkpoint.strategy). */
export type AstCheckpointStrategy =
  | "explicit"
  | "after_each_node"
  | "after_each_effect"
  | "after_each_branch";

export interface CheckpointStrategyTranslation {
  /**
   * Runtime strategy to stamp on the PipelineDefinition, or `undefined` when
   * the AST declared no strategy (⇒ today's behavior, byte-identical).
   */
  strategy: CheckpointStrategy | undefined;
  /**
   * `true` when the AST strategy was down-mapped to a coarser runtime
   * granularity (`after_each_effect` / `after_each_branch` → `after_each_node`).
   * Callers should emit an advisory compile warning when this is set.
   */
  coarsened: boolean;
}

/**
 * Translate a document-level AST checkpoint strategy into the runtime
 * `CheckpointStrategy`, reporting whether the mapping coarsened granularity.
 *
 * Pure and total: an absent strategy yields `{ strategy: undefined,
 * coarsened: false }`, preserving pre-Slice-2 behavior exactly.
 */
export function checkpointStrategyForRuntime(
  astStrategy: AstCheckpointStrategy | undefined
): CheckpointStrategyTranslation {
  switch (astStrategy) {
    case undefined:
      return { strategy: undefined, coarsened: false };
    case "after_each_node":
      return { strategy: "after_each_node", coarsened: false };
    case "explicit":
      return { strategy: "manual", coarsened: false };
    case "after_each_effect":
    case "after_each_branch":
      // Finer-than-node checkpointing has no runtime execution path yet; coarsen
      // to node granularity and flag so the caller warns rather than pretends.
      return { strategy: "after_each_node", coarsened: true };
  }
}
