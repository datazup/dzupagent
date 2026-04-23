/**
 * Pipeline executor with DAG dependency resolution, conditional phases,
 * retry strategies, per-phase timeouts, and checkpoint support.
 */

import { calculateBackoff } from '@dzupagent/core'
import type { SkillResolutionContext } from '@dzupagent/core'
import type { GuardrailGateConfig } from './guardrail-gate.js'
import { runGuardrailGate, summarizeGateResult } from './guardrail-gate.js'
import type { GuardrailContext } from '../guardrails/guardrail-types.js'
import type { SkillResolverConfig } from './skill-resolver.js'
import { resolveAndInjectSkills } from './skill-resolver.js'
import type { BudgetGateConfig } from './budget-gate.js'
import { runBudgetGate } from './budget-gate.js'

export interface ExecutorConfig {
  /** Default timeout per phase in ms (default: 120_000) */
  defaultTimeoutMs: number
  /** Default max retries per phase (default: 0) */
  defaultMaxRetries: number
  /** Checkpoint function called after each successful phase */
  onCheckpoint?: (phaseId: string, state: Record<string, unknown>) => Promise<void>
  /** Progress callback */
  onProgress?: (phaseId: string, progress: number) => void
  /**
   * Optional guardrail gate that runs after each generation phase.
   * If the gate fails, the phase is marked as 'failed' with violation details.
   */
  guardrailGate?: GuardrailGateConfig
  /**
   * Build a GuardrailContext from the current pipeline state after a phase completes.
   * Required when guardrailGate is configured. If not provided, the gate is skipped.
   */
  buildGuardrailContext?: (
    phaseId: string,
    state: Record<string, unknown>,
  ) => GuardrailContext | undefined
  /**
   * Optional skill resolver. When set, skills declared in PhaseConfig.skills[]
   * are resolved and injected into state before each phase executes.
   * Resolved content is placed at state.__skills_<name> and state.__skills_prompt_<name>.
   */
  skillResolver?: SkillResolverConfig | undefined
  /**
   * Optional base context for skill resolution (observability / usage tracking).
   * The `phase` field is overridden per phase automatically.
   */
  skillResolutionContext?: Omit<SkillResolutionContext, 'phase'> | undefined
  /**
   * Optional budget gate that checks remaining budget before each phase.
   * If budget is exceeded, subsequent phases are skipped with a budget error.
   */
  budgetGate?: BudgetGateConfig | undefined
}

