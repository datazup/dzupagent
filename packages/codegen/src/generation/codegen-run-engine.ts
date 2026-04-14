/**
 * CodegenRunEngine — bridges code generation through adapter-level
 * policy, approval, telemetry, and routing when an AgentCLIAdapter
 * is available. Falls back to direct ModelRegistry invocation via
 * CodeGenService when no adapter is provided.
 *
 * This resolves Gap 4 (P0): CodeGenService directly invokes
 * ModelRegistry.getModel/model.invoke, bypassing adapter-level concerns.
 */
import {
  requireTerminalToolExecutionRunId,
  type ModelRegistry,
  type ModelTier,
  type DzupEventBus,
  type TokenUsage,
} from '@dzupagent/core'
import type {
  AgentCLIAdapter,
  AgentInput,
  AgentEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  TokenUsage as AdapterTokenUsage,
} from '@dzupagent/adapter-types'
import { CodeGenService } from './code-gen-service.js'
import type { GenerateFileParams, GenerateFileResult } from './code-gen-service.js'
import { extractLargestCodeBlock, detectLanguage } from './code-block-parser.js'

/** Configuration for CodegenRunEngine */
export interface CodegenRunEngineConfig {
  /** Adapter to use for generation. When provided, generation routes through the adapter. */
  adapter?: AgentCLIAdapter
  /** Model registry for direct LLM invocation (fallback path). */
  registry?: ModelRegistry
  /** Model tier for the fallback CodeGenService path. */
  modelTier?: ModelTier
  /** Optional event bus for emitting normalized run events. */
  eventBus?: DzupEventBus
  /** Working directory passed to the adapter. */
  workingDirectory?: string
  /** Max turns for adapter execution (default: 1 for single-shot generation). */
  maxTurns?: number
}

/**
 * Builds the user message for a generation request.
 * Extracted so both adapter and fallback paths produce identical prompts.
 */
function buildUserMessage(params: GenerateFileParams): string {
  const language = detectLanguage(params.filePath)
  let userMessage = `Generate the file: ${params.filePath}\nPurpose: ${params.purpose}\nLanguage: ${language}`

  if (params.referenceFiles && Object.keys(params.referenceFiles).length > 0) {
    const refs = Object.entries(params.referenceFiles)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join('\n\n')
    userMessage += `\n\n## Reference Files\n\n${refs}`
  }

  if (params.context && Object.keys(params.context).length > 0) {
    const ctx = Object.entries(params.context)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n')
    userMessage += `\n\n## Context\n\n${ctx}`
  }

  userMessage += `\n\nGenerate the complete file content. Wrap the code in a markdown code block with the appropriate language tag.`

  return userMessage
}

/** Convert adapter token usage to core TokenUsage format */
function toCoreTokUsage(adapterUsage: AdapterTokenUsage | undefined): TokenUsage {
  return {
    model: 'adapter',
    inputTokens: adapterUsage?.inputTokens ?? 0,
    outputTokens: adapterUsage?.outputTokens ?? 0,
  }
}

/**
 * CodegenRunEngine — primary code generation entry point.
 *
 * When an `AgentCLIAdapter` is configured, generation is routed through
 * the adapter, inheriting adapter-level policy (approval gates, telemetry,
 * cost routing, etc.). When no adapter is available, it falls back to
 * `CodeGenService` which calls `ModelRegistry.getModel()` directly.
 */
export class CodegenRunEngine {
  private readonly fallbackService: CodeGenService | undefined
  private readonly adapter: AgentCLIAdapter | undefined
  private readonly eventBus: DzupEventBus | undefined
  private readonly workingDirectory: string | undefined
  private readonly maxTurns: number

  constructor(config: CodegenRunEngineConfig) {
    this.adapter = config.adapter
    this.eventBus = config.eventBus
    this.workingDirectory = config.workingDirectory
    this.maxTurns = config.maxTurns ?? 1

    if (config.registry) {
      const serviceOpts: { modelTier?: ModelTier } = {}
      if (config.modelTier !== undefined) serviceOpts.modelTier = config.modelTier
      this.fallbackService = new CodeGenService(config.registry, serviceOpts)
    }

    if (!this.adapter && !this.fallbackService) {
      throw new Error(
        'CodegenRunEngine requires either an adapter or a registry. Provide at least one.',
      )
    }
  }

  /** Whether this engine is using the adapter path. */
  get usesAdapter(): boolean {
    return this.adapter !== undefined
  }

  /**
   * Generate a single source file.
   *
   * Routes through the adapter when available; otherwise falls back
   * to direct ModelRegistry invocation via CodeGenService.
   */
  async generateFile(
    params: GenerateFileParams,
    systemPrompt: string,
  ): Promise<GenerateFileResult> {
    if (this.adapter) {
      return this.generateViaAdapter(params, systemPrompt)
    }

    // Fallback to CodeGenService (direct ModelRegistry path)
    return this.fallbackService!.generateFile(params, systemPrompt)
  }

