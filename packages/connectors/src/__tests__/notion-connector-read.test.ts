import { describe, expect, it, vi } from 'vitest'
import { NotionApiError, NotionConnector } from '../notion/notion-connector.js'

// Obvious placeholder; never a real credential. All requests go to an injected fake fetch.
const TEST_TOKEN = 'test-notion-token-placeholder'
const PAGE_ID = '0123456789abcdef0123456789abcdef'
const DASHED_PAGE_ID = '01234567-89ab-cdef-0123-456789abcdef'
const DATABASE_ID = 'fedcba98765432100123456789abcdef'

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

function connectorWith(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new NotionConnector({ token: TEST_TOKEN, fetch: fetchImpl, ...extra })
}

describe('NotionConnector.readPage', () => {
  it('GETs /v1/pages/{id} with bearer token and Notion-Version and returns the page', async () => {
    const page = { object: 'page', id: PAGE_ID, properties: { title: { type: 'title' } } }
    const fetchImpl = fakeFetch(jsonResponse(page))

    const result = await connectorWith(fetchImpl).readPage(PAGE_ID)

    expect(result).toEqual(page)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://api.notion.com/v1/pages/${PAGE_ID}`)
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    const headers = headersOf(init)
    expect(headers['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers['notion-version']).toBe('2022-06-28')
  })

  it('accepts dashed UUID ids', async () => {
    const fetchImpl = fakeFetch(jsonResponse({ object: 'page', id: DASHED_PAGE_ID }))

    await connectorWith(fetchImpl).readPage(DASHED_PAGE_ID)

    expect(fetchImpl.mock.calls[0]![0]).toBe(`https://api.notion.com/v1/pages/${DASHED_PAGE_ID}`)
  })

  it('uses a configured Notion-Version header', async () => {
    const fetchImpl = fakeFetch(jsonResponse({ object: 'page', id: PAGE_ID }))

    await connectorWith(fetchImpl, { notionVersion: '2025-09-03' }).readPage(PAGE_ID)

    expect(headersOf(fetchImpl.mock.calls[0]![1])['notion-version']).toBe('2025-09-03')
  })

  it('maps 404 object_not_found to NotionApiError with status and code', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse(
        { object: 'error', status: 404, code: 'object_not_found', message: 'Could not find page.' },
        404,
      ),
    )

    const error = await connectorWith(fetchImpl).readPage(PAGE_ID).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotionApiError)
    expect(error).toMatchObject({ name: 'NotionApiError', status: 404, code: 'object_not_found' })
    expect((error as Error).message).toContain('Could not find page.')
  })

  it('maps 401 unauthorized and redacts the token from message and body', async () => {
    const leakedSecret = `secret_${'x'.repeat(30)}`
    const fetchImpl = fakeFetch(
      jsonResponse(
        {
          object: 'error',
          status: 401,
          code: 'unauthorized',
          message: `API token is invalid: Bearer ${TEST_TOKEN} ${leakedSecret} ${TEST_TOKEN}`,
        },
        401,
      ),
    )

    const error = (await connectorWith(fetchImpl)
      .readPage(PAGE_ID)
      .catch((e: unknown) => e)) as NotionApiError

    expect(error).toBeInstanceOf(NotionApiError)
    expect(error.status).toBe(401)
    expect(error.code).toBe('unauthorized')
    for (const text of [error.message, error.body]) {
      expect(text).not.toContain(TEST_TOKEN)
      expect(text).not.toContain(leakedSecret)
      expect(text).toContain('[REDACTED')
    }
  })

  it('maps 429 rate_limited without retrying', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse({ object: 'error', status: 429, code: 'rate_limited', message: 'Slow down.' }, 429),
    )

    await expect(connectorWith(fetchImpl).readPage(PAGE_ID)).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('maps a non-JSON 502 body to code "unknown"', async () => {
    const fetchImpl = fakeFetch(new Response('<html>Bad gateway</html>', { status: 502 }))

    const error = (await connectorWith(fetchImpl)
      .readPage(PAGE_ID)
      .catch((e: unknown) => e)) as NotionApiError

    expect(error).toBeInstanceOf(NotionApiError)
    expect(error.status).toBe(502)
    expect(error.code).toBe('unknown')
    expect(error.body).toContain('Bad gateway')
  })

  it('throws before fetching when no token is configured', async () => {
    const fetchImpl = fakeFetch()

    await expect(new NotionConnector({ fetch: fetchImpl }).readPage(PAGE_ID)).rejects.toThrow(/token/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['', 'not-an-id', '../users/me', `${PAGE_ID}/children`, `${PAGE_ID}?x=1`])(
    'rejects invalid page id %j without fetching',
    async (badId) => {
      const fetchImpl = fakeFetch()

      await expect(connectorWith(fetchImpl).readPage(badId)).rejects.toThrow(/id/i)
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )
})

describe('NotionConnector.queryDatabase', () => {
  it('POSTs /v1/databases/{id}/query with a JSON body and returns the result page', async () => {
    const body = {
      object: 'list',
      results: [{ object: 'page', id: PAGE_ID }],
      next_cursor: null,
      has_more: false,
    }
    const fetchImpl = fakeFetch(jsonResponse(body))
    const query = {
      filter: { property: 'Status', select: { equals: 'Done' } },
      sorts: [{ property: 'Created', direction: 'descending' }],
      page_size: 50,
    }

    const result = await connectorWith(fetchImpl).queryDatabase(DATABASE_ID, query)

    expect(result).toEqual(body)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`)
    expect(init?.method).toBe('POST')
    const headers = headersOf(init)
    expect(headers['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers['notion-version']).toBe('2022-06-28')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual(query)
  })

  it('sends an empty JSON object when no query is given', async () => {
    const fetchImpl = fakeFetch(jsonResponse({ object: 'list', results: [], next_cursor: null, has_more: false }))

    await connectorWith(fetchImpl).queryDatabase(DATABASE_ID)

    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({})
  })

  it('surfaces next_cursor/has_more and forwards start_cursor on the next call', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse({ object: 'list', results: [{ id: 'a' }], next_cursor: 'cursor-2', has_more: true }),
      jsonResponse({ object: 'list', results: [{ id: 'b' }], next_cursor: null, has_more: false }),
    )
    const connector = connectorWith(fetchImpl)

    const first = await connector.queryDatabase(DATABASE_ID, { page_size: 1 })
    expect(first.has_more).toBe(true)
    expect(first.next_cursor).toBe('cursor-2')

    const second = await connector.queryDatabase(DATABASE_ID, {
      page_size: 1,
      start_cursor: first.next_cursor ?? undefined,
    })
    expect(second.has_more).toBe(false)
    expect(second.next_cursor).toBeNull()
    expect(second.results).toEqual([{ id: 'b' }])

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({ page_size: 1 })
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body))).toEqual({
      page_size: 1,
      start_cursor: 'cursor-2',
    })
  })

  it('maps API errors to NotionApiError', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse(
        { object: 'error', status: 400, code: 'validation_error', message: 'body.filter is invalid' },
        400,
      ),
    )

    await expect(connectorWith(fetchImpl).queryDatabase(DATABASE_ID, {})).rejects.toMatchObject({
      name: 'NotionApiError',
      status: 400,
      code: 'validation_error',
    })
  })

  it.each([0, 101, 1.5])('rejects page_size %s without fetching', async (pageSize) => {
    const fetchImpl = fakeFetch()

    await expect(
      connectorWith(fetchImpl).queryDatabase(DATABASE_ID, { page_size: pageSize }),
    ).rejects.toThrow(/page_size/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an invalid database id without fetching', async () => {
    const fetchImpl = fakeFetch()

    await expect(connectorWith(fetchImpl).queryDatabase('../search', {})).rejects.toThrow(/id/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
