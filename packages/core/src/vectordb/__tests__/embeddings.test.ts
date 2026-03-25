import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOpenAIEmbedding } from '../embeddings/openai-embedding.js'
import { createVoyageEmbedding } from '../embeddings/voyage-embedding.js'
import { createCohereEmbedding } from '../embeddings/cohere-embedding.js'
import { createOllamaEmbedding } from '../embeddings/ollama-embedding.js'
import { createCustomEmbedding } from '../embeddings/custom-embedding.js'
import { createAutoEmbeddingProvider, detectVectorProvider } from '../auto-detect.js'

/** Helper to create a mock fetch that returns embedding data */
function mockFetch(responseBody: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
  }))
}

function makeMockEmbeddings(count: number, dims: number): number[][] {
  return Array.from({ length: count }, (_, i) =>
    Array.from({ length: dims }, (__, j) => (i + 1) * 0.01 + j * 0.001),
  )
}

describe('Embedding Providers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('createOpenAIEmbedding', () => {
    it('embeds via correct API format', async () => {
      const embeddings = makeMockEmbeddings(2, 1536)
      mockFetch({
        data: embeddings.map((embedding, index) => ({ embedding, index })),
      })

      const provider = createOpenAIEmbedding({ apiKey: 'sk-test' })
      const result = await provider.embed(['hello', 'world'])

      expect(result).toHaveLength(2)
      expect(result[0]).toHaveLength(1536)

      const fetchMock = vi.mocked(fetch)
      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, options] = fetchMock.mock.calls[0]!
      expect(url).toBe('https://api.openai.com/v1/embeddings')
      expect(options?.method).toBe('POST')

      const body = JSON.parse(options?.body as string) as Record<string, unknown>
      expect(body['model']).toBe('text-embedding-3-small')
      expect(body['input']).toEqual(['hello', 'world'])
      expect(body['dimensions']).toBe(1536)

      const headers = options?.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer sk-test')
    })

    it('embedQuery returns a single vector', async () => {
      const embeddings = makeMockEmbeddings(1, 1536)
      mockFetch({
        data: [{ embedding: embeddings[0], index: 0 }],
      })

      const provider = createOpenAIEmbedding({ apiKey: 'sk-test' })
      const result = await provider.embedQuery('test query')

      expect(result).toHaveLength(1536)
    })

    it('uses custom baseUrl', async () => {
      mockFetch({ data: [{ embedding: [0.1], index: 0 }] })

      const provider = createOpenAIEmbedding({
        apiKey: 'sk-test',
        baseUrl: 'https://custom.api.com/v1/',
      })
      await provider.embedQuery('test')

      const fetchMock = vi.mocked(fetch)
      const [url] = fetchMock.mock.calls[0]!
      expect(url).toBe('https://custom.api.com/v1/embeddings')
    })

    it('has correct modelId and dimensions', () => {
      const provider = createOpenAIEmbedding({ apiKey: 'sk-test' })
      expect(provider.modelId).toBe('text-embedding-3-small')
      expect(provider.dimensions).toBe(1536)
    })

    it('respects custom model and dimensions', () => {
      const provider = createOpenAIEmbedding({
        apiKey: 'sk-test',
        model: 'text-embedding-3-large',
        dimensions: 3072,
      })
      expect(provider.modelId).toBe('text-embedding-3-large')
      expect(provider.dimensions).toBe(3072)
    })

    it('throws on HTTP error', async () => {
      mockFetch({ error: 'rate limited' }, 429)

      const provider = createOpenAIEmbedding({ apiKey: 'sk-test' })
      await expect(provider.embed(['test'])).rejects.toThrow('OpenAI embedding request failed (429)')
    })

    it('returns empty array for empty input', async () => {
      const provider = createOpenAIEmbedding({ apiKey: 'sk-test' })
      const result = await provider.embed([])
      expect(result).toEqual([])
    })

    it('sorts results by index to match input order', async () => {
      // Return out-of-order results
      mockFetch({
        data: [
          { embedding: [0.2], index: 1 },
          { embedding: [0.1], index: 0 },
        ],
      })

      const provider = createOpenAIEmbedding({ apiKey: 'sk-test', dimensions: 1 })
      const result = await provider.embed(['first', 'second'])

      expect(result[0]).toEqual([0.1])
      expect(result[1]).toEqual([0.2])
    })
  })

  describe('createVoyageEmbedding', () => {
    it('calls correct API endpoint', async () => {
      const embeddings = makeMockEmbeddings(1, 1024)
      mockFetch({
        data: [{ embedding: embeddings[0], index: 0 }],
      })

      const provider = createVoyageEmbedding({ apiKey: 'voy-test' })
      await provider.embed(['hello'])

      const fetchMock = vi.mocked(fetch)
      const [url, options] = fetchMock.mock.calls[0]!
      expect(url).toBe('https://api.voyageai.com/v1/embeddings')

      const body = JSON.parse(options?.body as string) as Record<string, unknown>
      expect(body['model']).toBe('voyage-3')

      const headers = options?.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer voy-test')
    })

    it('has correct default dimensions for voyage-3', () => {
      const provider = createVoyageEmbedding({ apiKey: 'voy-test' })
      expect(provider.modelId).toBe('voyage-3')
      expect(provider.dimensions).toBe(1024)
    })

    it('throws on HTTP error', async () => {
      mockFetch({ error: 'unauthorized' }, 401)

      const provider = createVoyageEmbedding({ apiKey: 'bad-key' })
      await expect(provider.embed(['test'])).rejects.toThrow('Voyage embedding request failed (401)')
    })
  })

  describe('createCohereEmbedding', () => {
    it('calls correct API endpoint and format', async () => {
      const embeddings = makeMockEmbeddings(1, 1024)
      mockFetch({
        embeddings: { float: embeddings },
      })

      const provider = createCohereEmbedding({ apiKey: 'co-test' })
      await provider.embed(['hello'])

      const fetchMock = vi.mocked(fetch)
      const [url, options] = fetchMock.mock.calls[0]!
      expect(url).toBe('https://api.cohere.com/v2/embed')

      const body = JSON.parse(options?.body as string) as Record<string, unknown>
      expect(body['model']).toBe('embed-english-v3.0')
      expect(body['texts']).toEqual(['hello'])
      expect(body['input_type']).toBe('search_document')
      expect(body['embedding_types']).toEqual(['float'])
    })

    it('embedQuery uses search_query input_type', async () => {
      mockFetch({
        embeddings: { float: [[0.1, 0.2]] },
      })

      const provider = createCohereEmbedding({ apiKey: 'co-test' })
      await provider.embedQuery('my query')

      const fetchMock = vi.mocked(fetch)
      const [, options] = fetchMock.mock.calls[0]!
      const body = JSON.parse(options?.body as string) as Record<string, unknown>
      expect(body['input_type']).toBe('search_query')
    })

    it('has correct defaults', () => {
      const provider = createCohereEmbedding({ apiKey: 'co-test' })
      expect(provider.modelId).toBe('embed-english-v3.0')
      expect(provider.dimensions).toBe(1024)
    })
  })

  describe('createOllamaEmbedding', () => {
    it('calls local Ollama endpoint', async () => {
      mockFetch({
        embeddings: [[0.1, 0.2, 0.3]],
      })

      const provider = createOllamaEmbedding({ model: 'nomic-embed-text' })
      await provider.embed(['hello'])

      const fetchMock = vi.mocked(fetch)
      const [url, options] = fetchMock.mock.calls[0]!
      expect(url).toBe('http://localhost:11434/api/embed')

      const body = JSON.parse(options?.body as string) as Record<string, unknown>
      expect(body['model']).toBe('nomic-embed-text')
      expect(body['input']).toEqual(['hello'])

      // No auth header for local Ollama
      const headers = options?.headers as Record<string, string>
      expect(headers['Authorization']).toBeUndefined()
    })

    it('uses custom baseUrl', async () => {
      mockFetch({ embeddings: [[0.1]] })

      const provider = createOllamaEmbedding({
        model: 'mxbai-embed-large',
        baseUrl: 'http://gpu-server:11434',
      })
      await provider.embed(['test'])

      const fetchMock = vi.mocked(fetch)
      const [url] = fetchMock.mock.calls[0]!
      expect(url).toBe('http://gpu-server:11434/api/embed')
    })

    it('has correct modelId', () => {
      const provider = createOllamaEmbedding({ model: 'nomic-embed-text', dimensions: 768 })
      expect(provider.modelId).toBe('nomic-embed-text')
      expect(provider.dimensions).toBe(768)
    })
  })

  describe('createCustomEmbedding', () => {
    it('delegates to user-supplied function', async () => {
      const embedFn = vi.fn().mockResolvedValue([[0.1, 0.2], [0.3, 0.4]])

      const provider = createCustomEmbedding({
        embedFn,
        modelId: 'my-model',
        dimensions: 2,
      })

      const result = await provider.embed(['a', 'b'])

      expect(embedFn).toHaveBeenCalledWith(['a', 'b'])
      expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]])
    })

    it('embedQuery wraps single text', async () => {
      const embedFn = vi.fn().mockResolvedValue([[0.5, 0.6]])

      const provider = createCustomEmbedding({
        embedFn,
        modelId: 'custom',
        dimensions: 2,
      })

      const result = await provider.embedQuery('query')

      expect(embedFn).toHaveBeenCalledWith(['query'])
      expect(result).toEqual([0.5, 0.6])
    })

    it('has correct modelId and dimensions', () => {
      const provider = createCustomEmbedding({
        embedFn: async () => [],
        modelId: 'my-fine-tuned',
        dimensions: 512,
      })
      expect(provider.modelId).toBe('my-fine-tuned')
      expect(provider.dimensions).toBe(512)
    })

    it('returns empty array for empty input', async () => {
      const embedFn = vi.fn()
      const provider = createCustomEmbedding({
        embedFn,
        modelId: 'custom',
        dimensions: 2,
      })
      const result = await provider.embed([])
      expect(result).toEqual([])
      expect(embedFn).not.toHaveBeenCalled()
    })
  })

  describe('Batch embed returns correct number of vectors', () => {
    it('returns one vector per input text', async () => {
      const count = 5
      const dims = 128
      const embeddings = makeMockEmbeddings(count, dims)
      mockFetch({
        data: embeddings.map((embedding, index) => ({ embedding, index })),
      })

      const provider = createOpenAIEmbedding({ apiKey: 'sk-test', dimensions: dims })
      const result = await provider.embed(['a', 'b', 'c', 'd', 'e'])

      expect(result).toHaveLength(count)
      for (const vec of result) {
        expect(vec).toHaveLength(dims)
      }
    })
  })

  describe('Dimensions match config', () => {
    it('OpenAI custom dimensions', () => {
      const provider = createOpenAIEmbedding({ apiKey: 'k', dimensions: 256 })
      expect(provider.dimensions).toBe(256)
    })

    it('Voyage default dimensions', () => {
      const provider = createVoyageEmbedding({ apiKey: 'k', model: 'voyage-3-lite' })
      expect(provider.dimensions).toBe(512)
    })

    it('Cohere default dimensions', () => {
      const provider = createCohereEmbedding({ apiKey: 'k', model: 'embed-english-light-v3.0' })
      expect(provider.dimensions).toBe(384)
    })

    it('Ollama explicit dimensions', () => {
      const provider = createOllamaEmbedding({ model: 'test', dimensions: 1024 })
      expect(provider.dimensions).toBe(1024)
    })
  })
})

