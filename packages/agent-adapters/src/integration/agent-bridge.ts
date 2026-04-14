/**
 * AgentIntegrationBridge — bridges the adapter layer with tool-based workflows.
 *
 * Enables adapters to be used as tools in DzupAgent workflows and vice versa.
 * Each adapter can be wrapped as a tool with an MCP-compatible schema, allowing
 * any orchestration layer (LangChain, MCP, custom) to invoke adapters uniformly.
 *
 * Deliberately avoids importing from @langchain/core — this is pure TypeScript
 * so any framework can consume these wrappers.
 */

import { ForgeError } from '@dzupagent/core'

import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
  AgentInput,
  TaskDescriptor,
  TokenUsage,
} from '../types.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdapterToolConfig {
  /** The adapter or provider to wrap as a tool */
  providerId: AdapterProviderId
  /** Tool name. Default: `adapter_${providerId}` */
  name?: string | undefined
  /** Tool description */
  description?: string | undefined
  /** Default working directory */
  workingDirectory?: string | undefined
  /** Default system prompt */
  systemPrompt?: string | undefined
  /** Max turns per invocation */
  maxTurns?: number | undefined
  /** Budget limit per invocation in USD */
  maxBudgetUsd?: number | undefined
}

export interface ToolInvocationResult {
  result: string
  providerId: AdapterProviderId
  durationMs: number
  success: boolean
  usage?: TokenUsage | undefined
  error?: string | undefined
}

export interface AdapterToolSchema {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
}

export interface ToolInvocationArgs {
  prompt: string
  workingDirectory?: string | undefined
  systemPrompt?: string | undefined
}

function resolveRegistryProviderId(registry: AdapterRegistry): AdapterProviderId {
  return registry.listAdapters()[0] ?? ('unknown' as AdapterProviderId)
}

// ---------------------------------------------------------------------------
// AdapterAsToolWrapper
// ---------------------------------------------------------------------------

/**
 * Wraps an adapter (via the registry) so it can be invoked as a tool
 * from other systems. Produces an MCP-compatible schema and handles
 * the full execute-and-collect lifecycle.
 */
