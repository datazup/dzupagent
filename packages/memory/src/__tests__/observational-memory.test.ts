import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ObservationalMemory } from '../observational-memory.js'
import type { ObservationLifecycleEvent } from '../observational-memory.js'
import type { ObservationalMemoryConfig } from '../observational-memory.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseStore } from '@langchain/langgraph'
import { MemoryService } from '../memory-service.js'
import { createStore } from '../store-factory.js'
import { MemoryServiceObservationCandidateStore } from '../observation-candidate-store.js'
import type { ObservationCandidateStore } from '../observation-candidate-store.js'
import { StagedWriter } from '../staged-writer.js'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import { createStoreDouble } from './helpers/store-double.js'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Shared InMemoryStore double (DZUPAGENT-TEST-H-09): `search` honours the
 * namespace prefix and the default limit of 10, unlike the key-only map this
 * replaced, so a reflector that searches the wrong namespace finds nothing.
 */
function createMockStore(): BaseStore {
  return createStoreDouble().store
}

function createMockModel(responses: string[]) {
  let callIndex = 0
  const invoke = vi.fn().mockImplementation(() => {
    const idx = callIndex++
    const content = idx < responses.length ? responses[idx] : '[]'
    return Promise.resolve({ content })
  })

  return { invoke } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
}

function createMockMemoryService(
  existingRecords: Record<string, unknown>[] = [],
): MemoryService & {
  put: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  formatForPrompt: ReturnType<typeof vi.fn>
} {
  // Annotated: without it the `as const` seed infers a `existing-${number}`
  // template-literal key type, so the mock's own put/get (which take a plain
  // `string` key) become unassignable.
  const data = new Map<string, Record<string, unknown>>(
    existingRecords.map((record, index) => [`existing-${index}`, record] as const),
  )
  return {
    put: vi.fn().mockImplementation(
      (_namespace: string, _scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        data.set(key, value)
        return Promise.resolve()
      },
    ),
    get: vi.fn().mockImplementation(
      (_namespace: string, _scope: Record<string, string>, key?: string) => {
        if (key !== undefined) {
          const value = data.get(key)
          return Promise.resolve(value ? [value] : [])
        }
        return Promise.resolve([...data.values()])
      },
    ),
    search: vi.fn().mockResolvedValue(existingRecords),
    formatForPrompt: vi.fn().mockReturnValue('## Relevant Observations\n\nSome observation'),
    getNamespaceTuple: vi.fn().mockImplementation(
      (namespace: string, scope: Record<string, string>) => [namespace, ...Object.values(scope)],
    ),
  } as unknown as MemoryService & {
    put: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
    formatForPrompt: ReturnType<typeof vi.fn>
  }
}

function makeMessages(count: number): BaseMessage[] {
  const msgs: BaseMessage[] = []
  for (let i = 0; i < count; i++) {
    msgs.push(i % 2 === 0
      ? new HumanMessage(`Message ${i}`)
      : new AIMessage(`Response ${i}`),
    )
  }
  return msgs
}

function textMessages(...texts: string[]): BaseMessage[] {
  return texts.map(text => new HumanMessage(text))
}

/** Message contents the observer presented to the model on one invoke call. */
function extractionInput(
  model: { invoke: ReturnType<typeof vi.fn> },
  callIndex: number,
): string[] {
  const prompt = model.invoke.mock.calls[callIndex]![0] as BaseMessage[]
  const text = prompt[1]!.content as string
  return [...text.matchAll(/^\[m\d+\] \w+: (.*)$/gm)].map(match => match[1]!)
}

