import { DzupAgent } from '@dzupagent/agent'
import { HumanMessage } from '@langchain/core/messages'
import {
  calculateCostCents,
  requireTerminalToolExecutionRunId,
  type TokenUsage,
  type ModelRegistry,
} from '@dzupagent/core'
import { TokenLifecycleManager, createTokenBudget } from '@dzupagent/context'
import type { RunExecutor, RunExecutorResult } from './run-worker.js'
import { resolveAgentTools, type CustomToolResolver, type ToolResolverOptions } from './tool-resolver.js'
import { isStructuredResult } from './utils.js'
import type { TokenLifecycleLike } from '../routes/run-context.js'

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000
const DEFAULT_RESERVED_OUTPUT_TOKENS = 4_096

function resolveModelName(modelTier: string, registry: ModelRegistry): string {
  try {
    const model = registry.getModel(modelTier as 'chat' | 'reasoning' | 'codegen' | 'embedding')
    return (model as unknown as { model?: string }).model ?? modelTier
  } catch {
    return modelTier
  }
}

function toPrompt(input: unknown): string {
  if (typeof input === 'string' && input.trim()) return input
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const direct = ['message', 'content', 'prompt']
      .map((key) => record[key])
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (direct) return direct
    return JSON.stringify(input, null, 2)
  }
  if (input == null) return ''
  return String(input)
}

export interface DzupAgentRunExecutorOptions {
  fallback?: RunExecutor
  toolResolver?: CustomToolResolver
  /** 'strict' throws if any tools remain unresolved; 'lenient' warns (default). */
  resolvePolicy?: ToolResolverOptions['resolvePolicy']
  /** Optional registry to register the per-run TokenLifecycleManager into. */
  tokenLifecycleRegistry?: Map<string, TokenLifecycleLike>
  /** Model context window size (tokens). Default: 200_000 */
  contextWindowTokens?: number
  /** Reserved output tokens. Default: 4_096 */
  reservedOutputTokens?: number
}

/**
 * RunExecutor that executes runs through @dzupagent/agent DzupAgent.
 */
