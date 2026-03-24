/**
 * Skill chaining — define and validate multi-step skill pipelines.
 *
 * A SkillChain is a declarative sequence of skill invocations where each
 * step may include an optional condition gate evaluated against the
 * previous step's output.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillChainStep {
  /** Name of the skill to execute at this step. */
  skillName: string
  /**
   * Optional predicate evaluated against the previous step's output.
   * If it returns false, the chain stops before executing this step.
   * The first step's condition receives an empty string.
   */
  condition?: (previousResult: string) => boolean
}

export interface SkillChain {
  /** Human-readable identifier for this chain. */
  name: string
  /** Ordered list of steps to execute. */
  steps: SkillChainStep[]
}

export interface ChainValidationResult {
  valid: boolean
  missingSkills: string[]
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a skill chain definition. Throws if the step list is empty. */
export function createSkillChain(
  name: string,
  steps: SkillChainStep[],
): SkillChain {
  if (!name) {
    throw new Error('Skill chain name must not be empty')
  }
  if (steps.length === 0) {
    throw new Error('Skill chain must contain at least one step')
  }
  return { name, steps: [...steps] }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check whether every skill referenced in the chain exists in the
 * provided `availableSkills` list. Returns the list of missing skill
 * names (if any).
 */
export function validateChain(
  chain: SkillChain,
  availableSkills: string[],
): ChainValidationResult {
  const available = new Set(availableSkills)
  const missingSkills = chain.steps
    .map((s) => s.skillName)
    .filter((n) => !available.has(n))

  // Deduplicate while preserving order
  const unique = [...new Set(missingSkills)]

  return {
    valid: unique.length === 0,
    missingSkills: unique,
  }
}
