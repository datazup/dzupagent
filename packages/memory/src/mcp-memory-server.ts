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
 */

import type { MemoryService } from './memory-service.js'
import type { TemporalMemoryService } from './temporal.js'
import type { RelationshipStore, RelationshipType, RelationshipEdge } from './retrieval/relationship-store.js'
import { healMemory } from './memory-healer.js'
import type { HealingReport } from './memory-healer.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

/** Services needed by the MCP memory handler. */
export interface MCPMemoryServices {
  memory: MemoryService
  temporal?: TemporalMemoryService | undefined
  relationships?: RelationshipStore | undefined
  /** Default scope for all operations */
  defaultScope: Record<string, string>
  /** Default namespace */
  defaultNamespace: string
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const MCP_MEMORY_TOOLS: MCPToolDefinition[] = [
  {
    name: 'memory_store',
    description: 'Store a new memory. Provide text content and optional category/tags.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Unique key for this memory' },
        text: { type: 'string', description: 'Memory content text' },
        category: {
          type: 'string',
          description: 'Category: fact, preference, decision, convention, constraint',
          enum: ['fact', 'preference', 'decision', 'convention', 'constraint'],
        },
        namespace: { type: 'string', description: 'Namespace (uses default if omitted)' },
      },
      required: ['key', 'text'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search memories by semantic similarity. Returns top matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
        namespace: { type: 'string', description: 'Namespace to search (uses default if omitted)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_recall',
    description: 'Recall a specific memory by its key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key to recall' },
        namespace: { type: 'string', description: 'Namespace (uses default if omitted)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'memory_list',
    description: 'List all memories in a namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to list (uses default if omitted)' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory by key. If temporal memory is enabled, soft-expires instead of hard-deleting.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key to delete' },
        namespace: { type: 'string', description: 'Namespace (uses default if omitted)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'memory_health',
    description: 'Run a health check on memory: detect duplicates, contradictions, and stale entries.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to check (uses default if omitted)' },
      },
      required: [],
    },
  },
  {
    name: 'memory_relate',
    description: 'Create a typed relationship between two memories.',
    inputSchema: {
      type: 'object',
      properties: {
        fromKey: { type: 'string', description: 'Source memory key' },
        toKey: { type: 'string', description: 'Target memory key' },
        type: {
          type: 'string',
          description: 'Relationship type',
          enum: [
            'causes', 'prevents', 'triggers',
            'solves', 'alternative_to', 'improves',
            'builds_on', 'contradicts', 'confirms', 'supersedes',
            'depends_on', 'enables', 'blocks', 'follows',
            'preferred_over', 'deprecated_by',
          ],
        },
        evidence: { type: 'string', description: 'Evidence or reason for this relationship' },
      },
      required: ['fromKey', 'toKey', 'type'],
    },
  },
  {
    name: 'memory_traverse',
    description: 'Traverse memory relationships from a starting point. Finds connected memories via typed edges.',
    inputSchema: {
      type: 'object',
      properties: {
        startKey: { type: 'string', description: 'Starting memory key' },
        types: { type: 'string', description: 'Comma-separated relationship types to follow (or "all")' },
        maxHops: { type: 'number', description: 'Max traversal depth (default: 2)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: ['startKey'],
    },
  },
  {
    name: 'memory_history',
    description: 'Get the temporal history of a memory key (requires temporal memory).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key prefix to get history for' },
        namespace: { type: 'string', description: 'Namespace (uses default if omitted)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'memory_stats',
    description: 'Get memory statistics: record counts, namespace info, relationship counts.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace for stats (uses default if omitted)' },
      },
      required: [],
    },
  },
]

// ---------------------------------------------------------------------------
// Valid relationship types for runtime validation
// ---------------------------------------------------------------------------

const VALID_RELATIONSHIP_TYPES: ReadonlySet<string> = new Set([
  'causes', 'prevents', 'triggers',
  'solves', 'alternative_to', 'improves',
  'builds_on', 'contradicts', 'confirms', 'supersedes',
  'depends_on', 'enables', 'blocks', 'follows',
  'preferred_over', 'deprecated_by',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResult(data: unknown): MCPToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }
}

