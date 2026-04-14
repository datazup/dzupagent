import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RagMemoryNamespace } from '../memory-namespace.js'
import type { MemoryServiceLike } from '../memory-namespace.js'
import type { ChunkResult } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(id: string, sourceId: string): ChunkResult {
  return {
    id,
    text: `Text of ${id}`,
    tokenCount: 10,
    quality: 0.8,
    metadata: {
      sourceId,
      chunkIndex: 0,
      startOffset: 0,
      endOffset: 100,
      boundaryType: 'paragraph',
    },
  }
}

function makeMemoryService(overrides?: Partial<MemoryServiceLike>): MemoryServiceLike {
  return {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => []),
    search: vi.fn(async () => []),
    delete: vi.fn(async () => {}),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RagMemoryNamespace', () => {
  const config = { namespace: 'rag-chunks', scopeKeys: ['tenantId', 'sessionId'] }
  const scope = { tenantId: 'tenant-1', sessionId: 'session-1' }

  // -------------------------------------------------------------------------
  // storeChunks
  // -------------------------------------------------------------------------

  describe('storeChunks', () => {
    it('stores each chunk as a memory record', async () => {
      const memory = makeMemoryService()
      const ns = new RagMemoryNamespace(memory, config)
      const chunks = [makeChunk('c1', 'src-1'), makeChunk('c2', 'src-1')]

      await ns.storeChunks(chunks, scope)

      expect(memory.put).toHaveBeenCalledTimes(2)
      expect(memory.put).toHaveBeenCalledWith(
        'rag-chunks',
        { tenantId: 'tenant-1', sessionId: 'session-1' },
        'c1',
        expect.objectContaining({ id: 'c1', text: 'Text of c1' }),
      )
    })

    it('throws when a required scope key is missing', async () => {
      const memory = makeMemoryService()
      const ns = new RagMemoryNamespace(memory, config)

      await expect(
        ns.storeChunks([], { tenantId: 'tenant-1' }),
      ).rejects.toThrow('sessionId')
    })

    it('throws when a scope key is empty string', async () => {
      const memory = makeMemoryService()
      const ns = new RagMemoryNamespace(memory, config)

      await expect(
        ns.storeChunks([], { tenantId: 'tenant-1', sessionId: '  ' }),
      ).rejects.toThrow('sessionId')
    })
  })

  // -------------------------------------------------------------------------
  // getChunks
  // -------------------------------------------------------------------------

  describe('getChunks', () => {
    it('retrieves and filters valid chunk records', async () => {
      const stored = {
        id: 'c1',
        text: 'Hello',
        tokenCount: 5,
        quality: 0.7,
        metadata: { sourceId: 'src-1', chunkIndex: 0, startOffset: 0, endOffset: 50, boundaryType: 'paragraph' },
      }
      const memory = makeMemoryService({
        get: vi.fn(async () => [stored, { invalid: true }]),
      })
      const ns = new RagMemoryNamespace(memory, config)

      const result = await ns.getChunks(scope)

      expect(result).toHaveLength(1)
      expect(result[0]!.id).toBe('c1')
    })

    it('returns empty array when no valid chunks exist', async () => {
      const memory = makeMemoryService({
        get: vi.fn(async () => [{ unrelated: 'data' }]),
      })
      const ns = new RagMemoryNamespace(memory, config)
      const result = await ns.getChunks(scope)
      expect(result).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // searchChunks
  // -------------------------------------------------------------------------

  describe('searchChunks', () => {
    it('searches and returns matched chunks with position-based scores', async () => {
      const stored = {
        id: 'c1',
        text: 'Match',
        tokenCount: 5,
        quality: 0.7,
        metadata: { sourceId: 'src-1', chunkIndex: 0, startOffset: 0, endOffset: 50, boundaryType: 'paragraph' },
      }
      const memory = makeMemoryService({
        search: vi.fn(async () => [stored]),
      })
      const ns = new RagMemoryNamespace(memory, config)

      const result = await ns.searchChunks('query', scope, 5)

      expect(result).toHaveLength(1)
      expect(result[0]!.chunk.id).toBe('c1')
      expect(result[0]!.score).toBe(1) // 1 / (0 + 1)
    })

    it('throws when memory service does not support search', async () => {
      const memory = makeMemoryService()
      delete (memory as Record<string, unknown>)['search']
      const ns = new RagMemoryNamespace(memory, config)

      await expect(
        ns.searchChunks('query', scope),
      ).rejects.toThrow('does not support search')
    })
  })

  // -------------------------------------------------------------------------
  // deleteBySource
  // -------------------------------------------------------------------------

  describe('deleteBySource', () => {
    it('deletes all chunks matching a sourceId', async () => {
      const stored = [
        { id: 'c1', text: 'A', tokenCount: 1, quality: 0.5, metadata: { sourceId: 'src-1', chunkIndex: 0, startOffset: 0, endOffset: 10, boundaryType: 'paragraph' } },
        { id: 'c2', text: 'B', tokenCount: 1, quality: 0.5, metadata: { sourceId: 'src-2', chunkIndex: 0, startOffset: 0, endOffset: 10, boundaryType: 'paragraph' } },
        { id: 'c3', text: 'C', tokenCount: 1, quality: 0.5, metadata: { sourceId: 'src-1', chunkIndex: 1, startOffset: 10, endOffset: 20, boundaryType: 'paragraph' } },
      ]
      const deleteFn = vi.fn(async () => {})
      const memory = makeMemoryService({
        get: vi.fn(async () => stored),
        delete: deleteFn,
      })
      const ns = new RagMemoryNamespace(memory, config)

      await ns.deleteBySource('src-1', scope)

      expect(deleteFn).toHaveBeenCalledTimes(2)
      expect(deleteFn).toHaveBeenCalledWith('rag-chunks', expect.any(Object), 'c1')
      expect(deleteFn).toHaveBeenCalledWith('rag-chunks', expect.any(Object), 'c3')
    })

    it('throws when memory service does not support delete', async () => {
      const memory = makeMemoryService()
      delete (memory as Record<string, unknown>)['delete']
      const ns = new RagMemoryNamespace(memory, config)

      await expect(
        ns.deleteBySource('src-1', scope),
      ).rejects.toThrow('does not support delete')
    })
  })

  // -------------------------------------------------------------------------
  // getChunkCount
  // -------------------------------------------------------------------------

  describe('getChunkCount', () => {
    it('counts only valid chunk records', async () => {
      const records = [
        { id: 'c1', text: 'A', tokenCount: 1, quality: 0.5, metadata: { sourceId: 's', chunkIndex: 0, startOffset: 0, endOffset: 5, boundaryType: 'paragraph' } },
        { notAChunk: true },
        { id: 'c2', text: 'B', tokenCount: 2, quality: 0.6, metadata: { sourceId: 's', chunkIndex: 1, startOffset: 5, endOffset: 10, boundaryType: 'paragraph' } },
      ]
      const memory = makeMemoryService({
        get: vi.fn(async () => records),
      })
      const ns = new RagMemoryNamespace(memory, config)

      const count = await ns.getChunkCount(scope)
      expect(count).toBe(2)
    })
  })
})
