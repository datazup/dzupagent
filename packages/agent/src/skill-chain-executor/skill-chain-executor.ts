import { createWorkflow } from '../workflow/workflow-builder.js'
import type { CompiledWorkflow } from '../workflow/workflow-builder.js'
import type { WorkflowEvent, WorkflowContext } from '../workflow/workflow-types.js'
import type { SkillChain, RetryPolicy } from '@dzupagent/core/pipeline'
import type { SkillRegistry } from '@dzupagent/core/pipeline'
import type { DzupEventBus } from '@dzupagent/core/events'
import { validateChain } from '@dzupagent/core/pipeline'
import { calculateBackoff } from '@dzupagent/core/utils'
import type { SkillStepResolver } from './skill-step-resolver.js'
import type { StateTransformer } from './state-contract.js'
import { ChainValidationError, ConditionEvaluationError, StepExecutionError } from './errors.js'
import { omitUndefined } from '../utils/exact-optional.js'

export interface SkillChainExecutorConfig {
  resolver: SkillStepResolver
  registry: SkillRegistry
  eventBus?: DzupEventBus
  logger?: Pick<Console, 'debug' | 'warn' | 'error'>
  defaultTimeoutMs?: number
  /** Default retry policy applied to all steps that don't specify their own. */
  defaultRetry?: RetryPolicy
}

export interface DryRunStepInfo {
  skillId: string
  resolved: boolean
  description?: string
}

export interface DryRunResult {
  valid: boolean
  steps: DryRunStepInfo[]
  errors: string[]
}

export interface ExecuteOptions {
  signal?: AbortSignal
  /**
   * Per-step state transformers keyed by zero-based step index.
   * Applied AFTER the per-step SkillChainStep.stateTransformer (if any).
   */
  stateTransformers?: Record<number, StateTransformer>
  onProgress?: (event: WorkflowEvent) => void
}

export class SkillChainExecutor {
  constructor(private readonly config: SkillChainExecutorConfig) {}

