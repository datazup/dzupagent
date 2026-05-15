/**
 * Public types and small shared helpers for the MCP memory server.
 *
 * Lives in its own module so the tool catalogue (`mcp-memory-server-tools`)
 * and dispatcher (`mcp-memory-server-dispatcher`) can depend on it without
 * pulling in each other.
 */
import type { MemoryService } from './memory-service.js'
import type { TemporalMemoryService } from './temporal.js'
import type { RelationshipStore } from './retrieval/relationship-store.js'

/** MCP tool definition (matches MCP spec). */
export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, {
      type: string
      description: string
      enum?: string[]
      default?: unknown
    }>
    required: string[]
  }
}

/** Result from an MCP tool invocation. */
export interface MCPToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean | undefined
}

/**
 * Services needed by the MCP memory handler.
 *
 * `defaultScope` MUST include a non-empty `tenantId`.  The
 * `MCPMemoryHandler` constructor enforces this at runtime so that every
 * tool invocation is automatically isolated to the correct tenant and
 * cross-tenant reads are structurally impossible (AG-02).
 */
export interface MCPMemoryServices {
  memory: MemoryService
  temporal?: TemporalMemoryService | undefined
  relationships?: RelationshipStore | undefined
  /**
   * Default scope applied to every memory operation.
   * Must carry a non-empty `tenantId` — omitting it or passing an empty
   * string will cause `MCPMemoryHandler` to throw at construction time.
   */
  defaultScope: { readonly tenantId: string } & Record<string, string>
  /** Default namespace */
  defaultNamespace: string
}

/**
 * Set of relationship types accepted by `memory_relate` and `memory_traverse`.
 * Mirrors the `enum` defined in the tool catalogue so dispatcher input
 * validation stays in sync with the schema advertised to LLMs.
 */
export const VALID_RELATIONSHIP_TYPES: ReadonlySet<string> = new Set([
  'causes', 'prevents', 'triggers',
  'solves', 'alternative_to', 'improves',
  'builds_on', 'contradicts', 'confirms', 'supersedes',
  'depends_on', 'enables', 'blocks', 'follows',
  'preferred_over', 'deprecated_by',
])

/** Wrap a JSON-serializable value into a successful MCP tool result. */
export function successResult(data: unknown): MCPToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }
}

/** Wrap a string message into a failed MCP tool result. */
export function errorResult(message: string): MCPToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

/** Coerce an unknown value into a non-empty string, or fall back. */
export function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/** Coerce an unknown value into a finite number, or fall back. */
export function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
