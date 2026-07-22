/**
 * action.ts — Action-node lowering for the skill-chain target.
 *
 * Resolves an ActionNode to a single `SkillChainStep` by looking up the
 * router-resolved tool entry and narrowing it to a `SkillHandle`. Handles the
 * executable (reject unresolved) vs diagnostic (best-effort) mode split.
 *
 * @module lower/lower-skill-chain/action
 */

import type { ActionNode, ResolvedTool } from "@dzupagent/flow-ast";
import type { SkillChainStep, SkillHandle } from "@dzupagent/core/pipeline";
import type { LoweringMode } from "../_shared.js";

/**
 * OI-2 narrowing cast: check `rt.kind === 'skill'` then cast `handle`.
 * Returns `null` when the resolved tool is not a skill.
 */
export function asSkillHandle(rt: ResolvedTool): SkillHandle | null {
  if (rt.kind !== "skill") return null;
  // Safe cast — `kind` discriminant verified above; no `any` used.
  return rt.handle as SkillHandle;
}

export function lowerAction(
  node: ActionNode,
  path: string,
  resolved: Map<string, ResolvedTool>,
  mode: LoweringMode,
  warnings: string[]
): SkillChainStep {
  const rt = resolved.get(path);

  if (rt === undefined) {
    const message = `Action at "${path}" has no resolved tool entry for "${node.toolRef}"`;
    if (mode === "executable") {
      throw new Error(
        `${message}; executable lowering rejects unresolved semantic references.`
      );
    }

    warnings.push(`${message} — using toolRef as diagnostic skillName.`);
    return { skillName: node.toolRef };
  }

  const handle = asSkillHandle(rt);
  if (handle === null) {
    warnings.push(
      `Action at "${path}" resolved to kind "${rt.kind}" — expected "skill". Using ref "${rt.ref}" as skillName.`
    );
    return { skillName: rt.ref };
  }

  // `handle` is now narrowed; `skillName` comes from the stable ref string.
  void handle; // acknowledged — runtime use is by the executor, not this lowerer

  return { skillName: rt.ref };
}
