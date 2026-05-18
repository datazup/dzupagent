/**
 * Tests for `InMemoryMemoryClient` (ADR-0005).
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { InMemoryMemoryClient } from '../in-memory-client.js'
import {
  HttpMemoryClient,
  HttpMemoryResponseError,
  HttpMemoryTimeoutError,
  HttpMemoryAbortError,
} from '../http-client.js'
import type {
  MemoryRecord,
  MemoryScope,
  MemoryChangeEvent,
} from '@dzupagent/agent-types'

const TENANT: MemoryScope = { tenantId: 'tenant-a' }
const TENANT_PROJECT: MemoryScope = { tenantId: 'tenant-a', projectId: 'proj-1' }

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now()
  return {
    id: 'rec-1',
    namespace: 'facts',
    scope: TENANT,
    content: 'water boils at 100C',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('InMemoryMemoryClient', () => {
  let client: InMemoryMemoryClient

  beforeEach(() => {
    client = new InMemoryMemoryClient()
  })

  it('round-trips a record through put + get', async () => {
    const record = makeRecord()
    await client.put('facts', TENANT, record)
    const result = await client.get('facts', TENANT)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('rec-1')
    expect(result[0]?.content).toBe('water boils at 100C')
  })

  it('isolates records by namespace', async () => {
    await client.put('facts', TENANT, makeRecord({ id: 'a', content: 'fact a' }))
    await client.put(
      'episodic',
      TENANT,
      makeRecord({ id: 'b', content: 'event b', namespace: 'episodic' }),
    )
    const facts = await client.get('facts', TENANT)
    const episodic = await client.get('episodic', TENANT)
    expect(facts.map(r => r.id)).toEqual(['a'])
    expect(episodic.map(r => r.id)).toEqual(['b'])
  })

  it('filters by scope fields when present', async () => {
    await client.put('facts', TENANT, makeRecord({ id: 'global', content: 'tenant-only' }))
    await client.put(
      'facts',
      TENANT_PROJECT,
      makeRecord({
        id: 'scoped',
        content: 'project-scoped',
        scope: TENANT_PROJECT,
      }),
    )

    // Tenant-only query matches every record under that tenant, regardless
    // of finer-grained scope fields. Order is by `updatedAt` desc.
    const tenantQuery = await client.get('facts', TENANT)
    expect(tenantQuery.map(r => r.id).sort()).toEqual(['global', 'scoped'])

    // Adding `projectId` narrows the result to the project-scoped record only.
    const projectOnly = await client.get('facts', TENANT_PROJECT)
    expect(projectOnly.map(r => r.id)).toEqual(['scoped'])
  })

  it('honours search filter on content', async () => {
    await client.put('facts', TENANT, makeRecord({ id: 'a', content: 'apple pie' }))
    await client.put('facts', TENANT, makeRecord({ id: 'b', content: 'banana bread' }))

    const result = await client.get('facts', TENANT, { search: 'banana' })
    expect(result.map(r => r.id)).toEqual(['b'])
  })

  it('honours limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await client.put(
        'facts',
        TENANT,
        makeRecord({ id: `r${i}`, content: `c${i}`, updatedAt: Date.now() + i }),
      )
    }
    const page = await client.get('facts', TENANT, { limit: 2, offset: 1 })
    expect(page).toHaveLength(2)
  })

  it('delete removes a record and returns true; missing returns false', async () => {
    await client.put('facts', TENANT, makeRecord({ id: 'a' }))
    const ok = await client.delete('facts', TENANT, 'a')
    expect(ok).toBe(true)
    expect(await client.get('facts', TENANT)).toHaveLength(0)

    const miss = await client.delete('facts', TENANT, 'never-existed')
    expect(miss).toBe(false)
  })

  it('subscribers receive created / updated / deleted events for matching scope', async () => {
    const events: MemoryChangeEvent[] = []
    const unsubscribe = client.subscribe('facts', TENANT, e => events.push(e))

    await client.put('facts', TENANT, makeRecord({ id: 'a', content: 'first' }))
    await client.put('facts', TENANT, makeRecord({ id: 'a', content: 'second' }))
    await client.delete('facts', TENANT, 'a')

    unsubscribe()
    await client.put('facts', TENANT, makeRecord({ id: 'b', content: 'after unsub' }))

    expect(events.map(e => e.type)).toEqual(['created', 'updated', 'deleted'])
  })

  it('subscribers do not receive events on a different namespace', async () => {
    const events: MemoryChangeEvent[] = []
    client.subscribe('facts', TENANT, e => events.push(e))
    await client.put(
      'episodic',
      TENANT,
      makeRecord({ id: 'b', namespace: 'episodic' }),
    )
    expect(events).toHaveLength(0)
  })

  it('stats reports record count and unique namespaces', async () => {
    await client.put('facts', TENANT, makeRecord({ id: 'a' }))
    await client.put(
      'episodic',
      TENANT,
      makeRecord({ id: 'b', namespace: 'episodic' }),
    )
    const stats = await client.stats()
    expect(stats.totalRecords).toBe(2)
    expect(stats.namespaces.sort()).toEqual(['episodic', 'facts'])
  })

  it('listener errors do not break subsequent puts', async () => {
    client.subscribe('facts', TENANT, () => {
      throw new Error('listener boom')
    })
    await expect(
      client.put('facts', TENANT, makeRecord({ id: 'safe' })),
    ).resolves.toBeUndefined()
    expect((await client.get('facts', TENANT))[0]?.id).toBe('safe')
  })
})

describe('HttpMemoryClient', () => {
  function makeHttpResponse(payload: unknown, init?: { status?: number; statusText?: string; headers?: Record<string, string> }): Response {
    return {
      ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
      status: init?.status ?? 200,
      statusText: init?.statusText ?? 'OK',
      headers: new Headers(init?.headers ?? { 'content-type': 'application/json; charset=utf-8' }),
      text: async () => payload === undefined ? '' : JSON.stringify(payload),
      json: async () => payload,
    } as unknown as Response
  }

  it('GET sends auth header and serialized scope/query and returns records', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.internal',
      apiKey: 'token-123',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return makeHttpResponse([
          makeRecord({ id: 'http-1', namespace: 'facts', scope: TENANT }),
        ])
      },
    })

    const result = await client.get('facts', TENANT, { limit: 5, search: 'boils' })

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('http-1')
    expect(calls).toHaveLength(1)
    const request = calls[0]
    expect(request).toBeDefined()
    expect(request?.url).toContain('/memory/facts?')
    const parsed = new URL(request!.url)
    expect(parsed.searchParams.get('scope')).toBe(JSON.stringify(TENANT))
    expect(parsed.searchParams.get('query')).toBe(JSON.stringify({ limit: 5, search: 'boils' }))

    const headers = new Headers(request?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer token-123')
    expect(headers.get('accept')).toContain('application/json')
  })

  it('PUT and DELETE run CRUD over HTTP and do not throw NotImplementedError', async () => {
    const methods: string[] = []
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.internal',
      fetch: async (_url, init) => {
        methods.push(String(init?.method))
        if (init?.method === 'DELETE') {
          return makeHttpResponse({ deleted: true })
        }
        return makeHttpResponse({ ok: true })
      },
    })

    await expect(client.put('facts', TENANT, makeRecord({ id: 'rec-put' }))).resolves.toBeUndefined()
    await expect(client.delete('facts', TENANT, 'rec-put')).resolves.toBe(true)
    expect(methods).toEqual(['PUT', 'DELETE'])
  })

  it('maps 5xx JSON errors to typed HttpMemoryResponseError', async () => {
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.internal',
      fetch: async () => makeHttpResponse(
        { message: 'backend exploded', code: 'MEMORY_BACKEND_DOWN', details: { retryable: false } },
        { status: 500, statusText: 'Internal Server Error' },
      ),
    })

    await expect(client.get('facts', TENANT)).rejects.toMatchObject({
      name: 'HttpMemoryResponseError',
      operation: 'get',
      status: 500,
      errorCode: 'MEMORY_BACKEND_DOWN',
    })

    await client.get('facts', TENANT).catch((err: unknown) => {
      expect(err).toBeInstanceOf(HttpMemoryResponseError)
      const typed = err as HttpMemoryResponseError
      expect(typed.details).toEqual({ retryable: false })
      expect(typed.message).toContain('backend exploded')
    })
  })

  it('maps timeout aborts to HttpMemoryTimeoutError', async () => {
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.internal',
      timeoutMs: 5,
      fetch: async (_url, init) => {
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => reject(new DOMException('Timed out', 'AbortError'))
          init?.signal?.addEventListener('abort', onAbort)
        })
      },
    })

    await expect(client.get('facts', TENANT)).rejects.toBeInstanceOf(HttpMemoryTimeoutError)
  })

  it('maps caller cancellation to HttpMemoryAbortError', async () => {
    const controller = new AbortController()
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.internal',
      timeoutMs: 1000,
      fetch: async (_url, init) => {
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'))
          init?.signal?.addEventListener('abort', onAbort)
          controller.abort()
        })
      },
    })

    await expect(client.get('facts', TENANT, undefined, { signal: controller.signal })).rejects.toBeInstanceOf(HttpMemoryAbortError)
  })

  it('recovers with success after a prior HTTP failure', async () => {
    let attempts = 0
    const client = new HttpMemoryClient({
      baseUrl: 'https://memory.internal',
      fetch: async () => {
        attempts++
        if (attempts === 1) {
          return makeHttpResponse({ message: 'temporary failure', code: 'TEMP_FAIL' }, { status: 503, statusText: 'Service Unavailable' })
        }
        return makeHttpResponse([{ ...makeRecord({ id: 'after-failure' }) }])
      },
    })

    await expect(client.get('facts', TENANT)).rejects.toBeInstanceOf(HttpMemoryResponseError)
    await expect(client.get('facts', TENANT)).resolves.toEqual([
      makeRecord({ id: 'after-failure' }),
    ])
  })
})