export interface PhaseConfig {
  id: string
  name: string
  /** Execute this phase */
  execute: (state: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** Condition to run this phase (default: always run) */
  condition?: (state: Record<string, unknown>) => boolean
  /** Phase IDs that must complete before this one */
  dependsOn?: string[]
  /** Max retries for this phase (default: executor default) */
  maxRetries?: number
  /** Timeout for this phase in ms (default: executor default) */
  timeoutMs?: number
  /** Retry strategy */
  retryStrategy?: 'immediate' | 'backoff'
  /**
   * Skill names/IDs to resolve and inject into state before this phase executes.
   * Requires ExecutorConfig.skillResolver to be set.
   */
  skills?: string[] | undefined
}

export interface PhaseResult {
  phaseId: string
  status: 'completed' | 'skipped' | 'failed' | 'timeout'
  durationMs: number
  retries: number
  error?: string
  output?: Record<string, unknown>
}

export interface PipelineExecutionResult {
  status: 'completed' | 'failed'
  phases: PhaseResult[]
  totalDurationMs: number
  state: Record<string, unknown>
}

const DEFAULT_CONFIG: ExecutorConfig = {
  defaultTimeoutMs: 120_000,
  defaultMaxRetries: 0,
}

/**
 * Topologically sort phases by their dependsOn relationships.
 * Throws if a cycle is detected.
 */
function topoSort(phases: PhaseConfig[]): PhaseConfig[] {
  const byId = new Map(phases.map(p => [p.id, p]))
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const sorted: PhaseConfig[] = []

  function visit(id: string): void {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Cycle detected involving phase "${id}"`)
    visiting.add(id)
    const phase = byId.get(id)
    if (!phase) throw new Error(`Unknown dependency phase "${id}"`)
    for (const dep of phase.dependsOn ?? []) {
      visit(dep)
    }
    visiting.delete(id)
    visited.add(id)
    sorted.push(phase)
  }

  for (const phase of phases) visit(phase.id)
  return sorted
}

/** Execute a function with an AbortSignal-based timeout. */
async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<{ result: T; timedOut: false } | { timedOut: true }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () => reject(new Error('Phase timeout')))
      }),
    ])
    return { result, timedOut: false }
  } catch (err) {
    if (ac.signal.aborted) return { timedOut: true }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function backoffDelay(attempt: number): number {
  return calculateBackoff(attempt, {
    initialBackoffMs: 1000,
    maxBackoffMs: 30_000,
    multiplier: 2,
  })
}

/**
 * Execute a pipeline of phases with dependency resolution, conditions,
 * retries, and timeouts.
 */
export class PipelineExecutor {
  private readonly config: ExecutorConfig

  constructor(config?: Partial<ExecutorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async execute(
    phases: PhaseConfig[],
    initialState: Record<string, unknown>,
  ): Promise<PipelineExecutionResult> {
    const pipelineStart = Date.now()
    const sorted = topoSort(phases)
    const results: PhaseResult[] = []
    const completed = new Set<string>()
    const state: Record<string, unknown> = { ...initialState }
    let overallFailed = false

    for (const phase of sorted) {
      const phaseStart = Date.now()

      // Check dependencies all completed
      const unmetDeps = (phase.dependsOn ?? []).filter(d => !completed.has(d))
      if (unmetDeps.length > 0) {
        results.push({
          phaseId: phase.id,
          status: 'skipped',
          durationMs: 0,
          retries: 0,
          error: `Unmet dependencies: ${unmetDeps.join(', ')}`,
        })
        overallFailed = true
        continue
      }

      // Check condition
      if (phase.condition && !phase.condition(state)) {
        const durationMs = Date.now() - phaseStart
        results.push({
          phaseId: phase.id,
          status: 'skipped',
          durationMs,
          retries: 0,
        })
        completed.add(phase.id)
        state[`__phase_${phase.id}_skipped`] = true
        this.config.onProgress?.(phase.id, 1)
        continue
      }

      // Check budget gate before execution
      if (this.config.budgetGate) {
        const budgetResult = await runBudgetGate(this.config.budgetGate)
        state[`__phase_${phase.id}_budget`] = {
          passed: budgetResult.passed,
          usedCents: budgetResult.usedCents,
          remainingCents: budgetResult.remainingCents,
        }
        if (!budgetResult.passed) {
          const durationMs = Date.now() - phaseStart
          const error = `Budget exceeded: used ${budgetResult.usedCents} cents, remaining ${budgetResult.remainingCents} cents`
          results.push({
            phaseId: phase.id,
            status: 'failed',
            durationMs,
            retries: 0,
            error,
          })
          overallFailed = true
          break
        }
      }

      // Resolve and inject skills declared for this phase
      if (phase.skills && phase.skills.length > 0 && this.config.skillResolver) {
        await resolveAndInjectSkills(
          phase.skills,
          phase.name,
          state,
          this.config.skillResolver,
          { ...(this.config.skillResolutionContext ?? {}), phase: phase.name },
        )
      }

      const maxRetries = phase.maxRetries ?? this.config.defaultMaxRetries
      const timeoutMs = phase.timeoutMs ?? this.config.defaultTimeoutMs
      let lastError: string | undefined
      let retries = 0
      let output: Record<string, unknown> | undefined
      let phaseSucceeded = false

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          retries = attempt
          if (phase.retryStrategy === 'backoff') {
            await new Promise(r => setTimeout(r, backoffDelay(attempt - 1)))
          }
        }

        this.config.onProgress?.(phase.id, attempt / (maxRetries + 1))

        try {
          const result = await withTimeout(() => phase.execute(state), timeoutMs)
          if (result.timedOut) {
            lastError = `Phase "${phase.name}" timed out after ${timeoutMs}ms`
            continue
          }

          output = result.result
          Object.assign(state, output)
          state[`__phase_${phase.id}_completed`] = true

          // Run guardrail gate if configured and a context builder is provided
          if (this.config.guardrailGate && this.config.buildGuardrailContext) {
            const guardrailCtx = this.config.buildGuardrailContext(phase.id, state)
            if (guardrailCtx) {
              const gateResult = runGuardrailGate(this.config.guardrailGate, guardrailCtx)
              state[`__phase_${phase.id}_guardrail`] = {
                passed: gateResult.passed,
                errorCount: gateResult.report.errorCount,
                warningCount: gateResult.report.warningCount,
              }
              if (!gateResult.passed) {
                const durationMs = Date.now() - phaseStart
                const error = summarizeGateResult(gateResult)
                results.push({
                  phaseId: phase.id,
                  status: 'failed',
                  durationMs,
                  retries,
                  error,
                  output,
                })
                overallFailed = true
                phaseSucceeded = false
                lastError = error
                break
              }
            }
          }

          completed.add(phase.id)
          const durationMs = Date.now() - phaseStart
          results.push({
            phaseId: phase.id,
            status: 'completed',
            durationMs,
            retries,
            output,
          })
          this.config.onProgress?.(phase.id, 1)

          if (this.config.onCheckpoint) {
            await this.config.onCheckpoint(phase.id, state)
          }

          phaseSucceeded = true
          break
        } catch (err: unknown) {
          lastError = err instanceof Error ? err.message : String(err)
        }
      }

      if (!phaseSucceeded && !results.some(r => r.phaseId === phase.id && r.status === 'failed')) {
        const durationMs = Date.now() - phaseStart
        const isTimeout = lastError?.includes('timed out')
        const phaseResult: PhaseResult = {
          phaseId: phase.id,
          status: isTimeout ? 'timeout' : 'failed',
          durationMs,
          retries,
        }
        if (lastError !== undefined) phaseResult.error = lastError
        results.push(phaseResult)
        overallFailed = true
        // Stop executing subsequent phases once a phase fails.
        break
      } else if (overallFailed && results.some(r => r.phaseId === phase.id && r.status === 'failed')) {
        // Guardrail gate failure already recorded — stop.
        break
      }
    }

    return {
      status: overallFailed ? 'failed' : 'completed',
      phases: results,
      totalDurationMs: Date.now() - pipelineStart,
      state: { ...state },
    }
  }
}
