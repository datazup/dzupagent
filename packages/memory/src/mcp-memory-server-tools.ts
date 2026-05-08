/**
 * MCP tool catalogue for the memory server.
 *
 * The schemas advertised here are consumed by LLMs. Keep them in sync with
 * the dispatcher in `mcp-memory-server-dispatcher.ts` — every tool listed
 * below must have a corresponding handler registered.
 */
import type { MCPToolDefinition } from './mcp-memory-server-types.js'

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