  /**
   * Compile a SkillChain into a reusable CompiledWorkflow.
   *
   * Per-step state transformers (from ExecuteOptions) are baked in at
   * compile time via the optional `stateTransformers` param so each
   * execution of the returned workflow applies them automatically.
   *
   * @throws {ChainValidationError} if any skill ID fails canResolve()
   * @throws {SkillNotFoundError}   if resolver.resolve() rejects for any step
   */
  async compile(
    chain: SkillChain,
    stateTransformers?: Record<number, StateTransformer>,
    onEvent?: (event: WorkflowEvent) => void,
  ): Promise<CompiledWorkflow> {
    this.config.logger?.debug(`[SkillChainExecutor] compile start: "${chain.name}" (${chain.steps.length} steps)`)

    // 1. Pre-flight validation: check all skills are resolvable
    // For parallel steps, expand parallelSkills into individual IDs for resolution checks.
    const allSkillIds: string[] = []
    for (const step of chain.steps) {
      if (step.parallelSkills && step.parallelSkills.length > 0) {
        allSkillIds.push(...step.parallelSkills)
      } else {
        allSkillIds.push(step.skillName)
      }
    }
    // Build a synthetic chain using the expanded skill IDs for validateChain
    const expandedChain = {
      name: chain.name,
      steps: allSkillIds.map(id => ({ skillName: id })),
    }
    const resolvableSkills = allSkillIds.filter(id => this.config.resolver.canResolve(id))
    const validation = validateChain(expandedChain, resolvableSkills)
    if (!validation.valid) {
      throw new ChainValidationError(chain.name, validation)
    }

    // 2. Build CompiledWorkflow via WorkflowBuilder
    const builder = createWorkflow({
      id: `chain:${allSkillIds.join('\u2192')}`,
      description: chain.name,
    })

    for (let i = 0; i < chain.steps.length; i++) {
      const step = chain.steps[i]!

      // Insert suspend node before this step if suspendBefore is set
      if (step.suspendBefore) {
        builder.suspend(`before:${step.skillName}`)
      }

      // Handle parallel step groups
      if (step.parallelSkills && step.parallelSkills.length > 0) {
        const parallelSkills = step.parallelSkills
        const mergeStrategy = step.mergeStrategy ?? 'merge-objects'
        const stepLevelTransformer = step.stateTransformer
        const stepIndex = i
        const skillName = step.skillName

        // Resolve all parallel sub-skills eagerly
        const subSteps = await Promise.all(
          parallelSkills.map(id => this.config.resolver.resolve(id)),
        )

        const logger = this.config.logger

        builder.then({
          id: skillName,
          description: `Parallel: ${parallelSkills.join(', ')}`,
          execute: async (input: unknown, ctx: WorkflowContext) => {
            let state = ((input as Record<string, unknown>) ?? {}) as Record<string, unknown>

            // Apply step-level stateTransformer before forking
            if (stepLevelTransformer) {
              state = stepLevelTransformer(state)
            }

            logger?.debug(`[SkillChainExecutor] step ${stepIndex} parallel "${skillName}" starting`)

            const results = await Promise.all(
              subSteps.map(sub => sub.execute(state, ctx) as Promise<Record<string, unknown>>),
            )

            // Accumulate the output ledger independently from the selected
            // top-level merge strategy. Promise.all preserves the declared
            // sub-skill order, so nested collisions are deterministic.
            const previousOutputs = {
              ...((state['previousOutputs'] as Record<string, string> | undefined) ?? {}),
            }
            for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
              const result = results[resultIndex]!
              const nestedOutputs = result['previousOutputs']
              if (nestedOutputs && typeof nestedOutputs === 'object' && !Array.isArray(nestedOutputs)) {
                Object.assign(previousOutputs, nestedOutputs)
              }

              const subSkillId = parallelSkills[resultIndex]!
              const outputText = result[subSkillId]
              if (typeof outputText === 'string') {
                previousOutputs[subSkillId] = outputText
              }
            }

            // Merge ordinary result fields using the same distinction as the
            // workflow compiler. previousOutputs is handled above so one
            // branch cannot replace the accumulated ledger.
            let merged = { ...state }
            const selectedResults = mergeStrategy === 'last-wins'
              ? results.slice(-1)
              : results
            for (const result of selectedResults) {
              for (const [key, value] of Object.entries(result)) {
                if (key !== 'previousOutputs') {
                  merged[key] = value
                }
              }
            }
            return { ...merged, previousOutputs }
          },
        })

        continue
      }

      // Resolve the skill to a WorkflowStep
      const workflowStep = await this.config.resolver.resolve(step.skillName)

      // Capture loop variables for the closure
      const stepIndex = i
      const skillName = step.skillName
      const stepLevelTransformer = step.stateTransformer
      const indexLevelTransformer = stateTransformers?.[i]
      const prevSkillName = i > 0 ? chain.steps[i - 1]!.skillName : undefined
      const stepCondition = step.condition
      const timeoutMs = step.timeoutMs ?? this.config.defaultTimeoutMs
      const logger = this.config.logger
      const retryPolicy = step.retryPolicy ?? this.config.defaultRetry

      builder.then(omitUndefined({
        id: workflowStep.id,
        description: workflowStep.description,
        execute: async (input: unknown, ctx: WorkflowContext) => {
          logger?.debug(`[SkillChainExecutor] step ${stepIndex} ("${skillName}") starting`)
          let state = ((input as Record<string, unknown>) ?? {}) as Record<string, unknown>

          // Evaluate step condition against previous step's output
          if (stepCondition) {
            const previousOutput = prevSkillName
              ? ((state['previousOutputs'] as Record<string, string> | undefined)?.[prevSkillName] ?? '')
              : ''
            let conditionResult: boolean
            try {
              conditionResult = stepCondition(previousOutput)
            } catch (condErr) {
              throw new ConditionEvaluationError(stepIndex, skillName, condErr)
            }
            if (!conditionResult) {
              // Skip this step — return state unchanged
              onEvent?.({ type: 'step:skipped', stepId: skillName, reason: 'condition-gate' })
              return state
            }
          }

          // Inject step metadata
          state = { ...state, stepIndex, skillId: skillName }

          // Apply step-level stateTransformer (from SkillChainStep)
          if (stepLevelTransformer) {
            state = stepLevelTransformer(state)
          }

          // Apply index-level stateTransformer (from ExecuteOptions)
          if (indexLevelTransformer) {
            state = indexLevelTransformer(state)
          }

          // Retry loop
          const maxAttempts = retryPolicy?.maxAttempts ?? 1
          let lastError: unknown

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // Check if already aborted
            if (ctx.signal?.aborted) {
              throw ctx.signal.reason ?? new Error('Aborted')
            }

            // Execute the resolved workflow step (with optional timeout)
            let timeoutId: ReturnType<typeof setTimeout> | undefined
            const timeoutPromise = timeoutMs !== undefined
              ? new Promise<never>((_, reject) => {
                  timeoutId = setTimeout(
                    () => reject(new Error(`Step "${skillName}" timed out after ${timeoutMs}ms`)),
                    timeoutMs,
                  )
                })
              : undefined

            try {
              let result: Record<string, unknown>
              try {
                result = timeoutPromise
                  ? await Promise.race([
                      workflowStep.execute(state, ctx) as Promise<Record<string, unknown>>,
                      timeoutPromise,
                    ])
                  : (await workflowStep.execute(state, ctx)) as Record<string, unknown>
              } finally {
                if (timeoutId !== undefined) clearTimeout(timeoutId)
              }

              // Merge output into previousOutputs
              const outputText = result[skillName]
              if (typeof outputText === 'string') {
                const existing = (state['previousOutputs'] as Record<string, string> | undefined) ?? {}
                return {
                  ...result,
                  previousOutputs: { ...existing, [skillName]: outputText },
                }
              }

              return result
            } catch (err) {
              lastError = err

              if (attempt >= maxAttempts) break // exhausted retries

              // Check if this error type is retryable
              if (retryPolicy?.retryableErrors) {
                const msg = err instanceof Error ? err.message : String(err)
                const isRetryable = retryPolicy.retryableErrors.some(pattern =>
                  pattern instanceof RegExp ? pattern.test(msg) : msg.includes(pattern),
                )
                if (!isRetryable) break
              }

              // Calculate backoff using the shared helper. The shared helper
              // uses 0-based `attempt`; callers here use 1-based so we pass
              // `attempt - 1`. The legacy `+/-20%` jitter is core's
              // `jitterMode: 'centered'` (ARCH27-T-13 candidate 3).
              const base = retryPolicy?.initialBackoffMs ?? 100
              const mult = retryPolicy?.multiplier ?? 2
              const max = retryPolicy?.maxBackoffMs ?? 30_000
              const backoffMs = calculateBackoff(Math.max(0, attempt - 1), {
                initialBackoffMs: base,
                maxBackoffMs: max,
                multiplier: mult,
                jitter: retryPolicy?.jitter ?? false,
                jitterMode: 'centered',
              })

              // Emit step:retrying event
              onEvent?.({ type: 'step:retrying', stepId: skillName, attempt, maxAttempts, backoffMs })
              logger?.warn(`[SkillChainExecutor] step "${skillName}" failed (attempt ${attempt}/${maxAttempts}), retrying in ${backoffMs}ms`, lastError)

              // Wait for backoff (abort-signal aware)
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, backoffMs)
                if (ctx.signal) {
                  const onAbort = () => {
                    clearTimeout(timer)
                    reject(ctx.signal?.reason ?? new Error('Aborted during retry backoff'))
                  }
                  ctx.signal.addEventListener('abort', onAbort, { once: true })
                }
              })
            }
          }

          // All attempts exhausted
          throw new StepExecutionError(stepIndex, skillName, lastError, state)
        },
      }))
    }

    return builder.build()
  }

  /**
   * Compile and execute a SkillChain, returning the final accumulated state.
   *
   * @throws {ChainValidationError}  on pre-execution validation failure
   * @throws {StepExecutionError}    if a step fails during execution
   */
  async execute(
    chain: SkillChain,
    initialState: Record<string, unknown>,
    opts?: ExecuteOptions,
  ): Promise<Record<string, unknown>> {
    // Reject immediately if the signal is already aborted before we do anything.
    if (opts?.signal?.aborted) {
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new DOMException('The operation was aborted', 'AbortError')
    }

    const eventBus = this.config.eventBus
    const runId = crypto.randomUUID()

    const onEvent = (event: WorkflowEvent) => {
      opts?.onProgress?.(event)
      if (eventBus) {
        bridgeEvent(event, chain.name, runId, eventBus)
      }
    }

    const workflow = await this.compile(chain, opts?.stateTransformers, onEvent)

    // Ensure previousOutputs is initialized in state
    const state: Record<string, unknown> = {
      previousOutputs: {},
      ...initialState,
    }

    try {
      const result = await workflow.run(state, omitUndefined({
        signal: opts?.signal,
        onEvent,
      }))

      // A terminal parallel group has a synthetic step name, so its selected
      // textual output is the final declared sub-skill's output.
      const lastStep = chain.steps[chain.steps.length - 1]
      const parallelSkills = lastStep?.parallelSkills
      const lastSkillId = parallelSkills && parallelSkills.length > 0
        ? parallelSkills[parallelSkills.length - 1]
        : lastStep?.skillName
      const previousOutputs = result['previousOutputs'] as Record<string, string> | undefined
      const lastOutputCandidate = lastSkillId && previousOutputs
        ? previousOutputs[lastSkillId]
        : undefined
      const lastOutput = typeof lastOutputCandidate === 'string'
        ? lastOutputCandidate
        : undefined

      return { ...result, lastOutput }
    } catch (err) {
      this.config.logger?.error(`[SkillChainExecutor] execute failed for chain "${chain.name}"`, err)
      // Re-throw typed errors as-is, wrap everything else
      if (err instanceof StepExecutionError || err instanceof ConditionEvaluationError) {
        throw err
      }
      throw new StepExecutionError(-1, 'unknown', err, state)
    }
  }

  /**
   * Compile and stream a SkillChain, yielding WorkflowEvents as they occur.
   *
   * @throws {ChainValidationError} eagerly before any events are yielded
   */
  async *stream(
    chain: SkillChain,
    initialState: Record<string, unknown>,
    opts?: ExecuteOptions,
  ): AsyncGenerator<WorkflowEvent> {
    const runId = crypto.randomUUID()
    const eventBus = this.config.eventBus
    const onEvent = (event: WorkflowEvent) => {
      opts?.onProgress?.(event)
      if (eventBus) {
        bridgeEvent(event, chain.name, runId, eventBus)
      }
    }
    const workflow = await this.compile(chain, opts?.stateTransformers, onEvent)
    const state: Record<string, unknown> = { previousOutputs: {}, ...initialState }
    yield* workflow.stream(state, omitUndefined({ signal: opts?.signal }))
  }

  /**
   * Validate a chain without executing it.
   * Checks that every step can be resolved and returns structured diagnostics.
   *
   * This is a lazy check — it only calls `canResolve()` and reads from the
   * SkillRegistry. It never calls `resolver.resolve()`, so no DzupAgent
   * objects are instantiated.
   */
  dryRun(chain: SkillChain): DryRunResult {
    const steps: DryRunStepInfo[] = []
    const errors: string[] = []
    for (const step of chain.steps) {
      const canResolve = this.config.resolver.canResolve(step.skillName)
      if (canResolve) {
        const entry = this.config.registry.get(step.skillName)
        steps.push(omitUndefined({ skillId: step.skillName, resolved: true, description: entry?.description }))
      } else {
        steps.push({ skillId: step.skillName, resolved: false })
        errors.push(`Skill "${step.skillName}" cannot be resolved`)
      }
    }
    return { valid: errors.length === 0, steps, errors }
  }
}

