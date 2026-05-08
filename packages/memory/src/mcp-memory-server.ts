/**
 * MCP Memory Server — exposes DzupAgent memory as MCP tool definitions
 * with a dispatcher that maps MCP tool calls to memory operations.
 *
 * This module is transport-agnostic: it provides tool schemas and a handler
 * class. Consumers wire these into their MCP server framework (stdio, HTTP,
 * SSE) using `@modelcontextprotocol/sdk` or any compatible transport.
 *
 * All handlers are non-fatal — errors return `{ isError: true }` results
 * instead of throwing.
 *
 * This file is the coordinator. Implementation details live in:
 *
 *   - `mcp-memory-server-types`      type definitions, helpers, valid rel set
 *   - `mcp-memory-server-tools`      MCP tool catalogue (schemas)
 *   - `mcp-memory-server-dispatcher` per-tool handlers + dispatch table
 */

import {
  errorResult,
  type MCPMemoryServices,
  type MCPToolDefinition,
  type MCPToolResult,
} from './mcp-memory-server-types.js'
import { MCP_MEMORY_TOOLS } from './mcp-memory-server-tools.js'
import { buildDispatchTable } from './mcp-memory-server-dispatcher.js'

// Re-export public types and the tool catalogue so existing callers can
// continue to import everything from `./mcp-memory-server.js` directly.
export type {
  MCPMemoryServices,
  MCPToolDefinition,
  MCPToolResult,
} from './mcp-memory-server-types.js'
export { MCP_MEMORY_TOOLS } from './mcp-memory-server-tools.js'

/**
 * Routes MCP tool calls to DzupAgent memory operations.
 *
 * Usage:
 * ```ts
 * const handler = new MCPMemoryHandler({
 *   memory: memoryService,
 *   temporal: temporalService,
 *   relationships: relationshipStore,
 *   defaultScope: { tenantId: 't1' },
 *   defaultNamespace: 'general',
 * })
 *
 * // Wire into your MCP server framework:
 * server.setToolDefinitions(handler.getTools())
 * server.onToolCall((name, args) => handler.handleToolCall(name, args))
 * ```
 */
export class MCPMemoryHandler {
  private readonly handlers: Map<
    string,
    (args: Record<string, unknown>) => Promise<MCPToolResult>
  >

  constructor(services: MCPMemoryServices) {
    this.handlers = buildDispatchTable(services)
  }

  /** Get all tool definitions for MCP registration. */
  getTools(): MCPToolDefinition[] {
    return MCP_MEMORY_TOOLS
  }

  /**
   * Handle an MCP tool call.
   * Routes to the appropriate memory operation based on tool name.
   * Non-fatal: errors return `{ isError: true }` with error message.
   */
  async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    const handler = this.handlers.get(name)
    if (!handler) {
      return errorResult(`Unknown tool: ${name}`)
    }
    try {
      return await handler(args)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return errorResult(`Tool "${name}" failed: ${message}`)
    }
  }
}
