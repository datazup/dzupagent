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
import { logError, type FrameworkLogger } from './error-log.js'

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

  /** Sink for structured error lines. Defaults to the console logger. */
  private readonly logger: FrameworkLogger | undefined

  constructor(services: MCPMemoryServices & { logger?: FrameworkLogger }) {
    this.logger = services.logger
    // AG-02: Enforce tenantId at construction time so every tool call is
    // automatically scoped to the correct tenant.  Fail fast rather than
    // silently allowing cross-tenant reads during a session.
    const tid = services.defaultScope?.tenantId
    if (!tid || typeof tid !== 'string' || tid.trim() === '') {
      throw new Error(
        'MCPMemoryHandler: services.defaultScope.tenantId is required and must be a non-empty string. ' +
        'Omitting it would allow cross-tenant memory access (AG-02).',
      )
    }
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
      // ERR-C-22: never place a raw backend error into the tool result — it
      // goes straight into the model's context. A Postgres/Redis driver error
      // can carry connection strings, hosts and table names, and an
      // HTTP-backed error can carry an attacker-controlled remote response
      // body (a prompt-injection channel). Log the full detail server-side and
      // return an opaque correlation id instead.
      const errorId = logError({
        component: 'mcp-memory-server',
        operation: `handleToolCall:${name}`,
        error: err,
        logger: this.logger,
      })
      return errorResult(
        `Tool "${name}" failed (ref: ${errorId}). The memory backend is temporarily unavailable. ` +
        'No further detail is available to this tool; ask an operator to look up the reference id.',
      )
    }
  }
}
