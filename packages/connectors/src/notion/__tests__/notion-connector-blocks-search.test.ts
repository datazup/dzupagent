import { describe, expect, it, vi } from 'vitest'
import { NotionApiError, NotionConnector } from '../notion-connector.js'

// Obvious placeholder; never a real credential. All requests go to an injected fake fetch.
const TEST_TOKEN = 'test-notion-token-placeholder'
const BLOCK_ID = '0123456789abcdef0123456789abcdef'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fakeFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>()
  for (const response of responses) fn.mockResolvedValueOnce(response)
  return fn
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries())
}

function connectorWith(fetchImpl: typeof fetch) {
  return new NotionConnector({ token: TEST_TOKEN, fetch: fetchImpl })
}

const emptyList = { object: 'list', results: [], next_cursor: null, has_more: false }

describe('NotionConnector.listBlockChildren', () => {
  it('GETs /v1/blocks/{id}/children with bearer token and no query string by default', async () => {
    const body = { object: 'list', results: [{ object: 'block', id: 'b1' }], next_cursor: null, has_more: false }
    const fetchImpl = fakeFetch(jsonResponse(body))

    const result = await connectorWith(fetchImpl).listBlockChildren(BLOCK_ID)

    expect(result).toEqual(body)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://api.notion.com/v1/blocks/${BLOCK_ID}/children`)
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    const headers = headersOf(init)
    expect(headers['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers['notion-version']).toBe('2022-06-28')
  })

  it('round-trips the cursor through start_cursor/page_size query params', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse({ object: 'list', results: [{ id: 'a' }], next_cursor: 'cur/2+x', has_more: true }),
      jsonResponse({ object: 'list', results: [{ id: 'b' }], next_cursor: null, has_more: false }),
    )
    const connector = connectorWith(fetchImpl)

    const first = await connector.listBlockChildren(BLOCK_ID, { page_size: 1 })
    expect(first.has_more).toBe(true)
    const second = await connector.listBlockChildren(BLOCK_ID, {
      page_size: 1,
      start_cursor: first.next_cursor ?? undefined,
    })
    expect(second.results).toEqual([{ id: 'b' }])
    expect(second.has_more).toBe(false)

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `https://api.notion.com/v1/blocks/${BLOCK_ID}/children?page_size=1`,
    )
    const secondUrl = new URL(String(fetchImpl.mock.calls[1]![0]))
    expect(secondUrl.pathname).toBe(`/v1/blocks/${BLOCK_ID}/children`)
    expect(secondUrl.searchParams.get('start_cursor')).toBe('cur/2+x')
    expect(secondUrl.searchParams.get('page_size')).toBe('1')
  })

  it('maps API errors to NotionApiError', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse({ object: 'error', status: 404, code: 'object_not_found', message: 'No block.' }, 404),
    )

    const error = await connectorWith(fetchImpl).listBlockChildren(BLOCK_ID).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotionApiError)
    expect(error).toMatchObject({ status: 404, code: 'object_not_found' })
  })

  it.each(['', '../pages', `${BLOCK_ID}/children`, `${BLOCK_ID}?page_size=1`])(
    'rejects invalid block id %j without fetching',
    async (badId) => {
      const fetchImpl = fakeFetch()

      await expect(connectorWith(fetchImpl).listBlockChildren(badId)).rejects.toThrow(/id/i)
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each([0, 101, 2.5])('rejects page_size %s without fetching', async (pageSize) => {
    const fetchImpl = fakeFetch()

    await expect(
      connectorWith(fetchImpl).listBlockChildren(BLOCK_ID, { page_size: pageSize }),
    ).rejects.toThrow(/page_size/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws before fetching when no token is configured', async () => {
    const fetchImpl = fakeFetch()

    await expect(new NotionConnector({ fetch: fetchImpl }).listBlockChildren(BLOCK_ID)).rejects.toThrow(/token/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('NotionConnector.search', () => {
  it('POSTs /v1/search with the JSON body and returns the result page', async () => {
    const body = { object: 'list', results: [{ object: 'page', id: 'p1' }], next_cursor: 'c2', has_more: true }
    const fetchImpl = fakeFetch(jsonResponse(body))
    const payload = {
      query: 'roadmap',
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 10,
    }

    const result = await connectorWith(fetchImpl).search(payload)

    expect(result).toEqual(body)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.notion.com/v1/search')
    expect(init?.method).toBe('POST')
    const headers = headersOf(init)
    expect(headers['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers['notion-version']).toBe('2022-06-28')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual(payload)
  })

  it('sends an empty JSON object when no payload is given', async () => {
    const fetchImpl = fakeFetch(jsonResponse(emptyList))

    await connectorWith(fetchImpl).search()

    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({})
  })

  it('forwards start_cursor for the next page', async () => {
    const fetchImpl = fakeFetch(jsonResponse(emptyList))

    await connectorWith(fetchImpl).search({ start_cursor: 'c2', page_size: 5 })

    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({ start_cursor: 'c2', page_size: 5 })
  })

  it('maps 429 to NotionApiError without retrying', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse({ object: 'error', status: 429, code: 'rate_limited', message: 'Slow down.' }, 429),
    )

    await expect(connectorWith(fetchImpl).search({ query: 'x' })).rejects.toMatchObject({
      name: 'NotionApiError',
      status: 429,
      code: 'rate_limited',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([0, 101])('rejects page_size %s without fetching', async (pageSize) => {
    const fetchImpl = fakeFetch()

    await expect(connectorWith(fetchImpl).search({ page_size: pageSize })).rejects.toThrow(/page_size/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