export class AdapterAsToolWrapper {
  private readonly toolName: string
  private readonly toolDescription: string

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly config: AdapterToolConfig,
  ) {
    this.toolName = config.name ?? `adapter_${config.providerId}`
    this.toolDescription =
      config.description ??
      `Invoke the ${config.providerId} AI agent adapter to execute a task.`
  }

  /** Get the tool name */
  get name(): string {
    return this.toolName
  }

  /** Get the tool description */
  get description(): string {
    return this.toolDescription
  }

  /** Get the tool schema (MCP-compatible) */
  getSchema(): AdapterToolSchema {
    return {
      name: this.toolName,
      description: this.toolDescription,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The prompt or instruction to send to the adapter',
          },
          workingDirectory: {
            type: 'string',
            description: 'Working directory for file operations (optional)',
          },
          systemPrompt: {
            type: 'string',
            description: 'System prompt override (optional)',
          },
        },
        required: ['prompt'],
      },
    }
  }

  /** Invoke the adapter as a tool */
  async invoke(args: ToolInvocationArgs): Promise<ToolInvocationResult> {
    const startMs = Date.now()
    const providerId = this.config.providerId

    // Get a healthy adapter from the registry
    const adapter = this.registry.getHealthy(providerId)
    if (!adapter) {
      return {
        result: '',
        providerId,
        durationMs: Date.now() - startMs,
        success: false,
        error: `Adapter "${providerId}" is not available or circuit breaker is open`,
      }
    }

    // Build AgentInput from args + config defaults
    const input: AgentInput = {
      prompt: args.prompt,
      workingDirectory: args.workingDirectory ?? this.config.workingDirectory,
      systemPrompt: args.systemPrompt ?? this.config.systemPrompt,
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.maxBudgetUsd,
    }

    try {
      const eventStream: AsyncGenerator<AgentEvent, void, undefined> =
        adapter.execute(input)

      let resultText = ''
      let resultUsage: TokenUsage | undefined

      for await (const event of eventStream) {
        if (event.type === 'adapter:completed') {
          const completed = event as AgentCompletedEvent
          resultText = completed.result
          resultUsage = completed.usage
        } else if (event.type === 'adapter:failed') {
          const failed = event as AgentFailedEvent
          // Don't return immediately — there may be fallback events following.
          // Record the error but keep consuming in case a later event succeeds.
          if (!resultText) {
            return {
              result: '',
              providerId,
              durationMs: Date.now() - startMs,
              success: false,
              usage: resultUsage,
              error: failed.error,
            }
          }
        }
      }

      // Record success with the registry's circuit breaker
      this.registry.recordSuccess(providerId)

      return {
        result: resultText,
        providerId,
        durationMs: Date.now() - startMs,
        success: true,
        usage: resultUsage,
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))

      // Record failure with the registry's circuit breaker
      this.registry.recordFailure(providerId, error)

      return {
        result: '',
        providerId,
        durationMs: Date.now() - startMs,
        success: false,
        error: error.message,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RoutedToolWrapper (internal)
// ---------------------------------------------------------------------------

/**
 * Internal wrapper that uses the registry's routing to pick the best adapter.
 * Presented as a single "agent" tool to the caller.
 */
class RoutedToolWrapper extends AdapterAsToolWrapper {
  constructor(
    private readonly routedRegistry: AdapterRegistry,
    config: {
      name?: string | undefined
      description?: string | undefined
      tags?: string[] | undefined
    },
  ) {
    // We pass a dummy providerId since routing is dynamic.
    // The invoke() override below handles the actual provider selection.
    const firstAdapter = routedRegistry.listAdapters()[0]
    if (!firstAdapter) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: 'Cannot create routed tool: no adapters registered',
        recoverable: false,
      })
    }

    super(routedRegistry, {
      providerId: firstAdapter,
      name: config.name ?? 'agent',
      description:
        config.description ??
        'Invoke the best available AI agent adapter for a task. Automatically routes to the most suitable provider.',
    })

    this.tags = config.tags ?? []
  }

  private readonly tags: string[]

  override getSchema(): AdapterToolSchema {
    return {
      name: this.name,
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The prompt or instruction to send to the best available adapter',
          },
          workingDirectory: {
            type: 'string',
            description: 'Working directory for file operations (optional)',
          },
          systemPrompt: {
            type: 'string',
            description: 'System prompt override (optional)',
          },
        },
        required: ['prompt'],
      },
    }
  }

  override async invoke(args: ToolInvocationArgs): Promise<ToolInvocationResult> {
    const startMs = Date.now()

    const input: AgentInput = {
      prompt: args.prompt,
      workingDirectory: args.workingDirectory,
      systemPrompt: args.systemPrompt,
    }

    const task: TaskDescriptor = {
      prompt: args.prompt,
      tags: this.tags,
      workingDirectory: args.workingDirectory,
    }

    try {
      const eventStream: AsyncGenerator<AgentEvent, void, undefined> =
        this.routedRegistry.executeWithFallback(input, task)

      let resultText = ''
      let resultProviderId = resolveRegistryProviderId(this.routedRegistry)
      let resultUsage: TokenUsage | undefined

      for await (const event of eventStream) {
        if (event.type === 'adapter:completed') {
          const completed = event as AgentCompletedEvent
          resultText = completed.result
          resultProviderId = completed.providerId
          resultUsage = completed.usage
        }
      }

      return {
        result: resultText,
        providerId: resultProviderId,
        durationMs: Date.now() - startMs,
        success: true,
        usage: resultUsage,
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))

      // Determine which provider was attempted (best effort)
      const providerId = resolveRegistryProviderId(this.routedRegistry)

      return {
        result: '',
        providerId,
        durationMs: Date.now() - startMs,
        success: false,
        error: error.message,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AgentIntegrationBridge
// ---------------------------------------------------------------------------

/**
 * Main bridge class that creates tool wrappers for all adapters.
 *
 * @example
 * ```ts
 * const bridge = new AgentIntegrationBridge(registry)
 *
 * // Single tool for a specific adapter
 * const claudeTool = bridge.createTool({ providerId: 'claude' })
 * const result = await claudeTool.invoke({ prompt: 'Fix the test' })
 *
 * // All adapters as tools
 * const tools = bridge.createAllTools()
 *
 * // MCP descriptors for tool sharing
 * const descriptors = bridge.getMCPDescriptors()
 *
 * // Auto-routed composite tool
 * const agentTool = bridge.createRoutedTool({ name: 'agent' })
 * const routed = await agentTool.invoke({ prompt: 'Review this PR' })
 * ```
 */
export class AgentIntegrationBridge {
  constructor(private readonly registry: AdapterRegistry) {}

  /**
   * Create a tool wrapper for a specific adapter.
   */
  createTool(config: AdapterToolConfig): AdapterAsToolWrapper {
    const adapter = this.registry.get(config.providerId)
    if (!adapter) {
      throw new ForgeError({
        code: 'REGISTRY_AGENT_NOT_FOUND',
        message: `Adapter "${config.providerId}" is not registered in the registry`,
        recoverable: false,
        suggestion: `Register the adapter before creating a tool wrapper: registry.register(adapter)`,
      })
    }

    return new AdapterAsToolWrapper(this.registry, config)
  }

  /**
   * Create tool wrappers for all registered adapters.
   */
  createAllTools(defaults?: Partial<AdapterToolConfig>): AdapterAsToolWrapper[] {
    const adapterIds = this.registry.listAdapters()

    return adapterIds.map((providerId) =>
      new AdapterAsToolWrapper(this.registry, {
        ...defaults,
        providerId,
        name: defaults?.name ? `${defaults.name}_${providerId}` : undefined,
      }),
    )
  }

  /**
   * Get MCP-compatible tool descriptors for all adapter tools.
   * Can be used with MCPToolSharingBridge.
   */
  getMCPDescriptors(defaults?: Partial<AdapterToolConfig>): AdapterToolSchema[] {
    const tools = this.createAllTools(defaults)
    return tools.map((tool) => tool.getSchema())
  }

  /**
   * Create a composite tool that auto-routes to the best adapter.
   * This is a single tool named 'agent' that routes based on the prompt
   * content and the registry's configured routing strategy.
   */
  createRoutedTool(config?: {
    name?: string | undefined
    description?: string | undefined
    tags?: string[] | undefined
  }): AdapterAsToolWrapper {
    return new RoutedToolWrapper(this.registry, config ?? {})
  }
}
