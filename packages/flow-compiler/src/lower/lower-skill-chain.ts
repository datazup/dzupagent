/**
 * Stage 4 lowerer — skill-chain target.
 *
 * Receives a router-dispatched AST and emits a linear `SkillChain` artifact
 * plus an array of non-fatal warnings.
 *
 * The skill-chain target is intentionally linear: `SkillChainStep` supports
 * only `skillName`, `condition`, `suspendBefore`, `stateTransformer`,
 * `timeoutMs`, and `retryPolicy`. It cannot natively express forks, joins,
 * multi-branch dispatch, or suspend-with-branches.
 *
 * Per the Wave 12 parity audit, this lowerer must accept every non-`for_each`
 * FlowNode variant and perform a best-effort degradation, emitting warnings
 * whenever semantic fidelity is lost. Only `for_each` is a true
 * router-contract violation (pipeline-only).
 *
 * This module is a thin composition root; implementation lives in sibling
 * leaf modules under `lower-skill-chain/`:
 *   - `walk.ts`             `walkNode` dispatcher + recursing variant walkers
 *                           (branch/parallel/approval/persona/route)
 *   - `action.ts`           action-node lowering + skill-handle narrowing
 *   - `synthetic-steps.ts`  leaf walkers (clarification/complete/memory)
 *   - `slugify.ts`          skillName suffix sanitiser
 *
 * @module lower/lower-skill-chain
 */

import type { FlowNode, ResolvedTool } from "@dzupagent/flow-ast";
import type { SkillChain, SkillChainStep } from "@dzupagent/core/pipeline";
import type { LoweringMode } from "./_shared.js";
import { collectFlowArtifactMetadata } from "../flow-artifact-metadata.js";
import type { FlowArtifactMetadata } from "../flow-artifact-metadata.js";
import { walkNode } from "./lower-skill-chain/walk.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LowerSkillChainInput {
  ast: FlowNode;
  resolved: Map<string, ResolvedTool>;
  /**
   * Defaults to executable lowering. Diagnostic lowering may use unresolved
   * action refs as best-effort SkillChain step names with warnings.
   */
  mode?: LoweringMode;
  /**
   * Human-readable name for the emitted chain.
   * Defaults to `"flow"` when not provided.
   */
  name?: string;
}

export function lowerSkillChain(input: LowerSkillChainInput): {
  artifact: SkillChain & { metadata?: FlowArtifactMetadata };
  warnings: string[];
} {
  const warnings: string[] = [];
  const steps: SkillChainStep[] = [];

  walkNode(
    input.ast,
    "root",
    input.resolved,
    input.mode ?? "executable",
    steps,
    warnings
  );

  if (steps.length === 0) {
    throw new Error(
      "lowerSkillChain: no action nodes found in AST — cannot emit an empty SkillChain"
    );
  }

  const artifact: SkillChain = {
    name: input.name ?? "flow",
    steps,
  };

  return {
    artifact: {
      ...artifact,
      metadata: collectFlowArtifactMetadata(input.ast),
    },
    warnings,
  };
}
