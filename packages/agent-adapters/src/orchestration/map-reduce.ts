/**
 * MapReduceOrchestrator — distributes large tasks across multiple agents
 * using the map-reduce pattern.
 *
 * 1. **Split** — a Chunker breaks the input into typed chunks
 * 2. **Map**   — each chunk is executed via AdapterRegistry.executeWithFallback
 * 3. **Reduce** — a ReducerFn combines all map results into a single output
 *
 * Concurrency is bounded by a simple counting semaphore.
 */

import type { DzipEventBus } from '@dzipagent/core'

import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

import type { AdapterRegistry } from '../registry/adapter-registry.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Splits raw input text into typed chunks. */
export interface Chunker<TChunk> {
  split(input: string): TChunk[]
}

/** Produces an AgentInput + TaskDescriptor pair for a single chunk. */
export type MapperFn<TChunk> = (
  chunk: TChunk,
  index: number,
) => { input: AgentInput; task: TaskDescriptor }

/** Combines all map results into a final aggregate. */
export type ReducerFn<TMapResult, TReduceResult> = (
  results: MapChunkResult<TMapResult>[],
) => TReduceResult

/** The outcome of mapping a single chunk. */
export interface MapChunkResult<TMapResult> {
  chunkIndex: number
  providerId: AdapterProviderId | null
  result: TMapResult
  rawResult: string
  success: boolean
  durationMs: number
  error?: string
}

/** The final result of a complete map-reduce execution. */
export interface MapReduceResult<TReduceResult> {
  result: TReduceResult
  chunks: number
  successfulChunks: number
  failedChunks: number
  totalDurationMs: number
  perChunkStats: Array<{
    index: number
    providerId: AdapterProviderId | null
    durationMs: number
    success: boolean
  }>
}

/** Options passed to `MapReduceOrchestrator.execute`. */
export interface MapReduceOptions<TChunk, TMapResult, TReduceResult> {
  /** Split the input into chunks */
  chunker: Chunker<TChunk>
  /** Create an AgentInput + TaskDescriptor for each chunk */
  mapper: MapperFn<TChunk>
  /** Extract a typed result from the raw adapter output */
  resultExtractor: (raw: string, chunk: TChunk) => TMapResult
  /** Reduce all map results into a final result */
  reducer: ReducerFn<TMapResult, TReduceResult>
  /** Optional abort signal */
  signal?: AbortSignal
}

/** Configuration for the MapReduceOrchestrator. */
export interface MapReduceConfig {
  registry: AdapterRegistry
  eventBus?: DzipEventBus
  /** Maximum number of concurrent map operations. Default: 4 */
  maxConcurrency?: number
}

// ---------------------------------------------------------------------------
// Semaphore — simple counting semaphore for bounding concurrency
// ---------------------------------------------------------------------------

class Semaphore {
  private current = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    if (this.current < this.max) {
      this.current++
      return
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter)
        if (idx !== -1) this.waiters.splice(idx, 1)
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }

      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort)
        this.current++
        resolve()
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  release(): void {
    this.current--
    const next = this.waiters.shift()
    if (next) next()
  }
}

// ---------------------------------------------------------------------------
// Built-in chunkers
// ---------------------------------------------------------------------------

/**
 * Splits text by newlines into groups of `linesPerChunk` lines.
 * Each chunk is an array of line strings.
 */
export class LineChunker implements Chunker<string[]> {
  constructor(private readonly linesPerChunk: number = 50) {}

  split(input: string): string[][] {
    const lines = input.split('\n')
    const chunks: string[][] = []

    for (let i = 0; i < lines.length; i += this.linesPerChunk) {
      chunks.push(lines.slice(i, i + this.linesPerChunk))
    }

    return chunks
  }
}

/**
 * Splits a newline-delimited list of file paths into groups
 * of `filesPerChunk` paths. Each chunk is an array of path strings.
 */
export class DirectoryChunker implements Chunker<string[]> {
  constructor(private readonly filesPerChunk: number = 10) {}

  split(input: string): string[][] {
    const files = input
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0)

    const chunks: string[][] = []

    for (let i = 0; i < files.length; i += this.filesPerChunk) {
      chunks.push(files.slice(i, i + this.filesPerChunk))
    }

    return chunks
  }
}

// ---------------------------------------------------------------------------
// MapReduceOrchestrator
// ---------------------------------------------------------------------------

export class MapReduceOrchestrator {
  private readonly registry: AdapterRegistry
  private readonly eventBus: DzipEventBus | undefined
  private readonly maxConcurrency: number

  constructor(config: MapReduceConfig) {
    this.registry = config.registry
    this.eventBus = config.eventBus
    this.maxConcurrency = config.maxConcurrency ?? 4
  }