// ---------------------------------------------------------------------------
// WorkflowEvent → DzupEventBus bridge
// ---------------------------------------------------------------------------

function bridgeEvent(
  event: WorkflowEvent,
  pipelineId: string,
  runId: string,
  bus: DzupEventBus,
): void {
  switch (event.type) {
    case 'step:started':
      bus.emit({ type: 'pipeline:node_started', pipelineId, runId, nodeId: event.stepId, nodeType: 'skill' })
      break
    case 'step:completed':
      bus.emit({ type: 'pipeline:node_completed', pipelineId, runId, nodeId: event.stepId, durationMs: event.durationMs })
      break
    case 'step:failed':
      bus.emit({ type: 'pipeline:node_failed', pipelineId, runId, nodeId: event.stepId, error: event.error })
      break
    case 'step:skipped':
      bus.emit({ type: 'pipeline:node_skipped', pipelineId, runId, nodeId: event.stepId, reason: event.reason })
      break
    case 'step:retrying':
      bus.emit({
        type: 'pipeline:node_retry',
        pipelineId,
        runId,
        nodeId: event.stepId,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        error: '',
        backoffMs: event.backoffMs,
      })
      break
    case 'suspended':
      bus.emit({ type: 'pipeline:suspended', pipelineId, runId, nodeId: event.reason })
      break
    case 'workflow:completed':
      bus.emit({ type: 'pipeline:run_completed', pipelineId, runId, durationMs: event.durationMs })
      break
    case 'workflow:failed':
      bus.emit({ type: 'pipeline:run_failed', pipelineId, runId, error: event.error })
      break
    default:
      break
  }
}
