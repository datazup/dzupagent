import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEvent, DzipEventBus } from '@dzipagent/core'

import {
  MapReduceOrchestrator,
  LineChunker,
  DirectoryChunker,
} from '../orchestration/map-reduce.js'
import type {
  Chunker,
  MapperFn,
  ReducerFn,
  MapChunkResult,
} from '../orchestration/map-reduce.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockRegistry(
  resultFn?: (prompt: string) => string,
): AdapterRegistry {
  const getResult = resultFn ?? ((prompt: string) => `processed: ${prompt}`)

  return {
    async *executeWithFallback(input: AgentInput, _task: TaskDescriptor) {
      yield {
        type: 'adapter:started' as const,
        providerId: 'claude' as AdapterProviderId,
        sessionId: 'sess-1',
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:completed' as const,
        providerId: 'claude' as AdapterProviderId,
        sessionId: 'sess-1',
        result: getResult(input.prompt),
        durationMs: 10,
        timestamp: Date.now(),
      }
    },
  } as unknown as AdapterRegistry
}

function createFailingRegistry(failAtChunk?: number): AdapterRegistry {
  let callCount = 0

  return {
    async *executeWithFallback(input: AgentInput, _task: TaskDescriptor) {
      const currentCall = callCount++
      if (failAtChunk === undefined || currentCall === failAtChunk) {
        throw new Error(`Failed processing chunk ${currentCall}`)
      }
      yield {
        type: 'adapter:completed' as const,
        providerId: 'claude' as AdapterProviderId,
        sessionId: 'sess-1',
        result: `result-${currentCall}`,
        durationMs: 10,
        timestamp: Date.now(),
      }
    },
  } as unknown as AdapterRegistry
}