  /**
   * Execute a full map-reduce pipeline.
   *
   * 1. Splits `input` using the chunker
   * 2. Maps each chunk through an adapter (bounded concurrency)
   * 3. Reduces all results into a single output
   */
  async execute<TChunk, TMapResult, TReduceResult>(
    input: string,
    options: MapReduceOptions<TChunk, TMapResult, TReduceResult>,
  ): Promise<MapReduceResult<TReduceResult>> {
    const { chunker, mapper, resultExtractor, reducer, signal } = options

    const pipelineStart = Date.now()

    // --- Split phase ---
    const chunks = chunker.split(input)

    this.emitEvent({
      type: 'mapreduce:started',
      totalChunks: chunks.length,
      maxConcurrency: this.maxConcurrency,
    })

    // --- Map phase ---
    const semaphore = new Semaphore(this.maxConcurrency)
    const mapResults: MapChunkResult<TMapResult>[] = []

    const mapTasks = chunks.map(
      (chunk, index) => this.mapChunk(chunk, index, mapper, resultExtractor, semaphore, signal),
    )

    const settled = await Promise.allSettled(mapTasks)

    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        mapResults.push(outcome.value)
      } else {
        const error = outcome.reason instanceof Error
          ? outcome.reason
          : new Error(String(outcome.reason))
        mapResults.push({
          chunkIndex: index,
          providerId: null,
          result: undefined as TMapResult,
          rawResult: '',
          success: false,
          durationMs: 0,
          error: error.message,
        })
      }
    }

    // Sort by chunk index so the reducer always receives deterministic ordering
    mapResults.sort((a, b) => a.chunkIndex - b.chunkIndex)

    const successCount = mapResults.filter((r) => r.success).length
    const failCount = mapResults.length - successCount

    this.emitEvent({
      type: 'mapreduce:map_completed',
      totalChunks: chunks.length,
      successfulChunks: successCount,
      failedChunks: failCount,
    })

    // --- Reduce phase ---
    const reduceStart = Date.now()
    const result = reducer(mapResults)
    const reduceDurationMs = Date.now() - reduceStart

    const totalDurationMs = Date.now() - pipelineStart

    this.emitEvent({
      type: 'mapreduce:completed',
      totalChunks: chunks.length,
      successfulChunks: successCount,
      failedChunks: failCount,
      totalDurationMs,
      reduceDurationMs,
    })

    return {
      result,
      chunks: chunks.length,
      successfulChunks: successCount,
      failedChunks: failCount,
      totalDurationMs,
      perChunkStats: mapResults.map((r) => ({
        index: r.chunkIndex,
        providerId: r.providerId,
        durationMs: r.durationMs,
        success: r.success,
      })),
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async mapChunk<TChunk, TMapResult>(
    chunk: TChunk,
    index: number,
    mapper: MapperFn<TChunk>,
    resultExtractor: (raw: string, chunk: TChunk) => TMapResult,
    semaphore: Semaphore,
    signal?: AbortSignal,
  ): Promise<MapChunkResult<TMapResult>> {
    await semaphore.acquire(signal)
    const chunkStart = Date.now()

    try {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      const { input, task } = mapper(chunk, index)
      const inputWithSignal: AgentInput = signal ? { ...input, signal } : input

      // Consume the async generator and capture the completed event
      let completedEvent: AgentCompletedEvent | undefined
      let lastProviderId: AdapterProviderId | null = null

      const gen = this.registry.executeWithFallback(inputWithSignal, task)

      for await (const event of gen) {
        lastProviderId = this.extractProviderId(event)
        if (event.type === 'adapter:completed') {
          completedEvent = event
        }
      }

      if (!completedEvent) {
        return {
          chunkIndex: index,
          providerId: lastProviderId,
          result: undefined as TMapResult,
          rawResult: '',
          success: false,
          durationMs: Date.now() - chunkStart,
          error: 'No adapter:completed event received',
        }
      }

      const rawResult = completedEvent.result
      const typedResult = resultExtractor(rawResult, chunk)

      this.emitEvent({
        type: 'mapreduce:chunk_completed',
        chunkIndex: index,
        providerId: completedEvent.providerId,
        durationMs: Date.now() - chunkStart,
        success: true,
      })

      return {
        chunkIndex: index,
        providerId: completedEvent.providerId,
        result: typedResult,
        rawResult,
        success: true,
        durationMs: Date.now() - chunkStart,
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const durationMs = Date.now() - chunkStart

      this.emitEvent({
        type: 'mapreduce:chunk_failed',
        chunkIndex: index,
        error: error.message,
        durationMs,
      })

      return {
        chunkIndex: index,
        providerId: null, // unknown at failure time
        result: undefined as TMapResult,
        rawResult: '',
        success: false,
        durationMs,
        error: error.message,
      }
    } finally {
      semaphore.release()
    }
  }

  private extractProviderId(event: AgentEvent): AdapterProviderId | null {
    if ('providerId' in event) {
      return event.providerId
    }
    return null
  }

  private emitEvent(
    event:
      | { type: 'mapreduce:started'; totalChunks: number; maxConcurrency: number }
      | {
          type: 'mapreduce:map_completed'
          totalChunks: number
          successfulChunks: number
          failedChunks: number
        }
      | {
          type: 'mapreduce:completed'
          totalChunks: number
          successfulChunks: number
          failedChunks: number
          totalDurationMs: number
          reduceDurationMs: number
        }
      | {
          type: 'mapreduce:chunk_completed'
          chunkIndex: number
          providerId: AdapterProviderId
          durationMs: number
          success: boolean
        }
      | { type: 'mapreduce:chunk_failed'; chunkIndex: number; error: string; durationMs: number },
  ): void {
    if (this.eventBus) {
      // Map-reduce events are domain-specific extensions; cast through unknown.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.eventBus.emit(event as unknown as Parameters<DzipEventBus['emit']>[0])
    }
  }
}
