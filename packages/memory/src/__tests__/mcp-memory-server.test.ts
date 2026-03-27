import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MCPMemoryHandler,
  MCP_MEMORY_TOOLS,
} from '../mcp-memory-server.js'
import type { MCPMemoryServices, MCPToolResult } from '../mcp-memory-server.js'
import type { MemoryService } from '../memory-service.js'
import type { TemporalMemoryService } from '../temporal.js'
import type { RelationshipStore } from '../retrieval/relationship-store.js'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockMemoryService(): MemoryService {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
  } as unknown as MemoryService
}

function createMockTemporal(): TemporalMemoryService {
  return {
    expire: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
  } as unknown as TemporalMemoryService
}

function createMockRelationships(): RelationshipStore {
  return {
    addEdge: vi.fn().mockResolvedValue(undefined),
    traverse: vi.fn().mockResolvedValue([]),
    getAllEdges: vi.fn().mockResolvedValue([]),
  } as unknown as RelationshipStore
}

function createServices(opts?: {
  temporal?: boolean
  relationships?: boolean
}): MCPMemoryServices {
  return {
    memory: createMockMemoryService(),
    temporal: opts?.temporal ? createMockTemporal() : undefined,
    relationships: opts?.relationships ? createMockRelationships() : undefined,
    defaultScope: { tenantId: 't1' },
    defaultNamespace: 'general',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPMemoryHandler', () => {
  let services: MCPMemoryServices
  let handler: MCPMemoryHandler

  beforeEach(() => {
    services = createServices({ temporal: true, relationships: true })
    handler = new MCPMemoryHandler(services)
  })

  // ---- getTools() ---------------------------------------------------------

  describe('getTools()', () => {
    it('should return 10 tool definitions', () => {
      const tools = handler.getTools()
      expect(tools).toHaveLength(10)
    })

    it('should have name, description, and inputSchema on every tool', () => {
      const tools = handler.getTools()
      for (const tool of tools) {
        expect(typeof tool.name).toBe('string')
        expect(tool.name.length).toBeGreaterThan(0)
        expect(typeof tool.description).toBe('string')
        expect(tool.description.length).toBeGreaterThan(0)
        expect(tool.inputSchema).toBeDefined()
        expect(tool.inputSchema.type).toBe('object')
        expect(tool.inputSchema.properties).toBeDefined()
        expect(Array.isArray(tool.inputSchema.required)).toBe(true)
      }
    })

    it('should return the same array as MCP_MEMORY_TOOLS', () => {
      expect(handler.getTools()).toBe(MCP_MEMORY_TOOLS)
    })
  })

  // ---- memory_store -------------------------------------------------------

  describe('handleToolCall("memory_store")', () => {
    it('should call memoryService.put with correct args', async () => {
      const result = await handler.handleToolCall('memory_store', {
        key: 'k1',
        text: 'hello world',
        category: 'fact',
      })

      expect(result.isError).toBeUndefined()
      const put = services.memory.put as ReturnType<typeof vi.fn>
      expect(put).toHaveBeenCalledOnce()

      const [ns, scope, key, value] = put.mock.calls[0]!
      expect(ns).toBe('general')
      expect(scope).toEqual({ tenantId: 't1' })
      expect(key).toBe('k1')
      expect(value['text']).toBe('hello world')
      expect(value['category']).toBe('fact')
      expect(typeof value['storedAt']).toBe('number')
    })

    it('should use provided namespace instead of default', async () => {
      await handler.handleToolCall('memory_store', {
        key: 'k2',
        text: 'data',
        namespace: 'lessons',
      })

      const put = services.memory.put as ReturnType<typeof vi.fn>
      expect(put.mock.calls[0]![0]).toBe('lessons')
    })

    it('should return error when key is missing', async () => {
      const result = await handler.handleToolCall('memory_store', {
        text: 'hello',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('key')
    })

    it('should return error when text is missing', async () => {
      const result = await handler.handleToolCall('memory_store', {
        key: 'k1',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('text')
    })
  })

  // ---- memory_search ------------------------------------------------------

  describe('handleToolCall("memory_search")', () => {
    it('should call memoryService.search with correct args', async () => {
      const mockResults = [{ text: 'found it' }]
      ;(services.memory.search as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults)

      const result = await handler.handleToolCall('memory_search', {
        query: 'find me',
        limit: 3,
      })

      expect(result.isError).toBeUndefined()
      const search = services.memory.search as ReturnType<typeof vi.fn>
      expect(search).toHaveBeenCalledWith('general', { tenantId: 't1' }, 'find me', 3)

      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed.query).toBe('find me')
      expect(parsed.count).toBe(1)
    })

    it('should default limit to 5', async () => {
      await handler.handleToolCall('memory_search', { query: 'q' })
      const search = services.memory.search as ReturnType<typeof vi.fn>
      expect(search.mock.calls[0]![3]).toBe(5)
    })

    it('should return error when query is missing', async () => {
      const result = await handler.handleToolCall('memory_search', {})
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('query')
    })
  })

  // ---- memory_recall ------------------------------------------------------

  describe('handleToolCall("memory_recall")', () => {
    it('should call memoryService.get with key', async () => {
      const record = { text: 'recalled data' }
      ;(services.memory.get as ReturnType<typeof vi.fn>).mockResolvedValue([record])

      const result = await handler.handleToolCall('memory_recall', { key: 'k1' })
      expect(result.isError).toBeUndefined()

      const get = services.memory.get as ReturnType<typeof vi.fn>
      expect(get).toHaveBeenCalledWith('general', { tenantId: 't1' }, 'k1')

      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed.found).toBe(true)
      expect(parsed.value).toEqual(record)
    })

    it('should return found: false when no records', async () => {
      ;(services.memory.get as ReturnType<typeof vi.fn>).mockResolvedValue([])

      const result = await handler.handleToolCall('memory_recall', { key: 'missing' })
      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed.found).toBe(false)
    })

    it('should return error when key is missing', async () => {
      const result = await handler.handleToolCall('memory_recall', {})
      expect(result.isError).toBe(true)
    })
  })

  // ---- memory_list --------------------------------------------------------

  describe('handleToolCall("memory_list")', () => {
    it('should call memoryService.get without key', async () => {
      const records = [{ text: 'a' }, { text: 'b' }, { text: 'c' }]
      ;(services.memory.get as ReturnType<typeof vi.fn>).mockResolvedValue(records)

      const result = await handler.handleToolCall('memory_list', {})
      expect(result.isError).toBeUndefined()

      const get = services.memory.get as ReturnType<typeof vi.fn>
      expect(get).toHaveBeenCalledWith('general', { tenantId: 't1' })

      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed.count).toBe(3)
      expect(parsed.total).toBe(3)
    })

    it('should respect limit parameter', async () => {
      const records = Array.from({ length: 25 }, (_, i) => ({ text: `r${i}` }))
      ;(services.memory.get as ReturnType<typeof vi.fn>).mockResolvedValue(records)

      const result = await handler.handleToolCall('memory_list', { limit: 10 })
      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed.count).toBe(10)
      expect(parsed.total).toBe(25)
    })
  })

  // ---- memory_delete ------------------------------------------------------

  describe('handleToolCall("memory_delete")', () => {
    it('should call temporal.expire when temporal is configured', async () => {
      const result = await handler.handleToolCall('memory_delete', { key: 'k1' })
      expect(result.isError).toBeUndefined()

      const expire = services.temporal!.expire as ReturnType<typeof vi.fn>
      expect(expire).toHaveBeenCalledWith('general', { tenantId: 't1' }, 'k1')

      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed.expired).toBe(true)
    })

    it('should return error when temporal is not configured', async () => {
      const noTemporal = createServices({ temporal: false })
      const h = new MCPMemoryHandler(noTemporal)

      const result = await h.handleToolCall('memory_delete', { key: 'k1' })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('Temporal memory not configured')
    })

    it('should return error when key is missing', async () => {
      const result = await handler.handleToolCall('memory_delete', {})
      expect(result.isError).toBe(true)
    })
  })

  // ---- memory_health ------------------------------------------------------

  describe('handleToolCall("memory_health")', () => {
    it('should run healMemory on records from the namespace', async () => {
      const records = [
        { key: 'r1', text: 'some memory text' },
        { key: 'r2', text: 'another memory text' },
      ]
      ;(services.memory.get as ReturnType<typeof vi.fn>).mockResolvedValue(records)

      const result = await handler.handleToolCall('memory_health', {})
      expect(result.isError).toBeUndefined()

      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed.namespace).toBe('general')
      expect(typeof parsed.totalRecordsScanned).toBe('number')
      expect(Array.isArray(parsed.issues)).toBe(true)
    })
  })

  // ---- memory_relate ------------------------------------------------------

  describe('handleToolCall("memory_relate")', () => {
    it('should call relationships.addEdge with correct edge', async () => {
      const result = await handler.handleToolCall('memory_relate', {
        fromKey: 'a',
        toKey: 'b',
        type: 'causes',
        evidence: 'observed in testing',
      })

      expect(result.isError).toBeUndefined()
      const addEdge = services.relationships!.addEdge as ReturnType<typeof vi.fn>
      expect(addEdge).toHaveBeenCalledOnce()

      const edge = addEdge.mock.calls[0]![0]
      expect(edge.fromKey).toBe('a')
      expect(edge.toKey).toBe('b')
      expect(edge.type).toBe('causes')
      expect(edge.metadata?.evidence).toBe('observed in testing')
      expect(typeof edge.createdAt).toBe('number')
    })

    it('should return error when relationships is not configured', async () => {
      const noRel = createServices({ relationships: false })
      const h = new MCPMemoryHandler(noRel)

      const result = await h.handleToolCall('memory_relate', {
        fromKey: 'a',
        toKey: 'b',
        type: 'causes',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('not configured')
    })

    it('should return error for invalid relationship type', async () => {
      const result = await handler.handleToolCall('memory_relate', {
        fromKey: 'a',
        toKey: 'b',
        type: 'invalid_type',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('Invalid relationship type')
    })

    it('should return error when fromKey is missing', async () => {
      const result = await handler.handleToolCall('memory_relate', {
        toKey: 'b',
        type: 'causes',
      })
      expect(result.isError).toBe(true)
    })

    it('should return error when toKey is missing', async () => {
      const result = await handler.handleToolCall('memory_relate', {
        fromKey: 'a',
        type: 'causes',
      })
      expect(result.isError).toBe(true)
    })
  })

  // ---- memory_traverse ----------------------------------------------------

  describe('handleToolCall("memory_traverse")', () => {
    it('should call relationships.traverse with parsed types', async () => {
      const traverseResults = [
        { key: 'x', hops: 1, path: [{ fromKey: 'start', toKey: 'x', type: 'causes', createdAt: 1 }], value: {} },
      ]
      ;(services.relationships!.traverse as ReturnType<typeof vi.fn>).mockResolvedValue(traverseResults)

      const result = await handler.handleToolCall('memory_traverse', {
        startKey: 'start',
        types: 'causes,prevents',
        maxHops: 3,
        limit: 5,
      })

      expect(result.isError).toBeUndefined()
      const traverse = services.relationships!.traverse as ReturnType<typeof vi.fn>
      expect(traverse).toHaveBeenCalledWith(
        'start',
        ['causes', 'prevents'],
        3,
        5,
      )
    })

    it('should use all types when types arg is "all"', async () => {
      ;(services.relationships!.traverse as ReturnType<typeof vi.fn>).mockResolvedValue([])
      await handler.handleToolCall('memory_traverse', { startKey: 'k1' })

      const traverse = services.relationships!.traverse as ReturnType<typeof vi.fn>
      const types = traverse.mock.calls[0]![1] as string[]
      expect(types.length).toBe(16) // all 16 valid types
    })

    it('should return error for no valid relationship types', async () => {
      const result = await handler.handleToolCall('memory_traverse', {
        startKey: 'k1',
        types: 'bogus,fake',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('No valid relationship types')
    })

    it('should return error when relationships not configured', async () => {
      const h = new MCPMemoryHandler(createServices({ relationships: false }))
      const result = await h.handleToolCall('memory_traverse', { startKey: 'k1' })
      expect(result.isError).toBe(true)
    })

    it('should return error when startKey is missing', async () => {
      const result = await handler.handleToolCall('memory_traverse', {})
      expect(result.isError).toBe(true)
    })
  })

  // ---- memory_history -----------------------------------------------------

  describe('handleToolCall("memory_history")', () => {
    it('should call temporal.getHistory', async () => {
      const history = [{ text: 'v1' }, { text: 'v2' }]
      ;(services.temporal!.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue(history)

      const result = await handler.handleToolCall('memory_history', { key: 'k1' })
      expect(result.isError).toBeUndefined()

      const getHistory = services.temporal!.getHistory as ReturnType<typeof vi.fn>
      expect(getHistory).toHaveBeenCalledWith('general', { tenantId: 't1' }, 'k1')

      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed.versions).toBe(2)
    })

    it('should return error when temporal is not configured', async () => {
      const h = new MCPMemoryHandler(createServices({ temporal: false }))
      const result = await h.handleToolCall('memory_history', { key: 'k1' })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('Temporal memory not configured')
    })

    it('should return error when key is missing', async () => {
      const result = await handler.handleToolCall('memory_history', {})
      expect(result.isError).toBe(true)
    })
  })

  // ---- memory_stats -------------------------------------------------------

  describe('handleToolCall("memory_stats")', () => {
    it('should return record count and category breakdown', async () => {
      const records = [
        { category: 'fact', text: 'a' },
        { category: 'fact', text: 'b' },
        { category: 'decision', text: 'c' },
      ]
      ;(services.memory.get as ReturnType<typeof vi.fn>).mockResolvedValue(records)
      ;(services.relationships!.getAllEdges as ReturnType<typeof vi.fn>).mockResolvedValue([
        { type: 'causes', fromKey: 'a', toKey: 'b', createdAt: 1 },
      ])

      const result = await handler.handleToolCall('memory_stats', {})
      expect(result.isError).toBeUndefined()

      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed.recordCount).toBe(3)
      expect(parsed.categories.fact).toBe(2)
      expect(parsed.categories.decision).toBe(1)
      expect(parsed.relationships.totalEdges).toBe(1)
    })

    it('should omit relationships when not configured', async () => {
      const h = new MCPMemoryHandler(createServices({ relationships: false }))
      ;((h as unknown as { services: MCPMemoryServices }).services ?? services).memory
      // Use the handler's own mock
      const svc = createServices({ relationships: false })
      const h2 = new MCPMemoryHandler(svc)
      ;(svc.memory.get as ReturnType<typeof vi.fn>).mockResolvedValue([])

      const result = await h2.handleToolCall('memory_stats', {})
      const parsed = JSON.parse(result.content[0]!.text)
      expect(parsed.relationships).toBeUndefined()
    })
  })

  // ---- Unknown tool -------------------------------------------------------

  describe('unknown tool name', () => {
    it('should return isError response', async () => {
      const result = await handler.handleToolCall('nonexistent_tool', {})
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('Unknown tool')
    })
  })

  // ---- Handler errors → isError -------------------------------------------

  describe('handler errors', () => {
    it('should catch handler errors and return isError response', async () => {
      ;(services.memory.put as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('DB connection lost'),
      )

      const result = await handler.handleToolCall('memory_store', {
        key: 'k1',
        text: 'data',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('DB connection lost')
    })

    it('should handle non-Error thrown values', async () => {
      ;(services.memory.search as ReturnType<typeof vi.fn>).mockRejectedValue('string error')

      const result = await handler.handleToolCall('memory_search', {
        query: 'q',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('string error')
    })
  })
})
