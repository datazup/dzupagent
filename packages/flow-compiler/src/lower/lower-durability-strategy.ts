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

import type { FlowDurabilityPolicy } from "@dzupagent/flow-ast";
import type {
  CheckpointStrategy,
  PipelineResumePolicy,
} from "@dzupagent/core/pipeline";

import type { CompilationWarning } from "../types.js";

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

// ---------------------------------------------------------------------------
// Policy-level lowering (Gap 2 mode-derive + Gap 3 resume)
// ---------------------------------------------------------------------------

export interface CheckpointLoweringResult {
  /**
   * Runtime checkpoint strategy, or `undefined` when the policy declares neither
   * a `checkpoint.strategy` nor a `mode` — in which case the lowered
   * PipelineDefinition is byte-identical to today (no field set).
   */
  checkpointStrategy?: CheckpointStrategy;
  /** Stage-4 advisory warnings (coarsen notices). Empty for lossless mappings. */
  warnings: CompilationWarning[];
}

/**
 * Lower the whole `FlowDurabilityPolicy` into a runtime `CheckpointStrategy`.
 *
 * Precedence (§5.2): an explicit `checkpoint.strategy` always wins; when absent,
 * derive from the coarse `durability.mode`:
 *
 *   mode 'checkpointed' | 'durable' → after_each_node
 *   mode 'volatile'                 → none
 *   mode absent (and no strategy)   → undefined (no-op, today's behavior)
 *
 * Coarsening of `after_each_effect`/`after_each_branch` re-uses
 * `checkpointStrategyForRuntime` and surfaces the `CHECKPOINT_STRATEGY_COARSENED`
 * warning so the down-map stays honest.
 */
export function checkpointStrategyFromPolicy(
  policy: FlowDurabilityPolicy | undefined
): CheckpointLoweringResult {
  const warnings: CompilationWarning[] = [];
  if (policy === undefined) return { warnings };

  const strategy = policy.checkpoint?.strategy;
  if (strategy !== undefined) {
    const { strategy: runtime, coarsened } =
      checkpointStrategyForRuntime(strategy);
    if (coarsened) warnings.push(coarsenWarning(strategy));
    return runtime !== undefined
      ? { checkpointStrategy: runtime, warnings }
      : { warnings };
  }

  // No explicit strategy — derive from `mode`.
  switch (policy.mode) {
    case "checkpointed":
    case "durable":
      return { checkpointStrategy: "after_each_node", warnings };
    case "volatile":
      return { checkpointStrategy: "none", warnings };
    default:
      return { warnings };
  }
}

/**
 * Lower the AST `durability.resume` block onto the additive runtime
 * `PipelineDefinition.resume`. Returns `undefined` when no resume policy is
 * declared (or the block is empty), so the field stays absent (byte-identical).
 */
export function resumePolicyFromPolicy(
  policy: FlowDurabilityPolicy | undefined
): PipelineResumePolicy | undefined {
  const resume = policy?.resume;
  if (resume === undefined) return undefined;

  const out: PipelineResumePolicy = {};
  if (resume.onProcessRestart !== undefined) {
    out.onProcessRestart = resume.onProcessRestart;
  }
  if (resume.requireResumePoint !== undefined) {
    out.requireResumePoint = resume.requireResumePoint;
  }
  if (resume.maxReplayNodes !== undefined) {
    out.maxReplayNodes = resume.maxReplayNodes;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function coarsenWarning(strategy: AstCheckpointStrategy): CompilationWarning {
  return {
    stage: 4,
    code: "CHECKPOINT_STRATEGY_COARSENED",
    message:
      `durability.checkpoint.strategy '${strategy}' has no runtime execution ` +
      "path yet and is coarsened to 'after_each_node' (checkpoint after every " +
      "node); finer per-effect/per-branch checkpointing is not implemented.",
    nodePath: "root.durability.checkpoint",
    category: "policy",
  };
}