function errorResult(message: string): MCPToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// ---------------------------------------------------------------------------
// MCPMemoryHandler
// ---------------------------------------------------------------------------

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
  private readonly handlers: Map<string, (args: Record<string, unknown>) => Promise<MCPToolResult>>

  constructor(private readonly services: MCPMemoryServices) {
    this.handlers = new Map([
      ['memory_store', (a) => this.handleStore(a)],
      ['memory_search', (a) => this.handleSearch(a)],
      ['memory_recall', (a) => this.handleRecall(a)],
      ['memory_list', (a) => this.handleList(a)],
      ['memory_delete', (a) => this.handleDelete(a)],
      ['memory_health', (a) => this.handleHealth(a)],
      ['memory_relate', (a) => this.handleRelate(a)],
      ['memory_traverse', (a) => this.handleTraverse(a)],
      ['memory_history', (a) => this.handleHistory(a)],
      ['memory_stats', (a) => this.handleStats(a)],
    ])
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

  // -----------------------------------------------------------------------
  // Individual handlers
  // -----------------------------------------------------------------------

  private ns(args: Record<string, unknown>): string {
    return asString(args['namespace'], this.services.defaultNamespace)
  }

  private get scope(): Record<string, string> {
    return this.services.defaultScope
  }

  private async handleStore(args: Record<string, unknown>): Promise<MCPToolResult> {
    const key = args['key']
    const text = args['text']
    if (typeof key !== 'string' || key.length === 0) {
      return errorResult('Missing required parameter: key')
    }
    if (typeof text !== 'string' || text.length === 0) {
      return errorResult('Missing required parameter: text')
    }

    const value: Record<string, unknown> = { text }
    const category = args['category']
    if (typeof category === 'string' && category.length > 0) {
      value['category'] = category
    }
    value['storedAt'] = Date.now()

    await this.services.memory.put(this.ns(args), this.scope, key, value)
    return successResult({ stored: true, key, namespace: this.ns(args) })
  }

  private async handleSearch(args: Record<string, unknown>): Promise<MCPToolResult> {
    const query = args['query']
    if (typeof query !== 'string' || query.length === 0) {
      return errorResult('Missing required parameter: query')
    }
    const limit = asNumber(args['limit'], 5)
    const results = await this.services.memory.search(this.ns(args), this.scope, query, limit)
    return successResult({ query, count: results.length, results })
  }

  private async handleRecall(args: Record<string, unknown>): Promise<MCPToolResult> {
    const key = args['key']
    if (typeof key !== 'string' || key.length === 0) {
      return errorResult('Missing required parameter: key')
    }
    const results = await this.services.memory.get(this.ns(args), this.scope, key)
    if (results.length === 0) {
      return successResult({ found: false, key })
    }
    return successResult({ found: true, key, value: results[0] })
  }

  private async handleList(args: Record<string, unknown>): Promise<MCPToolResult> {
    const records = await this.services.memory.get(this.ns(args), this.scope)
    const limit = asNumber(args['limit'], 20)
    const trimmed = records.slice(0, limit)
    return successResult({ namespace: this.ns(args), count: trimmed.length, total: records.length, records: trimmed })
  }

  private async handleDelete(args: Record<string, unknown>): Promise<MCPToolResult> {
    const key = args['key']
    if (typeof key !== 'string' || key.length === 0) {
      return errorResult('Missing required parameter: key')
    }
    if (!this.services.temporal) {
      return errorResult('Temporal memory not configured — soft-delete unavailable. Hard-delete is not supported to preserve memory integrity.')
    }
    await this.services.temporal.expire(this.ns(args), this.scope, key)
    return successResult({ expired: true, key, namespace: this.ns(args) })
  }

  private async handleHealth(args: Record<string, unknown>): Promise<MCPToolResult> {
    const records = await this.services.memory.get(this.ns(args), this.scope)

    // Transform records into the shape healMemory expects
    const healable = records.map((r, idx) => {
      const key = typeof r['key'] === 'string' ? r['key'] : `record_${idx}`
      const text = typeof r['text'] === 'string' ? r['text'] : JSON.stringify(r)
      const lastAccessedAt = typeof r['lastAccessedAt'] === 'number' ? r['lastAccessedAt'] : undefined
      return { key, text, ...(lastAccessedAt !== undefined ? { lastAccessedAt } : {}) }
    })

    const report: HealingReport = healMemory(healable)
    return successResult({
      namespace: this.ns(args),
      ...report,
    })
  }

  private async handleRelate(args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.services.relationships) {
      return errorResult('Relationship store not configured')
    }

    const fromKey = args['fromKey']
    const toKey = args['toKey']
    const relType = args['type']

    if (typeof fromKey !== 'string' || fromKey.length === 0) {
      return errorResult('Missing required parameter: fromKey')
    }
    if (typeof toKey !== 'string' || toKey.length === 0) {
      return errorResult('Missing required parameter: toKey')
    }
    if (typeof relType !== 'string' || !VALID_RELATIONSHIP_TYPES.has(relType)) {
      return errorResult(`Invalid relationship type: ${String(relType)}. Valid types: ${[...VALID_RELATIONSHIP_TYPES].join(', ')}`)
    }

    const edge: RelationshipEdge = {
      fromKey,
      toKey,
      type: relType as RelationshipType,
      createdAt: Date.now(),
    }

    const evidence = args['evidence']
    if (typeof evidence === 'string' && evidence.length > 0) {
      edge.metadata = { confidence: 1.0, evidence }
    }

    await this.services.relationships.addEdge(edge)
    return successResult({ related: true, fromKey, toKey, type: relType })
  }

  private async handleTraverse(args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.services.relationships) {
      return errorResult('Relationship store not configured')
    }

    const startKey = args['startKey']
    if (typeof startKey !== 'string' || startKey.length === 0) {
      return errorResult('Missing required parameter: startKey')
    }

    const maxHops = asNumber(args['maxHops'], 2)
    const limit = asNumber(args['limit'], 10)

    // Parse types filter
    const typesArg = asString(args['types'], 'all')
    let types: RelationshipType[]
    if (typesArg === 'all') {
      types = [...VALID_RELATIONSHIP_TYPES] as RelationshipType[]
    } else {
      types = typesArg
        .split(',')
        .map(t => t.trim())
        .filter(t => VALID_RELATIONSHIP_TYPES.has(t)) as RelationshipType[]
      if (types.length === 0) {
        return errorResult(`No valid relationship types in: ${typesArg}`)
      }
    }

    const results = await this.services.relationships.traverse(startKey, types, maxHops, limit)
    return successResult({
      startKey,
      types: typesArg,
      maxHops,
      count: results.length,
      results: results.map(r => ({
        key: r.key,
        hops: r.hops,
        path: r.path.map(e => `${e.fromKey} --[${e.type}]--> ${e.toKey}`),
        value: r.value,
      })),
    })
  }

  private async handleHistory(args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.services.temporal) {
      return errorResult('Temporal memory not configured')
    }

    const key = args['key']
    if (typeof key !== 'string' || key.length === 0) {
      return errorResult('Missing required parameter: key')
    }

    const history = await this.services.temporal.getHistory(this.ns(args), this.scope, key)
    return successResult({
      key,
      namespace: this.ns(args),
      versions: history.length,
      history,
    })
  }

  private async handleStats(args: Record<string, unknown>): Promise<MCPToolResult> {
    const namespace = this.ns(args)
    const records = await this.services.memory.get(namespace, this.scope)

    const stats: Record<string, unknown> = {
      namespace,
      recordCount: records.length,
    }

    // Category breakdown
    const categories = new Map<string, number>()
    for (const r of records) {
      const cat = typeof r['category'] === 'string' ? r['category'] : 'uncategorized'
      categories.set(cat, (categories.get(cat) ?? 0) + 1)
    }
    stats['categories'] = Object.fromEntries(categories)

    // Relationship stats if available
    if (this.services.relationships) {
      const edges = await this.services.relationships.getAllEdges()
      const typeCounts = new Map<string, number>()
      for (const edge of edges) {
        typeCounts.set(edge.type, (typeCounts.get(edge.type) ?? 0) + 1)
      }
      stats['relationships'] = {
        totalEdges: edges.length,
        byType: Object.fromEntries(typeCounts),
      }
    }

    return successResult(stats)
  }
}