describe('Auto-detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('createAutoEmbeddingProvider', () => {
    it('detects from VOYAGE_API_KEY', () => {
      const provider = createAutoEmbeddingProvider({
        VOYAGE_API_KEY: 'voy-test-123',
      })
      expect(provider.modelId).toBe('voyage-3')
      expect(provider.dimensions).toBe(1024)
    })

    it('falls back to OPENAI_API_KEY', () => {
      const provider = createAutoEmbeddingProvider({
        OPENAI_API_KEY: 'sk-test-123',
      })
      expect(provider.modelId).toBe('text-embedding-3-small')
      expect(provider.dimensions).toBe(1536)
    })

    it('falls back to COHERE_API_KEY', () => {
      const provider = createAutoEmbeddingProvider({
        COHERE_API_KEY: 'co-test-123',
      })
      expect(provider.modelId).toBe('embed-english-v3.0')
      expect(provider.dimensions).toBe(1024)
    })

    it('prefers VOYAGE over OPENAI when both present', () => {
      const provider = createAutoEmbeddingProvider({
        VOYAGE_API_KEY: 'voy-test',
        OPENAI_API_KEY: 'sk-test',
      })
      expect(provider.modelId).toBe('voyage-3')
    })

    it('throws when no key found', () => {
      expect(() => createAutoEmbeddingProvider({})).toThrow(
        'No embedding provider detected',
      )
    })

    it('respects custom model env vars', () => {
      const provider = createAutoEmbeddingProvider({
        OPENAI_API_KEY: 'sk-test',
        OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
      })
      expect(provider.modelId).toBe('text-embedding-3-large')
    })
  })

  describe('detectVectorProvider', () => {
    it('returns explicit VECTOR_PROVIDER', () => {
      const result = detectVectorProvider({ VECTOR_PROVIDER: 'weaviate' })
      expect(result.provider).toBe('weaviate')
      expect(result.config).toEqual({ source: 'VECTOR_PROVIDER' })
    })

    it('detects qdrant from QDRANT_URL', () => {
      const result = detectVectorProvider({
        QDRANT_URL: 'http://localhost:6333',
        QDRANT_API_KEY: 'qdrant-key',
      })
      expect(result.provider).toBe('qdrant')
      expect(result.config).toEqual({
        url: 'http://localhost:6333',
        apiKey: 'qdrant-key',
      })
    })

    it('detects pinecone from PINECONE_API_KEY', () => {
      const result = detectVectorProvider({
        PINECONE_API_KEY: 'pc-key',
        PINECONE_ENVIRONMENT: 'us-east-1',
      })
      expect(result.provider).toBe('pinecone')
      expect(result.config).toEqual({
        apiKey: 'pc-key',
        environment: 'us-east-1',
      })
    })

    it('falls back to memory when no env vars', () => {
      const result = detectVectorProvider({})
      expect(result.provider).toBe('memory')
      expect(result.config).toEqual({})
    })

    it('prefers VECTOR_PROVIDER over auto-detection', () => {
      const result = detectVectorProvider({
        VECTOR_PROVIDER: 'chroma',
        QDRANT_URL: 'http://localhost:6333',
      })
      expect(result.provider).toBe('chroma')
    })
  })
})
