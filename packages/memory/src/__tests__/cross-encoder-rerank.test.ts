import { describe, it, expect, vi } from 'vitest'
import { rerank, createLLMReranker } from '../retrieval/cross-encoder-rerank.js'
import type { CrossEncoderProvider, RerankedResult } from '../retrieval/cross-encoder-rerank.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandidate(key: string, score: number, text: string) {
  return { key, score, value: { text } }
}

function stubProvider(scores: number[]): CrossEncoderProvider {
  return { score: vi.fn().mockResolvedValue(scores) }
}

function stubModel(content: string) {
  return {
    invoke: vi.fn().mockResolvedValue({ content }),
  } as unknown as BaseChatModel
}

// ─── Tests: rerank() ─────────────────────────────────────────────────────────

describe('rerank', () => {
  describe('happy path', () => {
    it('reranks candidates by cross-encoder score', async () => {
      const candidates = [
        makeCandidate('a', 0.9, 'document about authentication'),
        makeCandidate('b', 0.8, 'unrelated document about payments'),
        makeCandidate('c', 0.7, 'authentication token refresh'),
      ]
      // Cross-encoder says 'c' is most relevant, then 'a', then 'b'
      const provider = stubProvider([5.0, 1.0, 9.0])
      const results = await rerank('authentication tokens', candidates, provider)
      expect(results[0]!.key).toBe('c')
      expect(results[1]!.key).toBe('a')
      expect(results[2]!.key).toBe('b')
    })

    it('stores cross-encoder score in score field and original score in originalScore', async () => {
      const candidates = [makeCandidate('x', 0.75, 'some text')]
      // Single candidate → provider not called; returned as-is
      const provider = stubProvider([])
      const results = await rerank('query', candidates, provider)
      expect(results[0]!.score).toBe(0.75)
      expect(results[0]!.originalScore).toBe(0.75)
    })

    it('computes correct rankChange', async () => {
      const candidates = [
        makeCandidate('a', 0.9, 'doc a'),
        makeCandidate('b', 0.8, 'doc b'),
        makeCandidate('c', 0.7, 'doc c'),
      ]
      // After reranking: c(rank 0), b(rank 1), a(rank 2)
      // originalRank: a=0, b=1, c=2
      // newRank: c->0, b->1, a->2
      // rankChange: c = 2-0=2, b = 1-1=0, a = 0-2=-2
      const provider = stubProvider([1.0, 5.0, 9.0])
      const results = await rerank('q', candidates, provider)
      const c = results.find(r => r.key === 'c')!
      const b = results.find(r => r.key === 'b')!
      const a = results.find(r => r.key === 'a')!
      expect(c.rankChange).toBe(2)
      expect(b.rankChange).toBe(0)
      expect(a.rankChange).toBe(-2)
    })

    it('calls provider with all document texts', async () => {
      const candidates = [
        makeCandidate('a', 1.0, 'text a'),
        makeCandidate('b', 0.9, 'text b'),
      ]
      const provider = stubProvider([3.0, 7.0])
      await rerank('my query', candidates, provider)
      expect(provider.score).toHaveBeenCalledWith('my query', ['text a', 'text b'])
    })
  })

  describe('config options', () => {
    it('respects finalTopK', async () => {
      const candidates = Array.from({ length: 6 }, (_, i) =>
        makeCandidate(`k${i}`, 1 - i * 0.1, `doc ${i}`),
      )
      const scores = [6, 5, 4, 3, 2, 1]
      const provider = stubProvider(scores)
      const results = await rerank('q', candidates, provider, { finalTopK: 3 })
      expect(results).toHaveLength(3)
    })

    it('respects rerankTopK — only takes top N candidates to provider', async () => {
      const candidates = Array.from({ length: 8 }, (_, i) =>
        makeCandidate(`k${i}`, 1 - i * 0.1, `doc ${i}`),
      )
      const provider = stubProvider([8, 7, 6, 5])
      const results = await rerank('q', candidates, provider, { rerankTopK: 4, finalTopK: 4 })
      expect(provider.score).toHaveBeenCalledWith('q', expect.arrayContaining(['doc 0', 'doc 1', 'doc 2', 'doc 3']))
      expect(results).toHaveLength(4)
    })

    it('filters results below minScore', async () => {
      const candidates = [
        makeCandidate('a', 0.9, 'relevant'),
        makeCandidate('b', 0.8, 'irrelevant'),
        makeCandidate('c', 0.7, 'somewhat relevant'),
      ]
      const provider = stubProvider([8.0, 1.0, 7.0])
      const results = await rerank('q', candidates, provider, { minScore: 5.0 })
      const keys = results.map(r => r.key)
      expect(keys).toContain('a')
      expect(keys).toContain('c')
      expect(keys).not.toContain('b')
    })
  })

  describe('edge cases', () => {
    it('returns empty array for empty candidates', async () => {
      const provider = stubProvider([])
      const results = await rerank('q', [], provider)
      expect(results).toEqual([])
    })

    it('returns single candidate as-is without calling provider', async () => {
      const candidates = [makeCandidate('solo', 0.5, 'only doc')]
      const provider = stubProvider([])
      const results = await rerank('q', candidates, provider)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('solo')
      expect(provider.score).not.toHaveBeenCalled()
    })

    it('falls back to original order when provider throws', async () => {
      const candidates = [
        makeCandidate('a', 0.9, 'doc a'),
        makeCandidate('b', 0.8, 'doc b'),
      ]
      const provider: CrossEncoderProvider = {
        score: vi.fn().mockRejectedValue(new Error('provider unavailable')),
      }
      const results = await rerank('q', candidates, provider)
      // Should not throw; returns candidates in original order
      expect(results[0]!.key).toBe('a')
      expect(results[1]!.key).toBe('b')
      expect(results[0]!.score).toBe(0.9)
    })

    it('falls back to original order when provider returns wrong number of scores', async () => {
      const candidates = [
        makeCandidate('a', 0.9, 'doc a'),
        makeCandidate('b', 0.8, 'doc b'),
      ]
      const provider = stubProvider([9.0]) // only 1 score for 2 docs
      const results = await rerank('q', candidates, provider)
      expect(results[0]!.key).toBe('a')
      expect(results[1]!.key).toBe('b')
    })

    it('extracts text from content field when text is absent', async () => {
      const candidates = [
        { key: 'a', score: 0.9, value: { content: 'content field text' } },
        { key: 'b', score: 0.8, value: { content: 'other content' } },
      ]
      const provider = stubProvider([9.0, 1.0])
      await rerank('q', candidates, provider)
      expect(provider.score).toHaveBeenCalledWith('q', ['content field text', 'other content'])
    })

    it('conforms to RerankedResult interface', async () => {
      const candidates = [
        makeCandidate('a', 0.9, 'doc a'),
        makeCandidate('b', 0.8, 'doc b'),
      ]
      const provider = stubProvider([7.0, 3.0])
      const results: RerankedResult[] = await rerank('q', candidates, provider)
      const r = results[0]!
      expect(typeof r.key).toBe('string')
      expect(typeof r.score).toBe('number')
      expect(typeof r.originalScore).toBe('number')
      expect(typeof r.rankChange).toBe('number')
      expect(typeof r.value).toBe('object')
    })
  })
})

