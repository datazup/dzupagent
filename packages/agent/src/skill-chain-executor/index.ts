import { createSkillChain, WorkflowCommandParser, SkillRegistry } from '@dzupagent/core'
import type { SkillChain } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import type { WorkflowRegistry } from '@dzupagent/core'
import type { CompiledWorkflow } from '../workflow/workflow-builder.js'
import type { WorkflowEvent } from '../workflow/workflow-types.js'
import { SkillChainExecutor } from './skill-chain-executor.js'
import type { SkillStepResolver } from './skill-step-resolver.js'
import type { StateTransformer } from './state-contract.js'
import { WorkflowParseError } from './errors.js'

export interface TextualWorkflowOptions {
  /** Custom parser; defaults to WorkflowCommandParser with built-in arrow/pipe/comma/then patterns. */
  parser?: WorkflowCommandParser
  /** Checked first for exact named-workflow alias lookup (case-insensitive). */
  registry?: WorkflowRegistry
  signal?: AbortSignal
  stateTransformers?: Record<number, StateTransformer>
  onProgress?: (event: WorkflowEvent) => void
  eventBus?: DzupEventBus
  /** SkillRegistry for pre-flight chain validation. Required unless resolver exposes one. */
  skillRegistry?: SkillRegistry
  /** Logger for debug/warn/error output. */
  logger?: Pick<Console, 'debug' | 'warn' | 'error'>
  /** Default per-step timeout in milliseconds. */
  defaultTimeoutMs?: number
}

/**
 * Parse a textual workflow command and execute it as a sequential skill chain.
 *
 * Resolution order:
 * 1. options.registry?.get(text) — exact named workflow lookup
 * 2. Parse text via WorkflowCommandParser (arrow/pipe/comma/then separators)
 * 3. Build SkillChain → compile → execute via SkillChainExecutor
 *
 * @throws {WorkflowParseError}    text cannot be parsed into steps
 * @throws {ChainValidationError}  one or more skill IDs cannot be resolved
 * @throws {StepExecutionError}    a step fails during execution
 */
export async function executeTextualWorkflow(
  text: string,
  resolver: SkillStepResolver,
  initialState: Record<string, unknown>,
  options?: TextualWorkflowOptions,
): Promise<Record<string, unknown>> {
  // 1. Check named registry first (exact match, case-insensitive)
  if (options?.registry) {
    const namedChain = options.registry.get(text)
    if (namedChain) {
      const executor = buildExecutor(resolver, options)
      return executor.execute(namedChain, initialState, {
        signal: options.signal,
        stateTransformers: options.stateTransformers,
        onProgress: options.onProgress,
      })
    }
  }

  // 2. Parse text
  const parser = options?.parser ?? new WorkflowCommandParser()
  const parseResult = await parser.parseAsync(text)

  if (!parseResult.ok) {
    throw new WorkflowParseError(text, parseResult.reason, parseResult.candidateInterpretations)
  }

  // 3. Build chain from parsed steps
  const chain = createSkillChain(
    text,
    parseResult.steps.map(token => ({ skillName: token.normalized })),
  )

  // 4. Execute
  const executor = buildExecutor(resolver, options)
  return executor.execute(chain, initialState, {
    signal: options?.signal,
    stateTransformers: options?.stateTransformers,
    onProgress: options?.onProgress,
  })
}

/**
 * Parse a textual workflow command and stream its execution events.
 *
 * Mirrors executeTextualWorkflow() but yields WorkflowEvent items as they occur
 * instead of waiting for full completion.
 *
 * Resolution order:
 * 1. options.registry?.get(text) — exact named workflow lookup
 * 2. Parse text via WorkflowCommandParser
 * 3. Build SkillChain → compile → stream via SkillChainExecutor.stream()
 *
 * @throws {WorkflowParseError}    text cannot be parsed into steps
 * @throws {ChainValidationError}  one or more skill IDs cannot be resolved
 */
export async function* streamTextualWorkflow(
  text: string,
  resolver: SkillStepResolver,
  initialState: Record<string, unknown>,
  options?: TextualWorkflowOptions,
): AsyncGenerator<WorkflowEvent> {
  // 1. Check named registry first (exact match, case-insensitive)
  if (options?.registry) {
    const namedChain = options.registry.get(text)
    if (namedChain) {
      const executor = buildExecutor(resolver, options)
      yield* executor.stream(namedChain, initialState, {
        signal: options.signal,
        stateTransformers: options.stateTransformers,
        onProgress: options.onProgress,
      })
      return
    }
  }

  // 2. Parse text
  const parser = options?.parser ?? new WorkflowCommandParser()
  const parseResult = await parser.parseAsync(text)

  if (!parseResult.ok) {
    throw new WorkflowParseError(text, parseResult.reason, parseResult.candidateInterpretations)
  }

  // 3. Build chain from parsed steps
  const chain = createSkillChain(
    text,
    parseResult.steps.map(token => ({ skillName: token.normalized })),
  )

  // 4. Stream
  const executor = buildExecutor(resolver, options)
  yield* executor.stream(chain, initialState, {
    signal: options?.signal,
    stateTransformers: options?.stateTransformers,
    onProgress: options?.onProgress,
  })
}

/**
 * Compile a SkillChain into a reusable CompiledWorkflow.
 *
 * @throws {ChainValidationError} if any skill ID cannot be resolved
 */
export async function createSkillChainWorkflow(
  chain: SkillChain,
  resolver: SkillStepResolver,
  options?: { registry?: SkillRegistry; eventBus?: DzupEventBus },
): Promise<CompiledWorkflow> {
  const executor = new SkillChainExecutor({
    resolver,
    registry: options?.registry ?? emptyRegistry(),
    eventBus: options?.eventBus,
  })
  return executor.compile(chain)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildExecutor(resolver: SkillStepResolver, options?: TextualWorkflowOptions): SkillChainExecutor {
  return new SkillChainExecutor({
    resolver,
    registry: options?.skillRegistry ?? emptyRegistry(),
    eventBus: options?.eventBus,
    logger: options?.logger,
    defaultTimeoutMs: options?.defaultTimeoutMs,
  })
}

/** Minimal stub registry for cases where validation is delegated to resolver.canResolve(). */
function emptyRegistry(): SkillRegistry {
  return new SkillRegistry()
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { SharedAgentSkillResolver } from './skill-step-resolver.js'
export type { SkillStepResolver, SharedAgentSkillResolverConfig } from './skill-step-resolver.js'
export { SkillChainExecutor } from './skill-chain-executor.js'
export type { SkillChainExecutorConfig, ExecuteOptions, DryRunStepInfo, DryRunResult } from './skill-chain-executor.js'
export type { ChainStepInput, ChainStepOutput, ChainFinalState, StateTransformer } from './state-contract.js'
export { SkillNotFoundError, ChainValidationError, ConditionEvaluationError, StepExecutionError, WorkflowParseError } from './errors.js'
export type { CandidateInterpretation } from './errors.js'
