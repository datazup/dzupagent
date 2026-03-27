/**
 * Deferred MCP tool loader.
 *
 * Implements Claude Code's strategy: when an MCP server exposes too many
 * tools (exceeding a context budget threshold), only tool names are loaded
 * initially. Full schemas are fetched on-demand when the agent actually
 * needs a specific tool.
 *
 * This prevents context window bloat from large tool sets while keeping
 * all tools discoverable.
 */
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { MCPClient } from './mcp-client.js'
import { mcpToolToLangChain } from './mcp-tool-bridge.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeferredLoaderConfig {
  /**
   * Maximum percentage of estimated context budget that tools can consume.
   * When exceeded, excess tools are deferred. (default: 0.10 = 10%)
   */
  maxToolBudgetRatio: number

  /**
   * Estimated tokens per tool definition (for budget calculation).
   * (default: 150 tokens per tool)
   */
  tokensPerTool: number

  /**
   * Total context window size in tokens (for budget calculation).
   * (default: 128_000)
   */
  contextWindowTokens: number
}

const DEFAULTS: DeferredLoaderConfig = {
  maxToolBudgetRatio: 0.10,
  tokensPerTool: 150,
  contextWindowTokens: 128_000,
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export class DeferredToolLoader {
  private readonly config: DeferredLoaderConfig
  private readonly client: MCPClient
  /** Cache of already-converted LangChain tools */
  private readonly toolCache = new Map<string, StructuredToolInterface>()

  constructor(client: MCPClient, config?: Partial<DeferredLoaderConfig>) {
    this.client = client
    this.config = { ...DEFAULTS, ...config }
  }

  /**
   * Calculate how many tools can be loaded eagerly within budget.
   */
  get maxEagerTools(): number {
    const budgetTokens = this.config.contextWindowTokens * this.config.maxToolBudgetRatio
    return Math.floor(budgetTokens / this.config.tokensPerTool)
  }

  /**
   * Get eagerly-loaded tools as LangChain tools.
   * These have full schemas and are ready for the agent loop.
   */
  getEagerTools(): StructuredToolInterface[] {
    const descriptors = this.client.getEagerTools()
    return descriptors.map(d => {
      const cached = this.toolCache.get(d.name)
      if (cached) return cached

      const converted = mcpToolToLangChain(d, this.client)
      this.toolCache.set(d.name, converted)
      return converted
    })
  }

  /**
   * Get a summary of deferred tools (names + descriptions only).
   * Useful for injecting into the system prompt so the agent knows
   * what's available without loading full schemas.
   */
  getDeferredToolSummary(): string {
    const deferred = this.client.getDeferredToolNames()
    if (deferred.length === 0) return ''

    const lines = [
      `## Deferred Tools (${deferred.length} available)`,
      '',
      'The following tools are available but not loaded. Ask to use one by name and it will be loaded:',
      '',
    ]

    // Get full descriptors for descriptions
    for (const { name } of deferred) {
      const descriptor = this.client.findTool(name)
      if (descriptor) {
        lines.push(`- **${name}**: ${descriptor.description}`)
      } else {
        lines.push(`- **${name}**`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Load a deferred tool by name and return it as a LangChain tool.
   * Returns null if the tool is not found or not deferred.
   */
  loadTool(toolName: string): StructuredToolInterface | null {
    // Check cache first
    const cached = this.toolCache.get(toolName)
    if (cached) return cached

    // Try to load from deferred
    const descriptor = this.client.loadDeferredTool(toolName)
    if (!descriptor) return null

    const converted = mcpToolToLangChain(descriptor, this.client)
    this.toolCache.set(toolName, converted)
    return converted
  }

  /**
   * Check if a tool name matches any deferred tool.
   * Useful for intercepting agent requests for unknown tools.
   */
  isDeferredTool(toolName: string): boolean {
    return this.client.getDeferredToolNames().some(t => t.name === toolName)
  }

  /**
   * Clear the tool cache (e.g., after reconnecting).
   */
  clearCache(): void {
    this.toolCache.clear()
  }
}
