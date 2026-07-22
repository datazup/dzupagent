/**
 * synthetic-steps.ts — Leaf (non-recursing) variant walkers for the
 * skill-chain lowerer.
 *
 * These variants emit (or suppress) synthetic marker steps without descending
 * into child node slices: clarification (synthetic suspend), complete (terminus
 * no-op), and memory (structured pass-through marker).
 *
 * @module lower/lower-skill-chain/synthetic-steps
 */

import type {
  ClarificationNode,
  CompleteNode,
  MemoryNode,
} from "@dzupagent/flow-ast";
import type { SkillChainStep } from "@dzupagent/core/pipeline";
import { slugify } from "./slugify.js";

/**
 * clarification → synthetic suspend step.
 *
 * The question is recorded as a synthetic skillName. suspendBefore is set so
 * the executor pauses for human input before the next real step.
 */
export function walkClarification(
  node: ClarificationNode,
  path: string,
  steps: SkillChainStep[],
  warnings: string[]
): void {
  warnings.push(
    `Clarification at "${path}" (question="${node.question}") lowered as synthetic suspend step — ` +
      `skill-chain has no native clarification primitive.`
  );

  const slug = slugify(node.question);
  steps.push({
    skillName: `__clarification__${slug}`,
    suspendBefore: true,
  });
}

/**
 * complete → no step emitted; chain terminus is implicit.
 */
export function walkComplete(
  node: CompleteNode,
  path: string,
  warnings: string[]
): void {
  if (node.result !== undefined && node.result.length > 0) {
    warnings.push(
      `Complete at "${path}" (result="${node.result}") dropped — skill-chain has no terminal result field.`
    );
  }
}

/**
 * memory → synthetic pass-through marker step.
 *
 * Skill chains have no native memory-operation primitive. We emit a
 * structured marker step so the executor can recognise and route the
 * operation at runtime without losing the operation/tier/key metadata.
 */
export function walkMemory(
  node: MemoryNode,
  path: string,
  steps: SkillChainStep[]
): void {
  const keySuffix = node.key ? `_${slugify(node.key)}` : "";
  steps.push({
    skillName: `__memory__${node.operation}_${node.tier}${keySuffix}`,
    stateTransformer: (state: Record<string, unknown>) => ({
      ...state,
      __memoryOp: { operation: node.operation, tier: node.tier, key: node.key },
      __memoryPath: path,
    }),
  });
}
