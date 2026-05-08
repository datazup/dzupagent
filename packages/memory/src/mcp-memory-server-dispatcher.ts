/**
 * Per-tool dispatch handlers for the MCP memory server.
 *
 * Each `handle*` function maps one MCP tool call to a sequence of
 * `MemoryService` / `TemporalMemoryService` / `RelationshipStore` operations
 * and returns an `MCPToolResult`. Handlers are non-fatal — they return
 * `{ isError: true }` on bad input rather than throwing. The coordinator
 * (`mcp-memory-server.ts`) catches anything else.
 */
import { healMemory } from './memory-healer.js'
import type { HealingReport } from './memory-healer.js'
import type {
  RelationshipEdge,
  RelationshipType,
} from './retrieval/relationship-store.js'
import {
  asNumber,
  asString,
  errorResult,
  successResult,
  VALID_RELATIONSHIP_TYPES,
  type MCPMemoryServices,
  type MCPToolResult,
} from './mcp-memory-server-types.js'

function ns(services: MCPMemoryServices, args: Record<string, unknown>): string {
  return asString(args['namespace'], services.defaultNamespace)
}

export async function handleStore(
  services: MCPMemoryServices,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
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

  const namespace = ns(services, args)
  await services.memory.put(namespace, services.defaultScope, key, value)
  return successResult({ stored: true, key, namespace })
}

export async function handleSearch(
  services: MCPMemoryServices,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  const query = args['query']
  if (typeof query !== 'string' || query.length === 0) {
    return errorResult('Missing required parameter: query')
  }
  const limit = asNumber(args['limit'], 5)
  const results = await services.memory.search(
    ns(services, args),
    services.defaultScope,
    query,
    limit,
  )
  return successResult({ query, count: results.length, results })
}

export async function handleRecall(
  services: MCPMemoryServices,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  const key = args['key']
  if (typeof key !== 'string' || key.length === 0) {
    return errorResult('Missing required parameter: key')
  }
  const results = await services.memory.get(
    ns(services, args),
    services.defaultScope,
    key,
  )
  if (results.length === 0) {
    return successResult({ found: false, key })
  }
  return successResult({ found: true, key, value: results[0] })
}

export async function handleList(
  services: MCPMemoryServices,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  const namespace = ns(services, args)
  const records = await services.memory.get(namespace, services.defaultScope)
  const limit = asNumber(args['limit'], 20)
  const trimmed = records.slice(0, limit)
  return successResult({
    namespace,
    count: trimmed.length,
    total: records.length,
    records: trimmed,
  })
}

export async function handleDelete(
  services: MCPMemoryServices,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  const key = args['key']
  if (typeof key !== 'string' || key.length === 0) {
    return errorResult('Missing required parameter: key')
  }
  if (!services.temporal) {
    return errorResult(
      'Temporal memory not configured — soft-delete unavailable. Hard-delete is not supported to preserve memory integrity.',
    )
  }
  const namespace = ns(services, args)
  await services.temporal.expire(namespace, services.defaultScope, key)
  return successResult({ expired: true, key, namespace })
}

export async function handleHealth(
  services: MCPMemoryServices,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  const namespace = ns(services, args)
  const records = await services.memory.get(namespace, services.defaultScope)

  // Transform records into the shape healMemory expects
  const healable = records.map((r, idx) => {
    const key = typeof r['key'] === 'string' ? r['key'] : `record_${idx}`
    const text = typeof r['text'] === 'string' ? r['text'] : JSON.stringify(r)
    const lastAccessedAt = typeof r['lastAccessedAt'] === 'number'
      ? r['lastAccessedAt']
      : undefined
    return { key, text, ...(lastAccessedAt !== undefined ? { lastAccessedAt } : {}) }
  })

  const report: HealingReport = healMemory(healable)
  return successResult({ namespace, ...report })
}

export async function handleRelate(
  services: MCPMemoryServices,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  if (!services.relationships) {
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
    return errorResult(
      `Invalid relationship type: ${String(relType)}. Valid types: ${[...VALID_RELATIONSHIP_TYPES].join(', ')}`,
    )
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

  await services.relationships.addEdge(edge)
  return successResult({ related: true, fromKey, toKey, type: relType })
}

export async function handleTraverse(
  services: MCPMemoryServices,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  if (!services.relationships) {
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

  const results = await services.relationships.traverse(startKey, types, maxHops, limit)
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

export async function handleHistory(
  services: MCPMemoryServices,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  if (!services.temporal) {
    return errorResult('Temporal memory not configured')
  }

  const key = args['key']
  if (typeof key !== 'string' || key.length === 0) {
    return errorResult('Missing required parameter: key')
  }

  const namespace = ns(services, args)
  const history = await services.temporal.getHistory(namespace, services.defaultScope, key)
  return successResult({
    key,
    namespace,
    versions: history.length,
    history,
  })
}

export async function handleStats(
  services: MCPMemoryServices,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  const namespace = ns(services, args)
  const records = await services.memory.get(namespace, services.defaultScope)

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
  if (services.relationships) {
    const edges = await services.relationships.getAllEdges()
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

/**
 * Build the dispatch table. Returned as a Map so the coordinator can
 * look up handlers by tool name in O(1).
 */
export function buildDispatchTable(
  services: MCPMemoryServices,
): Map<string, (args: Record<string, unknown>) => Promise<MCPToolResult>> {
  return new Map([
    ['memory_store', (a) => handleStore(services, a)],
    ['memory_search', (a) => handleSearch(services, a)],
    ['memory_recall', (a) => handleRecall(services, a)],
    ['memory_list', (a) => handleList(services, a)],
    ['memory_delete', (a) => handleDelete(services, a)],
    ['memory_health', (a) => handleHealth(services, a)],
    ['memory_relate', (a) => handleRelate(services, a)],
    ['memory_traverse', (a) => handleTraverse(services, a)],
    ['memory_history', (a) => handleHistory(services, a)],
    ['memory_stats', (a) => handleStats(services, a)],
  ])
}