  /**
   * Generate a file by routing the request through an AgentCLIAdapter.
   * Consumes the async event stream and extracts the completed result.
   */
  private async generateViaAdapter(
    params: GenerateFileParams,
    systemPrompt: string,
  ): Promise<GenerateFileResult> {
    const adapter = this.adapter!
    const language = detectLanguage(params.filePath)
    const userMessage = buildUserMessage(params)

    const agentInput: AgentInput = {
      prompt: userMessage,
      systemPrompt,
      maxTurns: this.maxTurns,
    }
    if (this.workingDirectory !== undefined) {
      agentInput.workingDirectory = this.workingDirectory
    }

    let completedEvent: AgentCompletedEvent | undefined
    let failedEvent: AgentFailedEvent | undefined
    let activeExecutionRunId: string | undefined
    let activeToolName: string | undefined

    for await (const event of adapter.execute(agentInput)) {
      if (event.type === 'adapter:started') {
        activeExecutionRunId = event.sessionId
      } else if (event.type === 'adapter:completed') {
        activeExecutionRunId = event.sessionId
      } else if (event.type === 'adapter:failed' && event.sessionId) {
        activeExecutionRunId = event.sessionId
      } else if (event.type === 'adapter:tool_call') {
        activeToolName = event.toolName
      } else if (event.type === 'adapter:tool_result') {
        activeToolName = undefined
      }

      this.forwardEvent(event, {
        fallbackExecutionRunId: activeExecutionRunId,
        activeToolName,
      })

      if (event.type === 'adapter:completed') {
        completedEvent = event
      } else if (event.type === 'adapter:failed') {
        failedEvent = event
      }
    }

    if (failedEvent) {
      throw new Error(
        `Adapter generation failed (${adapter.providerId}): ${failedEvent.error}`,
      )
    }

    if (!completedEvent) {
      throw new Error(
        `Adapter ${adapter.providerId} finished without a completed event`,
      )
    }

    const content = extractLargestCodeBlock(completedEvent.result)
    const tokensUsed = toCoreTokUsage(completedEvent.usage)

    return {
      content,
      source: 'llm',
      tokensUsed,
      language,
    }
  }

  /**
   * Forward an adapter event to the event bus as a normalized DzupEvent
   * when the event bus is available.
   */
  private forwardEvent(
    event: AgentEvent,
    options?: {
      fallbackExecutionRunId?: string
      activeToolName?: string
    },
  ): void {
    if (!this.eventBus) return

    const fallbackExecutionRunId = options?.fallbackExecutionRunId

    switch (event.type) {
      case 'adapter:started':
        this.eventBus.emit({
          type: 'agent:started',
          agentId: `codegen:${event.providerId}`,
          runId: event.sessionId,
        })
        break
      case 'adapter:completed':
        this.eventBus.emit({
          type: 'agent:completed',
          agentId: `codegen:${event.providerId}`,
          runId: event.sessionId,
          durationMs: event.durationMs,
        })
        break
      case 'adapter:failed':
        if (options?.activeToolName) {
          const executionRunId = requireTerminalToolExecutionRunId({
            eventType: 'tool:error',
            toolName: options.activeToolName,
            executionRunId: event.correlationId,
            fallbackExecutionRunId,
          })

          this.eventBus.emit({
            type: 'tool:error',
            toolName: options.activeToolName,
            errorCode: 'TOOL_EXECUTION_FAILED',
            message: event.error,
            executionRunId,
          } as Parameters<DzupEventBus['emit']>[0])
        }
        this.eventBus.emit({
          type: 'agent:failed',
          agentId: `codegen:${event.providerId}`,
          runId: event.sessionId ?? 'unknown',
          errorCode: 'PROVIDER_UNAVAILABLE',
          message: event.error,
        })
        break
      case 'adapter:stream_delta':
        this.eventBus.emit({
          type: 'agent:stream_delta',
          agentId: `codegen:${event.providerId}`,
          runId: 'codegen',
          content: event.content,
        })
        break
      case 'adapter:tool_call':
        this.eventBus.emit({
          type: 'tool:called',
          toolName: event.toolName,
          input: event.input,
          executionRunId: fallbackExecutionRunId ?? event.correlationId,
        } as Parameters<DzupEventBus['emit']>[0])
        break
      case 'adapter:tool_result':
        {
          const executionRunId = requireTerminalToolExecutionRunId({
            eventType: 'tool:result',
            toolName: event.toolName,
            executionRunId: event.correlationId,
            fallbackExecutionRunId,
          })

          this.eventBus.emit({
            type: 'tool:result',
            toolName: event.toolName,
            durationMs: event.durationMs,
            executionRunId,
          } as Parameters<DzupEventBus['emit']>[0])
          break
        }
      // adapter:message and adapter:progress have no direct DzupEvent mapping — skip
      default:
        break
    }
  }
}
