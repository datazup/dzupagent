import type { RecoveryStrategy } from './adapter-recovery.js'

/** A named recovery policy with ordered strategies */
export interface RecoveryPolicy {
  /** Human-readable policy name */
  name: string
  /** Ordered list of strategies to try */
  strategies: RecoveryStrategyConfig[]
  /** When does this policy apply? */
  appliesTo?: (context: PolicyContext) => boolean
}

/** Individual strategy within a policy */
export interface RecoveryStrategyConfig {
  strategy: RecoveryStrategy
  /** Skip this strategy if condition returns true */
  skipIf?: (context: PolicyContext) => boolean
}

/** Context for policy evaluation */
export interface PolicyContext {
  taskTags?: string[]
  providerId?: string
  errorCode?: string
  attemptNumber: number
}

/** Selects the appropriate recovery policy for a given context */
export class RecoveryPolicySelector {
  private readonly policies: RecoveryPolicy[]
  private readonly defaultPolicy: RecoveryPolicy

  constructor(policies?: RecoveryPolicy[]) {
    this.defaultPolicy = RECOVERY_POLICIES.default
    this.policies = policies ?? [
      RECOVERY_POLICIES.research,
      RECOVERY_POLICIES.codegen,
    ]
  }

  /** Select the best matching policy for the given context */
  select(context: PolicyContext): RecoveryPolicy {
    for (const policy of this.policies) {
      if (policy.appliesTo?.(context)) return policy
    }
    return this.defaultPolicy
  }

  /** Get the next strategy from a policy, respecting skip conditions */
  getNextStrategy(
    policy: RecoveryPolicy,
    context: PolicyContext,
    attemptIndex: number,
  ): RecoveryStrategy | undefined {
    for (let i = attemptIndex; i < policy.strategies.length; i++) {
      const config = policy.strategies[i]!
      if (!config.skipIf?.(context)) {
        return config.strategy
      }
    }
    return undefined
  }
}

/** Built-in recovery policies */
export const RECOVERY_POLICIES = {
  /** Default: different provider -> increase budget -> escalate -> abort */
  default: {
    name: 'default',
    strategies: [
      { strategy: 'retry-different-provider' as const },
      { strategy: 'increase-budget' as const },
      { strategy: 'escalate-human' as const },
      { strategy: 'abort' as const },
    ],
  } satisfies RecoveryPolicy,

  /** Research tasks: simplify first, then different provider */
  research: {
    name: 'research',
    strategies: [
      { strategy: 'simplify-task' as const },
      { strategy: 'retry-different-provider' as const },
      { strategy: 'retry-same-provider' as const },
      { strategy: 'abort' as const },
    ],
    appliesTo: (ctx: PolicyContext) => ctx.taskTags?.includes('research') ?? false,
  } satisfies RecoveryPolicy,

  /** Code generation: retry same (transient errors), then different */
  codegen: {
    name: 'codegen',
    strategies: [
      { strategy: 'retry-same-provider' as const },
      { strategy: 'retry-different-provider' as const },
      { strategy: 'increase-budget' as const },
      { strategy: 'escalate-human' as const },
      { strategy: 'abort' as const },
    ],
    appliesTo: (ctx: PolicyContext) =>
      ctx.taskTags?.some(t => ['code', 'implementation', 'fix'].includes(t)) ?? false,
  } satisfies RecoveryPolicy,
} as const