/** Private trigger counter next to the buffer it counts. */
function bufferState(memory: ObservationalMemory): { counted: number; buffered: number } {
  const internals = memory as unknown as {
    messagesSinceLastRun: number
    pendingMessages: BaseMessage[]
  }
  return {
    counted: internals.messagesSinceLastRun,
    buffered: internals.pendingMessages.length,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** LLM response that returns observations as JSON */
function observationResponse(observations: Array<{ text: string; category: string; confidence: number }>): string {
  return JSON.stringify(observations.map(observation => ({
    ...observation,
    evidenceRefs: ['m1'],
  })))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ObservationalMemory', () => {
  let model: BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
  let memoryService: ReturnType<typeof createMockMemoryService>
  let store: BaseStore
  let sut: ObservationalMemory

  const defaultScope = { tenantId: 't1', observations: 'obs' }

  function createOM(overrides?: Partial<ObservationalMemoryConfig>): ObservationalMemory {
    return new ObservationalMemory({
      model,
      memoryService: memoryService as unknown as MemoryService,
      store,
      namespace: 'observations',
      scope: defaultScope,
      observerDebounceMs: 0, // disable debounce by default in tests
      ...overrides,
    })
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    model = createMockModel([
      observationResponse([
        { text: 'User prefers dark mode', category: 'preference', confidence: 0.9 },
        { text: 'Project uses TypeScript', category: 'fact', confidence: 0.95 },
      ]),
    ])
    memoryService = createMockMemoryService()
    store = createMockStore()
    sut = createOM()
  })

  // -----------------------------------------------------------------------
  // observe() — threshold gating
  // -----------------------------------------------------------------------

  describe('observe()', () => {
    it('should return null when message count is below observerThreshold', async () => {
      sut = createOM({ observerThreshold: 10 })
      const messages = makeMessages(5)
      const result = await sut.observe(messages)
      expect(result).toBeNull()
    })

    it('should return null when exactly at threshold minus one (accumulates across calls)', async () => {
      sut = createOM({ observerThreshold: 10 })
      // First call with 4 messages
      const result1 = await sut.observe(makeMessages(4))
      expect(result1).toBeNull()
      // Second call with 5 messages (total = 9, still below 10)
      const result2 = await sut.observe(makeMessages(5))
      expect(result2).toBeNull()
    })

    it('should extract and store observations when threshold is reached', async () => {
      sut = createOM({ observerThreshold: 5 })
      const messages = makeMessages(6)
      const result = await sut.observe(messages)

      expect(result).not.toBeNull()
      expect(result!.extracted.length).toBeGreaterThan(0)
      expect(memoryService.put).toHaveBeenCalled()
      expect(result!.persisted).toHaveLength(result!.extracted.length)
      expect(result!.staged).toEqual([])
      expect(result!.rejected).toEqual([])

      const storedValue = memoryService.put.mock.calls[0]![3] as Record<string, unknown>
      expect(storedValue['modelGenerated']).toBe(true)
      expect(storedValue['promptVersion']).toBe('observation-extraction/v3')
      expect(storedValue['evidenceReferences']).toEqual([
        expect.objectContaining({
          ref: expect.stringMatching(/^observation-message:/),
          role: 'human',
          excerpt: 'Message 0',
        }),
      ])
      expect(storedValue['_provenance']).toMatchObject({
        createdBy: 'forge://dzupagent/observer',
        source: 'derived',
      })
    })

    it('should accumulate message count across multiple observe() calls', async () => {
      sut = createOM({ observerThreshold: 10 })
      // First call: 6 messages (below 10)
      await sut.observe(makeMessages(6))
      // Second call: 5 messages (total 11, above 10)
      const result = await sut.observe(makeMessages(5))
      expect(result).not.toBeNull()
      expect(result!.extracted.length).toBeGreaterThan(0)
    })

    it('should reset messagesSinceLastRun after a successful run', async () => {
      sut = createOM({ observerThreshold: 3 })
      // First run succeeds
      const result1 = await sut.observe(makeMessages(4))
      expect(result1).not.toBeNull()

      // Second call with just 2 messages (below threshold after reset)
      const result2 = await sut.observe(makeMessages(2))
      expect(result2).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // observe() — extraction input is the delta since the last success (MEM-01)
  // -----------------------------------------------------------------------

  describe('observe() message buffer', () => {
    it('extracts every message accumulated across below-threshold calls', async () => {
      sut = createOM({ observerThreshold: 6 })

      expect(await sut.observe(textMessages('delta-1-a', 'delta-1-b'))).toBeNull()
      expect(await sut.observe(textMessages('delta-2-a', 'delta-2-b'))).toBeNull()
      const result = await sut.observe(textMessages('delta-3-a', 'delta-3-b'))

      expect(result).not.toBeNull()
      expect(model.invoke).toHaveBeenCalledTimes(1)
      expect(extractionInput(model, 0)).toEqual([
        'delta-1-a', 'delta-1-b',
        'delta-2-a', 'delta-2-b',
        'delta-3-a', 'delta-3-b',
      ])
    })

    it('keeps messages that arrive during an in-flight run for the next run only', async () => {
      const firstInvoke = deferred<{ content: string }>()
      model.invoke.mockImplementationOnce(() => firstInvoke.promise)
      sut = createOM({ observerThreshold: 2 })

      const firstRun = sut.observe(textMessages('first-a', 'first-b'))
      await vi.waitFor(() => expect(model.invoke).toHaveBeenCalledTimes(1))
      expect(await sut.observe(textMessages('during-run'))).toBeNull()
      firstInvoke.resolve({ content: '[]' })
      expect(await firstRun).not.toBeNull()

      const secondRun = await sut.observe(textMessages('after-run'))

      expect(secondRun).not.toBeNull()
      expect(model.invoke).toHaveBeenCalledTimes(2)
      expect(extractionInput(model, 0)).toEqual(['first-a', 'first-b'])
      expect(extractionInput(model, 1)).toEqual(['during-run', 'after-run'])
    })

    it('keeps a failed run\'s messages for the retry', async () => {
      memoryService.get.mockRejectedValueOnce(new Error('store connection lost'))
      sut = createOM({ observerThreshold: 2 })

      expect(await sut.observe(textMessages('failed-a', 'failed-b'))).toBeNull()
      const retry = await sut.observe(textMessages('retry-c'))

      expect(retry).not.toBeNull()
      expect(model.invoke).toHaveBeenCalledTimes(2)
      expect(extractionInput(model, 1)).toEqual(['failed-a', 'failed-b', 'retry-c'])
    })

    it('bounds the buffer, dropping the oldest messages and reporting the drop count', async () => {
      const events: ObservationLifecycleEvent[] = []
      sut = createOM({
        observerThreshold: 1,
        onObservationLifecycleEvent: event => events.push(event),
      })
      const texts = Array.from({ length: 250 }, (_, index) => `bounded-${index}`)

      const result = await sut.observe(textMessages(...texts))

      expect(result).not.toBeNull()
      expect(extractionInput(model, 0)).toEqual(texts.slice(50))
      expect(events).toContainEqual(expect.objectContaining({
        type: 'observation:candidate:pruned',
        count: 50,
        reason: expect.stringContaining('observer message buffer'),
      }))
    })

    it('does not let a run that fails after reset() restore its messages', async () => {
      const pendingGet = deferred<Record<string, unknown>[]>()
      memoryService.get.mockImplementationOnce(() => pendingGet.promise)
      sut = createOM({ observerThreshold: 2 })

      const firstRun = sut.observe(textMessages('stale-a', 'stale-b'))
      await vi.waitFor(() => expect(memoryService.get).toHaveBeenCalledTimes(1))
      sut.reset()
      pendingGet.reject(new Error('store connection lost'))
      expect(await firstRun).toBeNull()

      const next = await sut.observe(textMessages('fresh-a', 'fresh-b'))

      expect(next).not.toBeNull()
      expect(extractionInput(model, 1)).toEqual(['fresh-a', 'fresh-b'])
    })

    it('keeps messages that arrive after reset() during an in-flight run', async () => {
      const firstInvoke = deferred<{ content: string }>()
      model.invoke.mockImplementationOnce(() => firstInvoke.promise)
      sut = createOM({ observerThreshold: 2 })

      const firstRun = sut.observe(textMessages('stale-a', 'stale-b'))
      await vi.waitFor(() => expect(model.invoke).toHaveBeenCalledTimes(1))
      sut.reset()
      expect(await sut.observe(textMessages('fresh-a'))).toBeNull()
      firstInvoke.resolve({ content: '[]' })
      await firstRun

      const next = await sut.observe(textMessages('fresh-b'))

      expect(next).not.toBeNull()
      expect(extractionInput(model, 1)).toEqual(['fresh-a', 'fresh-b'])
    })

    it('stops counting messages the buffer cap dropped while debounced', async () => {
      sut = createOM({ observerThreshold: 2, observerDebounceMs: 60_000 })
      expect(await sut.observe(textMessages('first-a', 'first-b'))).not.toBeNull()

      const texts = Array.from({ length: 250 }, (_, index) => `debounced-${index}`)
      expect(await sut.observe(textMessages(...texts))).toBeNull()

      expect(bufferState(sut)).toEqual({ counted: 200, buffered: 200 })
    })

    it('stops counting messages the buffer cap dropped when a failed run restores its batch', async () => {
      const pendingGet = deferred<Record<string, unknown>[]>()
      memoryService.get.mockImplementationOnce(() => pendingGet.promise)
      sut = createOM({ observerThreshold: 2 })

      const firstRun = sut.observe(textMessages('failed-a', 'failed-b'))
      await vi.waitFor(() => expect(memoryService.get).toHaveBeenCalledTimes(1))
      const texts = Array.from({ length: 250 }, (_, index) => `during-${index}`)
      expect(await sut.observe(textMessages(...texts))).toBeNull()
      pendingGet.reject(new Error('store connection lost'))
      expect(await firstRun).toBeNull()

      expect(bufferState(sut)).toEqual({ counted: 200, buffered: 200 })
    })
  })

  // -----------------------------------------------------------------------
  // observe() — retry after a run that failed past persistence
  // -----------------------------------------------------------------------

  describe('observe() retry after a partially persisted run', () => {
    const extracted = [
      { text: 'User prefers dark mode', category: 'preference', confidence: 0.9 },
      { text: 'Project uses TypeScript', category: 'fact', confidence: 0.95 },
    ]

    async function storedTexts(): Promise<string[]> {
      const records = await sut.getObservations()
      return records.map(record => record['text'] as string).sort()
    }

    it('does not store a duplicate when candidate cleanup throws after flushConfirmedObservations persisted', async () => {
      model = createMockModel([observationResponse(extracted), observationResponse(extracted)])
      const candidateStore: ObservationCandidateStore = {
        load: vi.fn().mockResolvedValue([]),
        put: vi.fn().mockResolvedValue(true),
        remove: vi.fn()
          .mockRejectedValueOnce(new Error('candidate database down'))
          .mockResolvedValue(true),
        getReceipt: vi.fn().mockResolvedValue(null),
        putReceipt: vi.fn().mockResolvedValue(true),
        prune: vi.fn().mockResolvedValue(0),
      }
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
        candidateStore,
        // Auto-confirms both extractions so the observer run itself flushes them.
        stagedWriter: new StagedWriter(),
      })

      expect(await sut.observe(makeMessages(2))).toBeNull()
      // The first confirmed record was persisted before cleanup threw.
      expect(await storedTexts()).toEqual(['User prefers dark mode'])

      const retry = await sut.observe([])

      expect(retry).not.toBeNull()
      expect(model.invoke).toHaveBeenCalledTimes(2)
      expect(retry!.skippedDuplicates).toBe(1)
      expect(retry!.persisted.map(observation => observation.text)).toEqual([
        'Project uses TypeScript',
      ])
      expect(await storedTexts()).toEqual(['Project uses TypeScript', 'User prefers dark mode'])
      expect(memoryService.put).toHaveBeenCalledTimes(2)
    })

    it('does not store a duplicate when a direct write throws after an earlier one persisted', async () => {
      model = createMockModel([observationResponse(extracted), observationResponse(extracted)])
      const put = memoryService.put.getMockImplementation()!
      memoryService.put
        .mockImplementationOnce(put)
        .mockRejectedValueOnce(new Error('write failed'))
      sut = createOM({ observerThreshold: 1 })

      expect(await sut.observe(makeMessages(2))).toBeNull()
      expect(await storedTexts()).toEqual(['User prefers dark mode'])

      const retry = await sut.observe([])

      expect(retry).not.toBeNull()
      expect(retry!.skippedDuplicates).toBe(1)
      expect(await storedTexts()).toEqual(['Project uses TypeScript', 'User prefers dark mode'])
    })
  })

  // -----------------------------------------------------------------------
  // observe() — governed candidate-first persistence
  // -----------------------------------------------------------------------

  describe('candidate-first persistence', () => {
    it('emits non-sensitive candidate lifecycle events for host adapters', async () => {
      const events: ObservationLifecycleEvent[] = []
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
        observationRunId: 'run-events',
        onObservationLifecycleEvent: event => events.push(event),
      })

      const result = await sut.observe(makeMessages(2))
      const candidate = result!.staged[0]!
      await sut.confirmObservation(candidate.key)
      await sut.rejectObservation(result!.staged[1]!.key)

      expect(events.map(event => event['type'])).toEqual(
        expect.arrayContaining([
          'observation:candidate:captured',
          'observation:candidate:promoted',
          'observation:candidate:confirmed',
          'observation:candidate:rejected',
        ]),
      )
      const captured = events.find(event =>
        event['type'] === 'observation:candidate:captured'
        && event['candidateKey'] === candidate.key)
      expect(captured).toMatchObject({
        schema: 'dzupagent/observation-lifecycle-event/v1',
        namespace: 'observations',
        scope: defaultScope,
        stage: 'captured',
        evidenceRefs: [
          expect.stringMatching(/^observation-message:run-events:/),
        ],
      })
      expect(captured).not.toHaveProperty('value')
      expect(captured).not.toHaveProperty('excerpt')
    })

    it('keeps lifecycle handler failures non-fatal', async () => {
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
        onObservationLifecycleEvent: () => {
          throw new Error('telemetry unavailable')
        },
      })

      const result = await sut.observe(makeMessages(2))

      expect(result?.staged).toHaveLength(2)
    })

    it('stages model-written observations without writing long-term memory', async () => {
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
      })

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      expect(result!.extracted).toHaveLength(2)
      expect(result!.persisted).toEqual([])
      expect(result!.staged).toHaveLength(2)
      expect(memoryService.put).not.toHaveBeenCalled()
      expect(sut.getPendingObservationCandidates()).toHaveLength(2)
      expect(sut.getStats().totalObservations).toBe(0)
    })

    it('persists a confirmed candidate with model-derived provenance', async () => {
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
        observerAgentUri: 'forge://acme/memory-observer',
      })
      const result = await sut.observe(makeMessages(2))
      const candidate = result!.staged[0]!

      const persisted = await sut.confirmObservation(candidate.key)

      expect(persisted).toBe(true)
      expect(memoryService.put).toHaveBeenCalledTimes(1)
      expect(sut.getPendingObservationCandidates()).toHaveLength(1)
      expect(sut.getStats().totalObservations).toBe(1)

      const storedValue = memoryService.put.mock.calls[0]![3] as Record<string, unknown>
      expect(storedValue['_provenance']).toMatchObject({
        createdBy: 'forge://acme/memory-observer',
        source: 'derived',
        confidence: candidate.confidence,
      })
    })

    it('refuses promotion when candidate evidence is missing or invalid', async () => {
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
      })
      const result = await sut.observe(makeMessages(2))
      const candidate = result!.staged[0]!
      candidate.value['evidenceReferences'] = []

      await expect(sut.confirmObservation(candidate.key)).resolves.toBe(false)
      expect(memoryService.put).not.toHaveBeenCalled()
    })

    it('allows a staged candidate to be rejected without persistence', async () => {
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
      })
      const result = await sut.observe(makeMessages(2))
      const candidate = result!.staged[0]!

      expect(await sut.rejectObservation(candidate.key)).toBe(true)
      expect(await sut.confirmObservation(candidate.key)).toBe(false)
      expect(memoryService.put).not.toHaveBeenCalled()
    })

    it('restores a confirmed candidate when durable persistence cannot be verified', async () => {
      const events: string[] = []
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
        onObservationLifecycleEvent: event => events.push(event.type),
      })
      const result = await sut.observe(makeMessages(2))
      const candidate = result!.staged[0]!
      memoryService.get.mockResolvedValue([])

      const persisted = await sut.confirmObservation(candidate.key)

      expect(persisted).toBe(false)
      expect(sut.getPendingObservationCandidates()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: candidate.key, stage: 'confirmed' }),
        ]),
      )
      expect(sut.getStats().totalObservations).toBe(0)
      expect(events).toEqual(expect.arrayContaining([
        'observation:candidate:persistence-failed',
        'observation:candidate:restored',
      ]))
    })

    it('rejects model output containing a secret before it reaches staging', async () => {
      model = createMockModel([
        observationResponse([
          {
            text: 'api_key=abcdefghijklmnopqrstuvwxyz123456',
            category: 'fact',
            confidence: 0.99,
          },
        ]),
      ])
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
      })

      const result = await sut.observe(makeMessages(2))

      expect(result!.extracted).toEqual([])
      expect(result!.rejected).toHaveLength(1)
      expect(result!.staged).toEqual([])
      expect(memoryService.put).not.toHaveBeenCalled()
    })

    it('restores candidates after restart and makes confirmation idempotent', async () => {
      const candidateMemory = new MemoryService(
        createMockStore(),
        [{
          name: 'observation-candidates',
          scopeKeys: ['tenantId', 'observations'],
          searchable: false,
        }],
      )
      const candidateStore = new MemoryServiceObservationCandidateStore(
        candidateMemory,
        'observation-candidates',
      )
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
        candidateStore,
      })
      const result = await sut.observe(makeMessages(2))
      const candidate = result!.staged[0]!

      const restartEvents: string[] = []
      const restarted = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
        candidateStore,
        onObservationLifecycleEvent: event => restartEvents.push(event.type),
      })
      expect(await restarted.listPendingObservationCandidates()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: candidate.key, stage: 'candidate' }),
        ]),
      )
      expect(restartEvents).toContain('observation:candidate:restored')

      expect(await restarted.confirmObservation(candidate.key)).toBe(true)
      expect(memoryService.put).toHaveBeenCalledTimes(1)

      const restartedAgain = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
        candidateStore,
      })
      expect(await restartedAgain.listPendingObservationCandidates()).toHaveLength(1)
      expect(await restartedAgain.confirmObservation(candidate.key)).toBe(true)
      expect(memoryService.put).toHaveBeenCalledTimes(1)
    })

    it('emits the count removed by persistent retention pruning', async () => {
      const events: ObservationLifecycleEvent[] = []
      const candidateStore: ObservationCandidateStore = {
        load: vi.fn().mockResolvedValue([]),
        put: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true),
        getReceipt: vi.fn().mockResolvedValue(null),
        putReceipt: vi.fn().mockResolvedValue(true),
        prune: vi.fn().mockResolvedValue(3),
      }
      sut = createOM({
        observationWriteMode: 'candidate-first',
        candidateStore,
        onObservationLifecycleEvent: event => events.push(event),
      })

      await sut.initializeObservationCandidates()

      expect(events).toContainEqual(expect.objectContaining({
        type: 'observation:candidate:pruned',
        count: 3,
        reason: 'candidate retention policy',
      }))
    })

    it('keeps capture usable and emits persistence failure when the store throws', async () => {
      const events: string[] = []
      const candidateStore: ObservationCandidateStore = {
        load: vi.fn().mockResolvedValue([]),
        put: vi.fn().mockRejectedValue(new Error('candidate database down')),
        remove: vi.fn().mockResolvedValue(true),
        getReceipt: vi.fn().mockResolvedValue(null),
        putReceipt: vi.fn().mockResolvedValue(true),
        prune: vi.fn().mockResolvedValue(0),
      }
      sut = createOM({
        observerThreshold: 1,
        observationWriteMode: 'candidate-first',
        candidateStore,
        onObservationLifecycleEvent: event => events.push(event.type),
      })

      const result = await sut.observe(makeMessages(2))

      expect(result?.staged).toHaveLength(2)
      expect(events).toContain('observation:candidate:persistence-failed')
    })
  })

  // -----------------------------------------------------------------------
  // observe() — deduplication
  // -----------------------------------------------------------------------

  describe('deduplication', () => {
    it('should skip observations similar to existing memory (Jaccard > 0.7)', async () => {
      // Existing memory has a very similar observation
      memoryService = createMockMemoryService([
        { text: 'User prefers dark mode' },
      ])
      sut = createOM({ observerThreshold: 1 })

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      expect(result!.skippedDuplicates).toBeGreaterThan(0)
      // "User prefers dark mode" should be skipped, "Project uses TypeScript" should be kept
      const addedTexts = result!.extracted.map(o => o.text)
      expect(addedTexts).not.toContain('User prefers dark mode')
    })

    it('should keep observations that are sufficiently different from existing', async () => {
      // Existing memory has something completely different
      memoryService = createMockMemoryService([
        { text: 'Codebase uses Python with Flask framework' },
      ])
      sut = createOM({ observerThreshold: 1 })

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      expect(result!.extracted.length).toBe(2)
      expect(result!.skippedDuplicates).toBe(0)
    })

    it('should deduplicate within the same extraction batch', async () => {
      // Model returns two nearly identical observations (same words, slightly reordered)
      model = createMockModel([
        observationResponse([
          { text: 'the user prefers dark mode for the UI', category: 'preference', confidence: 0.9 },
          { text: 'the user prefers dark mode for UI', category: 'preference', confidence: 0.85 },
          { text: 'Project uses Rust programming language', category: 'fact', confidence: 0.95 },
        ]),
      ])
      sut = createOM({ observerThreshold: 1 })

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      // The second observation has high Jaccard overlap with the first => skipped
      expect(result!.skippedDuplicates).toBeGreaterThanOrEqual(1)
    })
  })

  // -----------------------------------------------------------------------
  // observe() — reflector trigger
  // -----------------------------------------------------------------------

  describe('reflector trigger', () => {
    it('should trigger reflector when observation count exceeds reflectorThreshold', async () => {
      // Set very low thresholds for testing
      sut = createOM({
        observerThreshold: 1,
        reflectorThreshold: 1, // trigger after just 1 observation
      })

      // Mock memory service to return enough records for reflector
      memoryService.get.mockResolvedValue([
        { text: 'obs1', confidence: 0.9 },
        { text: 'obs2', confidence: 0.8 },
      ])

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      expect(result!.triggeredReflector).toBe(true)
    })

    it('should not trigger reflector when below reflectorThreshold', async () => {
      sut = createOM({
        observerThreshold: 1,
        reflectorThreshold: 1000, // very high threshold
      })

      const result = await sut.observe(makeMessages(2))

      expect(result).not.toBeNull()
      expect(result!.triggeredReflector).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // reflect()
  // -----------------------------------------------------------------------

  describe('reflect()', () => {
    it('should run SemanticConsolidator via reflect()', async () => {
      // Provide records so the reflector has something to work with
      memoryService.get.mockResolvedValue([
        { text: 'obs1', confidence: 0.9 },
        { text: 'obs2', confidence: 0.8 },
      ])

      // The consolidator will call model.invoke
      model = createMockModel([
        JSON.stringify({ action: 'noop', reason: 'unique' }),
        JSON.stringify({ action: 'noop', reason: 'unique' }),
      ])
      sut = createOM()

      const result = await sut.reflect()

      expect(result.before).toBe(2)
      expect(result).toHaveProperty('after')
      expect(result).toHaveProperty('merged')
      expect(result).toHaveProperty('pruned')
      expect(result).toHaveProperty('llmCallsUsed')
    })

    it('should return zeroes when no observations exist', async () => {
      memoryService.get.mockResolvedValue([])
      sut = createOM()

      const result = await sut.reflect()

      expect(result).toEqual({ before: 0, after: 0, merged: 0, pruned: 0, llmCallsUsed: 0 })
    })

    it('should prune low-confidence entries when over reflectorTargetCount', async () => {
      // Create more records than the target count
      const records = Array.from({ length: 10 }, (_, i) => ({
        text: `observation ${i}`,
        confidence: i * 0.1, // 0.0, 0.1, 0.2, ... 0.9
      }))
      memoryService.get
        .mockResolvedValueOnce(records)     // first call: before count
        .mockResolvedValueOnce(records)     // second call: after consolidation
        .mockResolvedValueOnce(records.slice(5)) // third call: after pruning

      // Store also returns records for the pruning step, under the tuple
      // MemoryService derives for the namespace (name first, then scope values).
      const observationsTuple = ['observations', ...Object.values(defaultScope)]
      const double = createStoreDouble()
      for (const [i, r] of records.entries()) {
        await double.seed(observationsTuple, `obs-${i}`, r as unknown as Record<string, unknown>)
      }
      // A sibling namespace sharing the scope values must never be pruned.
      await double.seed(Object.values(defaultScope), 'not-an-observation', { text: 'other', confidence: 0 })
      store = double.store

      sut = createOM({
        reflectorTargetCount: 5,
      })

      const result = await sut.reflect()

      expect(result.before).toBe(10)
      expect(double.del).toHaveBeenCalled()
      for (const call of double.del.mock.calls) {
        expect(call[0]).toEqual(observationsTuple)
      }
      expect(await double.records(Object.values(defaultScope))).toHaveLength(1)
    })
  })

  describe('reflect() against a real MemoryService namespace (DZUPAGENT-AGENT-H-66)', () => {
    it('prunes the lowest-confidence observations from the namespace MemoryService wrote', async () => {
      const realStore = await createStore({ type: 'memory' })
      const scope = { tenantId: 't1', agentId: 'a1' }
      const realService = new MemoryService(realStore, [
        { name: 'observations', scopeKeys: ['tenantId', 'agentId'] },
      ])
      // An unrelated namespace sharing the scope values must be untouched.
      const otherService = new MemoryService(realStore, [
        { name: 'facts', scopeKeys: ['tenantId', 'agentId'] },
      ])
      for (let i = 0; i < 8; i++) {
        await realService.put('observations', scope, `obs-${i}`, {
          text: `distinct observation number ${i} about topic ${String.fromCharCode(97 + i)}`,
          confidence: (i + 1) / 10,
        })
      }
      await otherService.put('facts', scope, 'fact-0', { text: 'keep me', confidence: 0.01 })

      const om = new ObservationalMemory({
        model: createMockModel(Array.from({ length: 50 }, () => JSON.stringify({ action: 'noop', reason: 'unique' }))),
        memoryService: realService,
        store: realStore,
        namespace: 'observations',
        scope,
        observerDebounceMs: 0,
        reflectorTargetCount: 5,
        reflectorMaxLLMCalls: 0,
      })

      const result = await om.reflect()

      expect(result.before).toBe(8)
      expect(result.pruned).toBe(3)
      expect(result.after).toBe(5)
      const remaining = await realService.getKeyed('observations', scope)
      expect(remaining.map(r => r.key).sort()).toEqual(['obs-3', 'obs-4', 'obs-5', 'obs-6', 'obs-7'])
      expect(await otherService.get('facts', scope)).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // getStats()
  // -----------------------------------------------------------------------

  describe('getStats()', () => {
    it('should track observerRuns after observe()', async () => {
      sut = createOM({ observerThreshold: 1 })
      await sut.observe(makeMessages(2))

      const stats = sut.getStats()
      expect(stats.observerRuns).toBe(1)
      expect(stats.lastObserverRun).toBeTypeOf('number')
      expect(stats.totalObservations).toBeGreaterThan(0)
    })

    it('should track reflectorRuns after reflect()', async () => {
      memoryService.get.mockResolvedValue([
        { text: 'obs1', confidence: 0.9 },
      ])
      sut = createOM()
      await sut.reflect()

      const stats = sut.getStats()
      expect(stats.reflectorRuns).toBe(1)
      expect(stats.lastReflectorRun).toBeTypeOf('number')
    })

    it('should return a copy (not a reference) of stats', () => {
      const stats1 = sut.getStats()
      const stats2 = sut.getStats()
      expect(stats1).toEqual(stats2)
      expect(stats1).not.toBe(stats2)
    })

    it('should start with zeroed stats', () => {
      const stats = sut.getStats()
      expect(stats).toEqual({
        totalObservations: 0,
        observerRuns: 0,
        reflectorRuns: 0,
        lastObserverRun: null,
        lastReflectorRun: null,
      })
    })
  })

  // -----------------------------------------------------------------------
  // getRelevantObservations()
  // -----------------------------------------------------------------------

  describe('getRelevantObservations()', () => {
    it('should search and format results as a string', async () => {
      memoryService.search.mockResolvedValue([
        { text: 'User prefers dark mode' },
      ])

      const result = await sut.getRelevantObservations('preferences', 3)

      expect(memoryService.search).toHaveBeenCalledWith(
        'observations',
        defaultScope,
        'preferences',
        3,
      )
      expect(result).toContain('Observations')
    })

    it('should return empty string when no results found', async () => {
      memoryService.search.mockResolvedValue([])

      const result = await sut.getRelevantObservations('nonexistent')
      expect(result).toBe('')
    })

    it('should return empty string on search error', async () => {
      memoryService.search.mockRejectedValue(new Error('search failed'))

      const result = await sut.getRelevantObservations('anything')
      expect(result).toBe('')
    })
  })

  // -----------------------------------------------------------------------
  // reset()
  // -----------------------------------------------------------------------

  describe('reset()', () => {
    it('should clear all counters and timestamps', async () => {
      sut = createOM({ observerThreshold: 1 })
      await sut.observe(makeMessages(2))

      // Verify stats are non-zero
      expect(sut.getStats().observerRuns).toBe(1)

      sut.reset()

      const stats = sut.getStats()
      expect(stats).toEqual({
        totalObservations: 0,
        observerRuns: 0,
        reflectorRuns: 0,
        lastObserverRun: null,
        lastReflectorRun: null,
      })
    })

    it('should reset messagesSinceLastRun so observe() requires fresh messages', async () => {
      sut = createOM({ observerThreshold: 5 })
      // Add 4 messages (below threshold)
      await sut.observe(makeMessages(4))

      // Reset clears the accumulated count
      sut.reset()

      // Now 4 messages again should still be below threshold
      const result = await sut.observe(makeMessages(4))
      expect(result).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Debounce
  // -----------------------------------------------------------------------

  describe('debounce', () => {
    it('should return null if called within observerDebounceMs', async () => {
      sut = createOM({
        observerThreshold: 1,
        observerDebounceMs: 60_000, // 1 minute
      })

      // First call succeeds
      const result1 = await sut.observe(makeMessages(2))
      expect(result1).not.toBeNull()

      // Second call within debounce window returns null
      const result2 = await sut.observe(makeMessages(2))
      expect(result2).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Non-fatal error handling
  // -----------------------------------------------------------------------

  describe('non-fatal error handling', () => {
    it('returns null, keeps the batch and emits a failure event when LLM extraction fails (ERR-M-93)', async () => {
      model = {
        invoke: vi.fn()
          .mockRejectedValueOnce(new TypeError('LLM down: secret-endpoint'))
          .mockResolvedValue({ content: '[]' }),
      } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
      const events: ObservationLifecycleEvent[] = []
      sut = createOM({
        observerThreshold: 2,
        onObservationLifecycleEvent: event => events.push(event),
      })

      const result = await sut.observe(textMessages('kept-a', 'kept-b'))
      expect(result).toBeNull()
      expect(sut.getStats().observerRuns).toBe(0)
      expect(sut.getStats().lastObserverRun).toBeNull()
      expect(memoryService.put).not.toHaveBeenCalled()
      expect(events).toContainEqual(expect.objectContaining({
        type: 'observation:observer:failed',
        count: 2,
        reason: 'extraction-failed:TypeError',
      }))
      expect(JSON.stringify(events)).not.toContain('secret-endpoint')

      // The failed batch is retried together with the next messages.
      const retry = await sut.observe(textMessages('next-c'))
      expect(retry).not.toBeNull()
      expect(extractionInput(model, 1)).toEqual(['kept-a', 'kept-b', 'next-c'])
    })

    it('does not retry a failed extraction before observerDebounceMs elapses (ERR-M-93)', async () => {
      vi.useFakeTimers()
      try {
        model = {
          invoke: vi.fn()
            .mockRejectedValueOnce(new Error('LLM down'))
            .mockResolvedValue({ content: '[]' }),
        } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
        sut = createOM({ observerThreshold: 1, observerDebounceMs: 60_000 })

        expect(await sut.observe(makeMessages(2))).toBeNull()
        expect(model.invoke).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(30_000)
        expect(await sut.observe(makeMessages(1))).toBeNull()
        expect(model.invoke).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(30_001)
        expect(await sut.observe(makeMessages(1))).not.toBeNull()
        expect(model.invoke).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('should return null when memoryService.get throws during observe', async () => {
      model = createMockModel([
        observationResponse([
          { text: 'Some observation', category: 'fact', confidence: 0.9 },
        ]),
      ])
      memoryService.get.mockRejectedValue(new Error('store connection lost'))
      sut = createOM({ observerThreshold: 1 })

      const result = await sut.observe(makeMessages(2))
      // runObserver calls memoryService.get for dedup — error is caught by observe()'s try/catch
      expect(result).toBeNull()
    })

    it('should not crash when memoryService.put throws during observe', async () => {
      memoryService.put.mockRejectedValue(new Error('write failed'))
      sut = createOM({ observerThreshold: 1 })

      // persistObservation awaits provenanceWriter.put unguarded, so the
      // rejection propagates out of runObserver to observe()'s try/catch.
      // The write failure is therefore total, not partial: no ObserverResult
      // is returned and nothing is reported as persisted.
      const result = await sut.observe(makeMessages(2))
      expect(result).toBeNull()
    })

    it('should return empty array from getObservations() on error', async () => {
      memoryService.get.mockRejectedValue(new Error('broken'))
      const result = await sut.getObservations()
      expect(result).toEqual([])
    })
  })
})