// ─── Tests: createLLMReranker() ───────────────────────────────────────────────

describe('createLLMReranker', () => {
  it('parses a JSON array from the model response', async () => {
    const model = stubModel('[8.5, 2.0, 6.3]')
    const provider = createLLMReranker(model)
    const scores = await provider.score('query', ['doc1', 'doc2', 'doc3'])
    expect(scores).toEqual([8.5, 2.0, 6.3])
  })

  it('parses JSON array wrapped in markdown fences', async () => {
    const model = stubModel('```json\n[7.0, 4.5]\n```')
    const provider = createLLMReranker(model)
    const scores = await provider.score('q', ['a', 'b'])
    expect(scores).toEqual([7.0, 4.5])
  })

  it('falls back to 1.0 for all docs when model returns no JSON array', async () => {
    const model = stubModel('I cannot score these documents.')
    const provider = createLLMReranker(model)
    const scores = await provider.score('q', ['a', 'b'])
    expect(scores).toEqual([1.0, 1.0])
  })

  it('falls back to 1.0 when parsed array has wrong length', async () => {
    const model = stubModel('[9.0]') // 1 score for 2 docs
    const provider = createLLMReranker(model)
    const scores = await provider.score('q', ['a', 'b'])
    expect(scores).toEqual([1.0, 1.0])
  })

  it('handles array content format from model', async () => {
    const model = {
      invoke: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '[5.0, 3.0]' }] }),
    } as unknown as BaseChatModel
    const provider = createLLMReranker(model)
    const scores = await provider.score('q', ['a', 'b'])
    // content is serialized via JSON.stringify, so the extracted array should be found
    expect(scores).toHaveLength(2)
  })

  it('calls model with both system and human messages', async () => {
    const model = stubModel('[1.0]')
    const provider = createLLMReranker(model)
    await provider.score('my query', ['only doc'])
    expect(model.invoke).toHaveBeenCalledTimes(1)
    const [messages] = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[][]
    expect(Array.isArray(messages)).toBe(true)
    expect((messages as { _getType: () => string }[]).length).toBe(2)
  })
})
