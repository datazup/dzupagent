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

/** Retry configuration for a single skill-chain step. */
export interface RetryPolicy {
  /** Total number of attempts (including the first). Must be >= 1. */
  maxAttempts: number
  /** Initial backoff delay in ms (default: 100). */
  initialBackoffMs?: number
  /** Maximum backoff delay in ms (default: 30_000). */
  maxBackoffMs?: number
  /** Exponential multiplier (default: 2). */
  multiplier?: number
  /** When true, adds +/-20% random jitter to the backoff delay. Default: false. */
  jitter?: boolean
  /**
   * If set, only retry when the error message matches at least one pattern.
   * String patterns use `message.includes(pattern)`, RegExp patterns use `pattern.test(message)`.
   */
  retryableErrors?: Array<string | RegExp>
}

/** Merge strategy for parallel step groups. */
export type ParallelMergeStrategy = 'merge-objects' | 'last-wins'

export interface SkillChainStep {
  /** Name of the skill to execute at this step. */
  skillName: string
  /**
   * Optional predicate evaluated against the previous step's output.
   * If it returns false, the chain stops before executing this step.
   * The first step's condition receives an empty string.
   */
  condition?: (previousResult: string) => boolean
  /**
   * When true, inserts WorkflowBuilder.suspend("before:${skillName}")
   * immediately before this step for human-in-the-loop review.
   */
  suspendBefore?: boolean
  /**
   * Pure state transform applied before this step executes.
   * MUST return a new object, not mutate the input.
   */
  stateTransformer?: (state: Record<string, unknown>) => Record<string, unknown>
  /** Timeout in milliseconds for this step. */
  timeoutMs?: number
  /** Per-step retry policy with exponential backoff. */
  retryPolicy?: RetryPolicy
  /**
   * When set, this step is a parallel group. `skillName` is a synthetic
   * key ("parallel:<a,b,...>") and actual execution runs all listed skill IDs
   * concurrently via Promise.all, merging results according to `mergeStrategy`.
   */
  parallelSkills?: string[]
  /** How to merge parallel sub-skill results. Defaults to 'merge-objects'. */
  mergeStrategy?: ParallelMergeStrategy
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
// Builder (fluent API)
// ---------------------------------------------------------------------------

export class SkillChainBuilder {
  private readonly _name: string
  private readonly _steps: SkillChainStep[] = []

  constructor(name: string) {
    if (!name) throw new Error('Skill chain name must not be empty')
    this._name = name
  }

  /** Add a step with optional configuration. */
  step(skillName: string, opts?: Omit<SkillChainStep, 'skillName'>): this {
    this._steps.push({ skillName, ...opts })
    return this
  }

  /** Add a step that only runs when the condition against the previous step output is true. */
  stepIf(
    skillName: string,
    condition: (previousResult: string) => boolean,
    opts?: Omit<SkillChainStep, 'skillName' | 'condition'>,
  ): this {
    this._steps.push({ skillName, condition, ...opts })
    return this
  }

  /** Add a step that suspends for human-in-the-loop review before executing. */
  stepSuspend(skillName: string, opts?: Omit<SkillChainStep, 'skillName' | 'suspendBefore'>): this {
    this._steps.push({ skillName, suspendBefore: true, ...opts })
    return this
  }

  /**
   * Add a parallel group step. All listed skill IDs execute concurrently and
   * their results are merged into shared state.
   */
  parallel(
    skillIds: string[],
    opts?: {
      mergeStrategy?: ParallelMergeStrategy
      stateTransformer?: (state: Record<string, unknown>) => Record<string, unknown>
    },
  ): this {
    if (skillIds.length === 0) {
      throw new Error('parallel() requires at least one skill ID')
    }
    const syntheticName = `parallel:${skillIds.join(',')}`
    this._steps.push({
      skillName: syntheticName,
      parallelSkills: skillIds,
      ...(opts?.mergeStrategy !== undefined && { mergeStrategy: opts.mergeStrategy }),
      ...(opts?.stateTransformer !== undefined && { stateTransformer: opts.stateTransformer }),
    })
    return this
  }

  /** Build and return the SkillChain. Throws if no steps were added. */
  build(): SkillChain {
    return createSkillChain(this._name, this._steps)
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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
