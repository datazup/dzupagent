import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { ObservationExtractor, type Observation } from '../observation-extractor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ModelInvocation {
  messages: BaseMessage[]
}

function createMockModel(responseContent: string): {
  model: BaseChatModel
  invocations: ModelInvocation[]
  invokeMock: ReturnType<typeof vi.fn>
} {
  const invocations: ModelInvocation[] = []
  const invokeMock = vi.fn().mockImplementation(async (messages: BaseMessage[]) => {
    invocations.push({ messages })
    return { content: responseContent }
  })
  const model = { invoke: invokeMock } as unknown as BaseChatModel
  return { model, invocations, invokeMock }
}

function createThrowingModel(error: Error): { model: BaseChatModel; invokeMock: ReturnType<typeof vi.fn> } {
  const invokeMock = vi.fn().mockRejectedValue(error)
  const model = { invoke: invokeMock } as unknown as BaseChatModel
  return { model, invokeMock }
}

function jsonResponse(observations: Array<Partial<Observation> & { text?: string; category?: string }>): string {
  return JSON.stringify(observations)
}

const sampleMessages = (): BaseMessage[] => [
  new HumanMessage('We should always use TypeScript strict mode'),
  new AIMessage('Understood. I will enforce strict mode throughout.'),
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ObservationExtractor', () => {
  describe('shouldExtract — minMessages', () => {
    it('returns false when messageCount < minMessages (default 10)', () => {
      const { model } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model })
      expect(extractor.shouldExtract(0)).toBe(false)
      expect(extractor.shouldExtract(5)).toBe(false)
      expect(extractor.shouldExtract(9)).toBe(false)
    })

    it('returns true when messageCount === minMessages (default 10)', () => {
      const { model } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model })
      expect(extractor.shouldExtract(10)).toBe(true)
    })

    it('returns true when messageCount > minMessages', () => {
      const { model } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model })
      expect(extractor.shouldExtract(50)).toBe(true)
    })

    it('respects custom minMessages = 3', () => {
      const { model } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model, minMessages: 3 })
      expect(extractor.shouldExtract(2)).toBe(false)
      expect(extractor.shouldExtract(3)).toBe(true)
      expect(extractor.shouldExtract(100)).toBe(true)
    })

    it('respects custom minMessages = 1', () => {
      const { model } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model, minMessages: 1 })
      expect(extractor.shouldExtract(0)).toBe(false)
      expect(extractor.shouldExtract(1)).toBe(true)
    })

    it('treats undefined minMessages as default (10)', () => {
      const { model } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model, minMessages: undefined })
      expect(extractor.shouldExtract(9)).toBe(false)
      expect(extractor.shouldExtract(10)).toBe(true)
    })
  })

  describe('shouldExtract — debounce window', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns false within debounce window after extract()', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 30_000 })
      await extractor.extract(sampleMessages())
      expect(extractor.shouldExtract(10)).toBe(false)
    })

    it('returns true after debounce window elapses', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 1000 })
      await extractor.extract(sampleMessages())
      expect(extractor.shouldExtract(10)).toBe(false)
      vi.advanceTimersByTime(1001)
      expect(extractor.shouldExtract(10)).toBe(true)
    })

    it('respects custom debounceMs = 5000', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 5000 })
      await extractor.extract(sampleMessages())
      vi.advanceTimersByTime(4999)
      expect(extractor.shouldExtract(10)).toBe(false)
      vi.advanceTimersByTime(2)
      expect(extractor.shouldExtract(10)).toBe(true)
    })

    it('default debounce is 30_000ms', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1 })
      await extractor.extract(sampleMessages())
      vi.advanceTimersByTime(29_999)
      expect(extractor.shouldExtract(10)).toBe(false)
      vi.advanceTimersByTime(2)
      expect(extractor.shouldExtract(10)).toBe(true)
    })

    it('debounceMs = 0 effectively disables debounce', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      // With debounce=0, the elapsed-time check `< 0` is false on next call → shouldExtract=true
      expect(extractor.shouldExtract(10)).toBe(true)
    })
  })

  describe('shouldExtract — maxObservations cap', () => {
    it('returns false when extractionCount >= maxObservations', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'fact', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({
        model,
        minMessages: 1,
        debounceMs: 0,
        maxObservations: 2,
      })

      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(2)
      expect(extractor.shouldExtract(10)).toBe(false)
    })

    it('returns false when extractionCount > maxObservations', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'fact', confidence: 0.9 },
          { text: 'C', category: 'fact', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({
        model,
        minMessages: 1,
        debounceMs: 0,
        maxObservations: 2,
      })
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(3)
      expect(extractor.shouldExtract(10)).toBe(false)
    })

    it('default maxObservations is 50', async () => {
      const { model } = createMockModel(
        jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(1)
      expect(extractor.shouldExtract(10)).toBe(true)
    })

    it('caller respects shouldExtract → model not called', async () => {
      const { model, invokeMock } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model, minMessages: 100 })
      if (extractor.shouldExtract(10)) {
        await extractor.extract(sampleMessages())
      }
      expect(invokeMock).not.toHaveBeenCalled()
    })

    it('returns false permanently after maxObservations until reset', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'fact', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({
        model,
        minMessages: 1,
        debounceMs: 0,
        maxObservations: 2,
      })
      await extractor.extract(sampleMessages())
      expect(extractor.shouldExtract(10)).toBe(false)
      // Multiple checks remain false
      expect(extractor.shouldExtract(10)).toBe(false)
      expect(extractor.shouldExtract(10)).toBe(false)
      // Reset clears the cap
      extractor.reset()
      expect(extractor.shouldExtract(10)).toBe(true)
    })
  })

  describe('shouldExtract — combined conditions', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns true when all conditions met', () => {
      const { model } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model })
      expect(extractor.shouldExtract(10)).toBe(true)
    })

    it('still false even with enough messages if debounced', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 60_000 })
      await extractor.extract(sampleMessages())
      expect(extractor.shouldExtract(1000)).toBe(false)
    })
  })

  describe('extract — JSON parsing', () => {
    it('parses valid JSON array — all fields populated', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'Project uses PostgreSQL', category: 'fact', confidence: 0.95 },
          { text: 'Dark mode preferred', category: 'preference', confidence: 0.8 },
        ]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toHaveLength(2)
      expect(observations[0]!.text).toBe('Project uses PostgreSQL')
      expect(observations[0]!.category).toBe('fact')
      expect(observations[0]!.confidence).toBe(0.95)
      expect(observations[1]!.text).toBe('Dark mode preferred')
      expect(observations[1]!.category).toBe('preference')
    })

    it('returns [] when model response has no JSON array', async () => {
      const { model } = createMockModel('Sorry, I cannot help with that.')
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toEqual([])
    })

    it('returns [] when JSON is malformed inside brackets', async () => {
      const { model } = createMockModel('[{"text": broken json')
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toEqual([])
    })

    it('returns [] for empty JSON array', async () => {
      const { model } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toEqual([])
    })

    it('extracts JSON array even when surrounded by other text', async () => {
      const { model } = createMockModel(
        'Here are the observations:\n[{"text": "Use ESM", "category": "convention", "confidence": 0.9}]\nThanks.',
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toHaveLength(1)
      expect(observations[0]!.text).toBe('Use ESM')
    })

    it('handles non-string content from model (array content form)', async () => {
      const invokeMock = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'no array' }],
      })
      const model = { invoke: invokeMock } as unknown as BaseChatModel
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toEqual([])
    })
  })

  describe('extract — error handling (non-fatal)', () => {
    it('returns [] when model.invoke throws', async () => {
      const { model } = createThrowingModel(new Error('LLM timeout'))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toEqual([])
    })

    it('does not bubble model errors to caller', async () => {
      const { model } = createThrowingModel(new Error('500 internal'))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await expect(extractor.extract(sampleMessages())).resolves.toEqual([])
    })

    it('returns [] when model returns empty content gracefully', async () => {
      const invokeMock = vi.fn().mockResolvedValue({ content: '' })
      const model = { invoke: invokeMock } as unknown as BaseChatModel
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toEqual([])
    })
  })

  describe('extract — category validation', () => {
    it('filters out observations with unknown category', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'unknown_cat', confidence: 0.9 },
          { text: 'C', category: 'preference', confidence: 0.9 },
          { text: 'D', category: 'random', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toHaveLength(2)
      expect(observations.map(o => o.text)).toEqual(['A', 'C'])
    })

    it('accepts all valid categories', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'fact-obs', category: 'fact', confidence: 0.9 },
          { text: 'pref-obs', category: 'preference', confidence: 0.9 },
          { text: 'dec-obs', category: 'decision', confidence: 0.9 },
          { text: 'conv-obs', category: 'convention', confidence: 0.9 },
          { text: 'cons-obs', category: 'constraint', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toHaveLength(5)
    })

    it('filters out observations with missing category', async () => {
      const { model } = createMockModel(JSON.stringify([{ text: 'A', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toEqual([])
    })

    it('filters out observations with missing text', async () => {
      const { model } = createMockModel(JSON.stringify([{ category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations).toEqual([])
    })

    it('filters out observations with empty text string', async () => {
      const { model } = createMockModel(JSON.stringify([{ text: '', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      // Empty text is falsy → filtered out
      expect(observations).toEqual([])
    })
  })

  describe('extract — confidence clamping', () => {
    it('clamps confidence above 1.0 down to 1.0', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 1.5 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations[0]!.confidence).toBe(1.0)
    })

    it('clamps negative confidence up to 0.0', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: -0.2 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations[0]!.confidence).toBe(0)
    })

    it('clamps very large confidence down to 1.0', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 99 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations[0]!.confidence).toBe(1.0)
    })

    it('defaults confidence to 0.5 when undefined', async () => {
      const { model } = createMockModel(JSON.stringify([{ text: 'X', category: 'fact' }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations[0]!.confidence).toBe(0.5)
    })

    it('preserves valid in-range confidence values', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0 },
          { text: 'B', category: 'fact', confidence: 0.42 },
          { text: 'C', category: 'fact', confidence: 1 },
        ]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations[0]!.confidence).toBe(0)
      expect(observations[1]!.confidence).toBe(0.42)
      expect(observations[2]!.confidence).toBe(1)
    })
  })

  describe('extract — metadata fields', () => {
    it('sets source to "extracted" on all observations', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'preference', confidence: 0.8 },
        ]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      for (const obs of observations) {
        expect(obs.source).toBe('extracted')
      }
    })

    it('sets createdAt to approximately Date.now()', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const before = Date.now()
      const observations = await extractor.extract(sampleMessages())
      const after = Date.now()
      expect(observations[0]!.createdAt).toBeGreaterThanOrEqual(before)
      expect(observations[0]!.createdAt).toBeLessThanOrEqual(after)
    })

    it('all observations in one batch share the same createdAt timestamp', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'fact', confidence: 0.9 },
          { text: 'C', category: 'fact', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const observations = await extractor.extract(sampleMessages())
      expect(observations[0]!.createdAt).toBe(observations[1]!.createdAt)
      expect(observations[1]!.createdAt).toBe(observations[2]!.createdAt)
    })
  })

  describe('extract — debounce side-effects', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('updates lastExtractedAt after extraction', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 5000 })

      expect(extractor.shouldExtract(10)).toBe(true)
      await extractor.extract(sampleMessages())
      expect(extractor.shouldExtract(10)).toBe(false)
    })

    it('updates lastExtractedAt even when extraction returns []', async () => {
      const { model } = createMockModel('not a json array')
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 5000 })
      await extractor.extract(sampleMessages())
      expect(extractor.shouldExtract(10)).toBe(false)
    })

    it('updates lastExtractedAt even when model throws', async () => {
      const { model } = createThrowingModel(new Error('boom'))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 5000 })
      await extractor.extract(sampleMessages())
      // lastExtractedAt is set before model invocation, so debounce still kicks in
      expect(extractor.shouldExtract(10)).toBe(false)
    })
  })

  describe('extract — count management', () => {
    it('increments extractionCount by number of valid observations', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'fact', confidence: 0.9 },
          { text: 'C', category: 'fact', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      expect(extractor.count).toBe(0)
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(3)
    })

    it('increments by valid count only (ignores filtered items)', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'invalid_cat', confidence: 0.9 },
          { text: 'C', category: 'preference', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(2)
    })

    it('does not increment count when extract() returns [] from no JSON', async () => {
      const { model } = createMockModel('plain text reply')
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(0)
    })

    it('does not increment count when model throws', async () => {
      const { model } = createThrowingModel(new Error('rate limit'))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(0)
    })

    it('accumulates count across multiple extractions', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'fact', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(2)
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(4)
    })
  })

  describe('count getter', () => {
    it('returns 0 initially', () => {
      const { model } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model })
      expect(extractor.count).toBe(0)
    })

    it('reflects total after extraction', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'preference', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(2)
    })

    it('does not increment when extract returns []', async () => {
      const { model } = createMockModel('[]')
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(0)
    })
  })

  describe('reset', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('resets extractionCount to 0', async () => {
      const { model } = createMockModel(
        jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(1)
      extractor.reset()
      expect(extractor.count).toBe(0)
    })

    it('resets debounce so shouldExtract can fire again', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 60_000 })
      await extractor.extract(sampleMessages())
      expect(extractor.shouldExtract(10)).toBe(false)
      extractor.reset()
      expect(extractor.shouldExtract(10)).toBe(true)
    })

    it('reset allows extraction to resume after maxObservations cap', async () => {
      const { model } = createMockModel(
        jsonResponse([
          { text: 'A', category: 'fact', confidence: 0.9 },
          { text: 'B', category: 'fact', confidence: 0.9 },
        ]),
      )
      const extractor = new ObservationExtractor({
        model,
        minMessages: 1,
        debounceMs: 0,
        maxObservations: 2,
      })
      await extractor.extract(sampleMessages())
      expect(extractor.shouldExtract(10)).toBe(false)
      extractor.reset()
      expect(extractor.shouldExtract(10)).toBe(true)
    })
  })

  describe('multi-call debounce sequence', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('first extract → updates lastExtractedAt; second shouldExtract immediately → false', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 10_000 })
      await extractor.extract(sampleMessages())
      expect(extractor.shouldExtract(10)).toBe(false)
    })

    it('after debounceMs elapsed → shouldExtract true again', async () => {
      const { model } = createMockModel(jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 10_000 })
      await extractor.extract(sampleMessages())
      vi.advanceTimersByTime(10_001)
      expect(extractor.shouldExtract(10)).toBe(true)
    })

    it('multi-cycle: extract → wait → extract → wait → extract', async () => {
      const { model, invokeMock } = createMockModel(
        jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]),
      )
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 1000 })

      await extractor.extract(sampleMessages())
      vi.advanceTimersByTime(1001)
      await extractor.extract(sampleMessages())
      vi.advanceTimersByTime(1001)
      await extractor.extract(sampleMessages())

      expect(invokeMock).toHaveBeenCalledTimes(3)
      expect(extractor.count).toBe(3)
    })
  })

  describe('prompt construction', () => {
    it('formats messages as "role: content" joined by double newline', async () => {
      const { model, invocations } = createMockModel(jsonResponse([]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const messages: BaseMessage[] = [
        new HumanMessage('Hello there'),
        new AIMessage('Hi! How can I help?'),
        new HumanMessage('Tell me about TypeScript'),
      ]
      await extractor.extract(messages)

      expect(invocations).toHaveLength(1)
      const sentMessages = invocations[0]!.messages
      expect(sentMessages).toHaveLength(2)
      expect(sentMessages[0]).toBeInstanceOf(SystemMessage)
      expect(sentMessages[1]).toBeInstanceOf(HumanMessage)

      const humanContent = String(sentMessages[1]!.content)
      expect(humanContent).toContain('human: Hello there')
      expect(humanContent).toContain('ai: Hi! How can I help?')
      expect(humanContent).toContain('human: Tell me about TypeScript')
      expect(humanContent).toContain('\n\n')
    })

    it('SystemMessage contains extraction instructions', async () => {
      const { model, invocations } = createMockModel(jsonResponse([]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      const sysContent = String(invocations[0]!.messages[0]!.content)
      expect(sysContent).toContain('Extract key observations')
      expect(sysContent).toContain('text')
      expect(sysContent).toContain('category')
      expect(sysContent).toContain('confidence')
      expect(sysContent).toContain('JSON array')
    })

    it('HumanMessage starts with "Recent conversation:"', async () => {
      const { model, invocations } = createMockModel(jsonResponse([]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract(sampleMessages())
      const humanContent = String(invocations[0]!.messages[1]!.content)
      expect(humanContent.startsWith('Recent conversation:')).toBe(true)
    })

    it('handles non-string message content (array form) by JSON-stringifying', async () => {
      const { model, invocations } = createMockModel(jsonResponse([]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      const msg = new AIMessage({ content: [{ type: 'text', text: 'complex' }] })
      await extractor.extract([msg])
      const humanContent = String(invocations[0]!.messages[1]!.content)
      expect(humanContent).toContain('ai:')
      // The serialized array should appear somewhere
      expect(humanContent).toContain('complex')
    })

    it('formats single message correctly', async () => {
      const { model, invocations } = createMockModel(jsonResponse([]))
      const extractor = new ObservationExtractor({ model, minMessages: 1, debounceMs: 0 })
      await extractor.extract([new HumanMessage('only one')])
      const humanContent = String(invocations[0]!.messages[1]!.content)
      expect(humanContent).toContain('human: only one')
    })
  })

  describe('integration — full lifecycle', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('full session: should → extract → debounce → reset → should → extract', async () => {
      const { model, invokeMock } = createMockModel(
        jsonResponse([{ text: 'X', category: 'fact', confidence: 0.9 }]),
      )
      const extractor = new ObservationExtractor({
        model,
        minMessages: 5,
        debounceMs: 5000,
        maxObservations: 10,
      })

      // Below min messages
      expect(extractor.shouldExtract(3)).toBe(false)

      // Now ready
      expect(extractor.shouldExtract(5)).toBe(true)
      const obs1 = await extractor.extract(sampleMessages())
      expect(obs1).toHaveLength(1)
      expect(extractor.count).toBe(1)
      expect(invokeMock).toHaveBeenCalledTimes(1)

      // Debounced
      expect(extractor.shouldExtract(10)).toBe(false)

      // After debounce
      vi.advanceTimersByTime(5001)
      expect(extractor.shouldExtract(10)).toBe(true)
      await extractor.extract(sampleMessages())
      expect(extractor.count).toBe(2)
      expect(invokeMock).toHaveBeenCalledTimes(2)

      // Reset
      extractor.reset()
      expect(extractor.count).toBe(0)
      expect(extractor.shouldExtract(10)).toBe(true)
    })
  })
})
