import { describe, it, expect, vi } from 'vitest'
import { PineconeAdapter } from '../adapters/pinecone-adapter.js'
import { QdrantAdapter } from '../adapters/qdrant-adapter.js'
import { ChromaDBAdapter } from '../adapters/chroma-adapter.js'
import { ForgeError } from '../../errors/forge-error.js'

function failingFetch(status: number, body: unknown): typeof globalThis.fetch {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  })
  return fn as unknown as typeof globalThis.fetch
}

describe('vector adapter HTTP error normalization', () => {
  it('Pinecone surfaces a recoverable ForgeError on 429', async () => {
    const adapter = new PineconeAdapter({
      apiKey: 'k',
      indexHost: 'https://host.pinecone.io',
      fetch: failingFetch(429, { message: 'rate limited' }),
    })
    await expect(adapter.count('c')).rejects.toMatchObject({
      code: 'VECTOR_STORE_RATE_LIMITED',
      recoverable: true,
    })
  })

  it('Pinecone surfaces a non-recoverable ForgeError on 401', async () => {
    const adapter = new PineconeAdapter({
      apiKey: 'k',
      fetch: failingFetch(401, { message: 'unauthorized' }),
    })
    const err = await adapter.listCollections().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ForgeError)
    expect((err as ForgeError).code).toBe('VECTOR_STORE_AUTH_FAILED')
    expect((err as ForgeError).recoverable).toBe(false)
  })

  it('Qdrant surfaces a recoverable ForgeError on 503', async () => {
    const adapter = new QdrantAdapter({
      url: 'http://localhost:6333',
      fetch: failingFetch(503, { status: 'unavailable' }),
    })
    await expect(adapter.listCollections()).rejects.toMatchObject({
      code: 'VECTOR_STORE_UNAVAILABLE',
      recoverable: true,
    })
  })

  it('Chroma error message does not leak the raw response body', async () => {
    const secret = 'SECRET-TOKEN-XYZ'
    const adapter = new ChromaDBAdapter({
      url: 'http://localhost:8000',
      fetch: failingFetch(400, secret),
    })
    const err = (await adapter.listCollections().catch((e: unknown) => e)) as ForgeError
    expect(err).toBeInstanceOf(ForgeError)
    expect(err.message).not.toContain(secret)
    expect(err.code).toBe('VECTOR_STORE_REJECTED_REQUEST')
  })
})