export function createDzupAgentRunExecutor(
  options?: DzupAgentRunExecutorOptions,
): RunExecutor {
  return async (ctx): Promise<RunExecutorResult> => {
    const prompt = toPrompt(ctx.input) || 'Proceed with the requested task.'

    let toolCleanup: (() => Promise<void>) | undefined

    // --- Token lifecycle manager (per-run) ---
    const manager = new TokenLifecycleManager({
      budget: createTokenBudget(
        options?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
        options?.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
      ),
    })
    options?.tokenLifecycleRegistry?.set(ctx.runId, manager)

    // Track prompt tokens up-front so the lifecycle report is meaningful
    // even when the agent flow fails and we fall through to the fallback.
    manager.track('prompt', Math.ceil(prompt.length / 4))

    const persistLifecycleReport = async (): Promise<void> => {
      try {
        // RunStore.update is a shallow merge, so we read existing metadata
        // and spread it to preserve sibling fields (streamMode, chunkCount,
        // etc.) when attaching the token lifecycle report.
        const existing = await ctx.runStore.get(ctx.runId)
        const existingMetadata = (existing?.metadata ?? {}) as Record<string, unknown>
        await ctx.runStore.update(ctx.runId, {
          metadata: {
            ...existingMetadata,
            tokenLifecycleReport: manager.report,
          },
        })
      } catch {
        // non-fatal — metadata persistence is best-effort
      }
    }

    try {
      const resolvedTools = await resolveAgentTools(
        {
          toolNames: ctx.agent.tools,
          metadata: ctx.metadata,
          env: process.env,
        },
        options?.toolResolver,
        { resolvePolicy: options?.resolvePolicy },
      )
      toolCleanup = resolvedTools.cleanup

      // Use router-selected tier from run metadata if available, otherwise use agent definition
      const effectiveModelTier = (
        typeof ctx.metadata?.['modelTier'] === 'string'
          ? ctx.metadata['modelTier']
          : ctx.agent.modelTier
      ) as 'chat' | 'reasoning' | 'codegen' | 'embedding'

      const agent = new DzupAgent({
        id: ctx.agent.id,
        name: ctx.agent.name,
        description: ctx.agent.description,
        instructions: ctx.agent.instructions,
        model: effectiveModelTier,
        registry: ctx.modelRegistry,
        tools: resolvedTools.tools,
      })

      const chunks: string[] = []
      const logs: RunExecutorResult['logs'] = []
      let hitIterationLimit = false
      let tokenExhausted = false
      let tokenExhaustedIterations = 0
      let lastFlushAt = 0
      let totalInputTokens = 0
      let totalOutputTokens = 0
      let activeToolName: string | undefined

      if (resolvedTools.activated.length > 0) {
        logs.push({
          level: 'info',
          phase: 'tools',
          message: 'Activated tools for run',
          data: { tools: resolvedTools.activated },
        })
      }

      if (resolvedTools.unresolved.length > 0) {
        logs.push({
          level: 'warn',
          phase: 'tools',
          message: 'Some requested tools could not be resolved',
          data: { unresolved: resolvedTools.unresolved },
        })
      }

      for (const warning of resolvedTools.warnings) {
        logs.push({
          level: 'warn',
          phase: 'tools',
          message: warning,
        })
      }

      for await (const event of agent.stream([new HumanMessage(prompt)])) {
        if (event.type === 'text') {
          const content = typeof event.data['content'] === 'string' ? event.data['content'] : ''
          if (content) {
            chunks.push(content)
            ctx.eventBus.emit({
              type: 'agent:stream_delta',
              agentId: ctx.agentId,
              runId: ctx.runId,
              content,
            })
            const now = Date.now()
            if (now - lastFlushAt > 250) {
              lastFlushAt = now
              await ctx.runStore.update(ctx.runId, {
                output: { message: chunks.join('') },
              })
            }
          }
          continue
        }

        if (event.type === 'tool_call') {
          const toolName = typeof event.data['name'] === 'string' ? event.data['name'] : 'unknown'
          activeToolName = toolName
          const input = event.data['args']
          logs.push({
            level: 'info',
            phase: 'tool_call',
            message: `Tool called: ${toolName}`,
            data: { input },
          })
          ctx.eventBus.emit({
            type: 'tool:called',
            toolName,
            input: input ?? {},
            executionRunId: ctx.runId,
          } as Parameters<typeof ctx.eventBus.emit>[0])
          continue
        }

        if (event.type === 'tool_result') {
          const toolName = typeof event.data['name'] === 'string' ? event.data['name'] : 'unknown'
          activeToolName = undefined
          const resultStr = typeof event.data['result'] === 'string' ? event.data['result'] : ''
          const executionRunId = requireTerminalToolExecutionRunId({
            eventType: 'tool:result',
            toolName,
            executionRunId: ctx.runId,
          })
          // Tool results become input tokens in the next LLM call
          const toolResultTokens = Math.ceil(resultStr.length / 4)
          totalInputTokens += toolResultTokens
          manager.track('tool-result', toolResultTokens)
          logs.push({
            level: 'info',
            phase: 'tool_result',
            message: `Tool result: ${toolName}`,
            data: { result: event.data['result'] },
          })
          ctx.eventBus.emit({
            type: 'tool:result',
            toolName,
            durationMs: 0,
            executionRunId,
          } as Parameters<typeof ctx.eventBus.emit>[0])
          continue
        }

        if (event.type === 'budget_warning') {
          const message = typeof event.data['message'] === 'string'
            ? event.data['message']
            : 'Budget warning'
          logs.push({
            level: 'warn',
            phase: 'budget',
            message,
          })
          continue
        }

        if (event.type === 'error') {
          const message = typeof event.data['message'] === 'string'
            ? event.data['message']
            : 'Unknown stream error'
          if (activeToolName) {
            const executionRunId = requireTerminalToolExecutionRunId({
              eventType: 'tool:error',
              toolName: activeToolName,
              executionRunId: ctx.runId,
            })
            ctx.eventBus.emit({
              type: 'tool:error',
              toolName: activeToolName,
              errorCode: 'TOOL_EXECUTION_FAILED',
              message,
              executionRunId,
            } as Parameters<typeof ctx.eventBus.emit>[0])
            activeToolName = undefined
          }
          logs.push({
            level: 'error',
            phase: 'agent',
            message,
          })
          throw new Error(message)
        }

        if (event.type === 'done') {
          hitIterationLimit = Boolean(event.data['hitIterationLimit'])
          const stopReason = typeof event.data['stopReason'] === 'string'
            ? event.data['stopReason']
            : undefined
          if (stopReason === 'token_exhausted') {
            tokenExhausted = true
            const iters = event.data['iterations']
            tokenExhaustedIterations = typeof iters === 'number' ? iters : 0
            logs.push({
              level: 'warn',
              phase: 'agent',
              message: 'Run halted due to token exhaustion',
              data: { stopReason, iterations: tokenExhaustedIterations },
            })
            // Emit the halted event on ctx.eventBus so downstream consumers
            // (telemetry, orchestration, OTEL) can react. This mirrors the
            // pattern used inside run-engine.ts. We do NOT throw — token
            // exhaustion is a clean halt, not an error.
            ctx.eventBus.emit({
              type: 'run:halted:token-exhausted',
              agentId: ctx.agentId,
              runId: ctx.runId,
              iterations: tokenExhaustedIterations,
              reason: 'token_exhausted',
            })
          }
          const doneContent = typeof event.data['content'] === 'string' ? event.data['content'] : ''
          if (doneContent && chunks.length === 0) {
            chunks.push(doneContent)
          }
        }
      }

      const content = chunks.join('')
      ctx.eventBus.emit({
        type: 'agent:stream_done',
        agentId: ctx.agentId,
        runId: ctx.runId,
        finalContent: content,
      })

      // Estimate token usage from content length (~4 chars per token)
      // Input: prompt + tool results accumulated during execution
      const promptTokens = Math.ceil(prompt.length / 4)
      totalInputTokens += promptTokens
      totalOutputTokens += Math.ceil(content.length / 4)

      // Track generated output against the lifecycle manager
      manager.track('output', totalOutputTokens)

      const modelTier = effectiveModelTier ?? 'chat'
      const modelName = resolveModelName(modelTier, ctx.modelRegistry)
      const usage: TokenUsage = {
        model: modelName,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      }
      const costCents = calculateCostCents(usage)

      // Persist the final lifecycle report on successful completion.
      await persistLifecycleReport()

      return {
        output: { message: content || '[empty response]' },
        tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
        costCents,
        metadata: {
          streamMode: true,
          chunkCount: chunks.length,
          hitIterationLimit,
          activatedTools: resolvedTools.activated,
          unresolvedTools: resolvedTools.unresolved,
          ...(tokenExhausted
            ? {
                halted: true,
                haltReason: 'token_exhausted',
                haltIterations: tokenExhaustedIterations,
              }
            : {}),
        },
        logs,
      }
    } catch (error) {
      if (options?.fallback) {
        const fallbackResult = await options.fallback(ctx)
        // Persist lifecycle report even on the fallback path so downstream
        // consumers (e.g. /api/runs/:id/context) can see the tokens that
        // were accounted for prior to the failure.
        await persistLifecycleReport()
        if (isStructuredResult(fallbackResult)) {
          return {
            ...fallbackResult,
            metadata: {
              ...(fallbackResult.metadata ?? {}),
              fallbackUsed: true,
              fallbackReason: error instanceof Error ? error.message : String(error),
            },
          }
        }
        return {
          output: fallbackResult,
          metadata: {
            fallbackUsed: true,
            fallbackReason: error instanceof Error ? error.message : String(error),
          },
        }
      }
      // Persist before rethrowing so the terminal run still exposes the report.
      await persistLifecycleReport()
      throw error
    } finally {
      await toolCleanup?.()
      // Deregister the per-run manager from the registry on both success and
      // failure — the persisted `tokenLifecycleReport` metadata takes over as
      // the data source for /api/runs/:id/context after this point.
      options?.tokenLifecycleRegistry?.delete(ctx.runId)
    }
  }
}