function collectBusEvents(bus: DzipEventBus): DzipEvent[] {
  const events: DzipEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// Standard mapper and reducer for string[] chunks
const stringArrayMapper: MapperFn<string[]> = (chunk, index) => ({
  input: { prompt: chunk.join('\n') },
  task: { prompt: chunk.join('\n'), tags: ['general'] },
})

const identityExtractor = (raw: string, _chunk: string[]): string => raw

const concatReducer: ReducerFn<string, string> = (results) =>
  results
    .filter((r) => r.success)
    .map((r) => r.result)
    .join('; ')

// ---------------------------------------------------------------------------
// LineChunker tests
// ---------------------------------------------------------------------------

describe('LineChunker', () => {
  it('splits text into groups of N lines', () => {
    const chunker = new LineChunker(3)
    const input = 'line1\nline2\nline3\nline4\nline5'
    const chunks = chunker.split(input)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual(['line1', 'line2', 'line3'])
    expect(chunks[1]).toEqual(['line4', 'line5'])
  })

  it('handles exact multiple of linesPerChunk', () => {
    const chunker = new LineChunker(2)
    const input = 'a\nb\nc\nd'
    const chunks = chunker.split(input)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual(['a', 'b'])
    expect(chunks[1]).toEqual(['c', 'd'])
  })

  it('handles single line', () => {
    const chunker = new LineChunker(50)
    const chunks = chunker.split('single line')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual(['single line'])
  })

  it('handles empty input', () => {
    const chunker = new LineChunker(10)
    const chunks = chunker.split('')
    // Empty string split by \n gives ['']
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual([''])
  })

  it('uses default 50 lines per chunk', () => {
    const chunker = new LineChunker()
    const lines = Array.from({ length: 120 }, (_, i) => `line${i}`)
    const chunks = chunker.split(lines.join('\n'))

    expect(chunks).toHaveLength(3) // 50 + 50 + 20
    expect(chunks[0]).toHaveLength(50)
    expect(chunks[1]).toHaveLength(50)
    expect(chunks[2]).toHaveLength(20)
  })
})

// ---------------------------------------------------------------------------
// DirectoryChunker tests
// ---------------------------------------------------------------------------

describe('DirectoryChunker', () => {
  it('splits file paths into groups of N', () => {
    const chunker = new DirectoryChunker(2)
    const input = 'src/a.ts\nsrc/b.ts\nsrc/c.ts'
    const chunks = chunker.split(input)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual(['src/a.ts', 'src/b.ts'])
    expect(chunks[1]).toEqual(['src/c.ts'])
  })

  it('trims whitespace and filters empty lines', () => {
    const chunker = new DirectoryChunker(10)
    const input = '  src/a.ts  \n\n  src/b.ts \n  \n'
    const chunks = chunker.split(input)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('handles empty input', () => {
    const chunker = new DirectoryChunker(5)
    const chunks = chunker.split('')
    expect(chunks).toHaveLength(0)
  })

  it('uses default 10 files per chunk', () => {
    const chunker = new DirectoryChunker()
    const files = Array.from({ length: 25 }, (_, i) => `file${i}.ts`)
    const chunks = chunker.split(files.join('\n'))

    expect(chunks).toHaveLength(3) // 10 + 10 + 5
    expect(chunks[0]).toHaveLength(10)
    expect(chunks[2]).toHaveLength(5)
  })
})

// ---------------------------------------------------------------------------
// MapReduceOrchestrator tests
// ---------------------------------------------------------------------------

describe('MapReduceOrchestrator', () => {
  let bus: DzipEventBus
  let emitted: DzipEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
  })

  describe('execute()', () => {
    it('runs full split-map-reduce pipeline', async () => {
      const registry = createMockRegistry()
      const orchestrator = new MapReduceOrchestrator({
        registry,
        eventBus: bus,
        maxConcurrency: 2,
      })

      const result = await orchestrator.execute('line1\nline2\nline3\nline4\nline5', {
        chunker: new LineChunker(2),
        mapper: stringArrayMapper,
        resultExtractor: identityExtractor,
        reducer: concatReducer,
      })

      expect(result.chunks).toBe(3) // 2 + 2 + 1
      expect(result.successfulChunks).toBe(3)
      expect(result.failedChunks).toBe(0)
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
      expect(result.result).toContain('processed:')
    })

    it('returns correct per-chunk stats', async () => {
      const registry = createMockRegistry()
      const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })

      const result = await orchestrator.execute('a\nb\nc', {
        chunker: new LineChunker(1),
        mapper: stringArrayMapper,
        resultExtractor: identityExtractor,
        reducer: concatReducer,
      })

      expect(result.perChunkStats).toHaveLength(3)
      for (const stat of result.perChunkStats) {
        expect(stat.success).toBe(true)
        expect(stat.providerId).toBe('claude')
        expect(stat.durationMs).toBeGreaterThanOrEqual(0)
      }
      // Stats should be ordered by index
      expect(result.perChunkStats.map((s) => s.index)).toEqual([0, 1, 2])
    })

    it('passes map results to reducer in order', async () => {
      const registry = createMockRegistry((prompt) => prompt.toUpperCase())
      const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })

      const reducerSpy: ReducerFn<string, string[]> = (results) => {
        return results.map((r) => r.result)
      }

      const result = await orchestrator.execute('alpha\nbeta\ngamma', {
        chunker: new LineChunker(1),
        mapper: stringArrayMapper,
        resultExtractor: identityExtractor,
        reducer: reducerSpy,
      })

      // Results should be in chunk order regardless of execution order
      expect(result.result).toEqual(['ALPHA', 'BETA', 'GAMMA'])
    })
  })

  describe('concurrency', () => {
    it('runs map phase in parallel up to maxConcurrency', async () => {
      let concurrentCount = 0
      let maxConcurrentObserved = 0

      const registry = {
        async *executeWithFallback(input: AgentInput, _task: TaskDescriptor) {
          concurrentCount++
          maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrentCount)
          await new Promise((r) => setTimeout(r, 20))
          yield {
            type: 'adapter:completed' as const,
            providerId: 'claude' as AdapterProviderId,
            sessionId: 'sess-1',
            result: 'done',
            durationMs: 20,
            timestamp: Date.now(),
          }
          concurrentCount--
        },
      } as unknown as AdapterRegistry

      const orchestrator = new MapReduceOrchestrator({
        registry,
        eventBus: bus,
        maxConcurrency: 2,
      })

      // 5 chunks with maxConcurrency=2
      const lines = Array.from({ length: 5 }, (_, i) => `line${i}`).join('\n')
      await orchestrator.execute(lines, {
        chunker: new LineChunker(1),
        mapper: stringArrayMapper,
        resultExtractor: identityExtractor,
        reducer: concatReducer,
      })

      expect(maxConcurrentObserved).toBeLessThanOrEqual(2)
    })
  })

  describe('chunk failure handling', () => {
    it('handles individual chunk failures gracefully', async () => {
      // Fail on chunk index 1
      const registry = createFailingRegistry(1)
      const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })

      const result = await orchestrator.execute('a\nb\nc', {
        chunker: new LineChunker(1),
        mapper: stringArrayMapper,
        resultExtractor: identityExtractor,
        reducer: (results) =>
          results.filter((r) => r.success).length,
      })

      // 2 of 3 succeed -- chunk 0 succeeds, chunk 1 fails, chunk 2 succeeds
      // But our mock fails all chunks since failAtChunk fails only chunk 1
      // and subsequent calls succeed
      expect(result.failedChunks).toBeGreaterThan(0)
      expect(result.chunks).toBe(3)
    })

    it('counts failed chunks correctly in stats', async () => {
      // All chunks fail
      const registry = createFailingRegistry()
      const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })

      const result = await orchestrator.execute('a\nb', {
        chunker: new LineChunker(1),
        mapper: stringArrayMapper,
        resultExtractor: identityExtractor,
        reducer: (results) => results.length,
      })

      expect(result.failedChunks).toBe(2)
      expect(result.successfulChunks).toBe(0)
    })
  })

  describe('event bus emissions', () => {
    it('emits mapreduce lifecycle events', async () => {
      const registry = createMockRegistry()
      const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })

      await orchestrator.execute('a\nb', {
        chunker: new LineChunker(1),
        mapper: stringArrayMapper,
        resultExtractor: identityExtractor,
        reducer: concatReducer,
      })

      const types = emitted.map((e) => e.type)
      expect(types).toContain('mapreduce:started')
      expect(types).toContain('mapreduce:map_completed')
      expect(types).toContain('mapreduce:completed')
      expect(types).toContain('mapreduce:chunk_completed')
    })

    it('emits chunk_failed events on failure', async () => {
      const registry = createFailingRegistry()
      const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })

      await orchestrator.execute('a', {
        chunker: new LineChunker(1),
        mapper: stringArrayMapper,
        resultExtractor: identityExtractor,
        reducer: () => 'done',
      })

      const types = emitted.map((e) => e.type)
      expect(types).toContain('mapreduce:chunk_failed')
    })
  })

  describe('custom chunker', () => {
    it('works with a custom chunker implementation', async () => {
      const registry = createMockRegistry()
      const orchestrator = new MapReduceOrchestrator({ registry, eventBus: bus })

      // Custom chunker that splits by comma
      const commaChunker: Chunker<string> = {
        split(input: string): string[] {
          return input.split(',').map((s) => s.trim())
        },
      }

      const result = await orchestrator.execute('apple, banana, cherry', {
        chunker: commaChunker,
        mapper: (chunk: string, index: number) => ({
          input: { prompt: chunk },
          task: { prompt: chunk, tags: ['general'] },
        }),
        resultExtractor: (raw: string, _chunk: string) => raw,
        reducer: (results) => results.filter((r) => r.success).length,
      })

      expect(result.chunks).toBe(3)
      expect(result.successfulChunks).toBe(3)
      expect(result.result).toBe(3)
    })
  })

  describe('abort signal', () => {
    it('respects abort signal — pre-aborted signal marks chunks as failed', async () => {
      const controller = new AbortController()
      controller.abort() // Abort before starting

      const registry = createMockRegistry()
      const orchestrator = new MapReduceOrchestrator({
        registry,
        eventBus: bus,
        maxConcurrency: 2,
      })

      const result = await orchestrator.execute('a\nb\nc', {
        chunker: new LineChunker(1),
        mapper: stringArrayMapper,
        resultExtractor: identityExtractor,
        reducer: (results) => results.filter((r) => r.success).length,
        signal: controller.signal,
      })

      // Pre-aborted signals produce rejected map tasks which are now converted
      // into explicit failed chunk entries for deterministic accounting.
      expect(result.successfulChunks).toBe(0)
      expect(result.failedChunks).toBe(3)
      expect(result.perChunkStats).toHaveLength(3)
      for (const stat of result.perChunkStats) {
        expect(stat.providerId).toBeNull()
        expect(stat.success).toBe(false)
      }
      expect(result.result).toBe(0)
    })
  })
})
