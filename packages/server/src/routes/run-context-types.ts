/** Structural type for TokenLifecycleManager (from `@dzupagent/context`).
 *  We use structural typing to avoid a hard dependency on the context package,
 *  matching the existing `RunReflectorLike` pattern in this server. */
export interface TokenLifecycleLike {
  readonly usedTokens: number
  readonly remainingTokens: number
  readonly status: 'ok' | 'warn' | 'critical' | 'exhausted'
  readonly report: {
    used: number
    available: number
    pct: number
    status: 'ok' | 'warn' | 'critical' | 'exhausted'
    phases: Array<{ phase: string; tokens: number; timestamp: number }>
    recommendation?: string
  }
}

/** Minimal registry surface — anything that can look up a lifecycle manager by runId. */
export interface TokenLifecycleRegistry {
  get(runId: string): TokenLifecycleLike | undefined
}
