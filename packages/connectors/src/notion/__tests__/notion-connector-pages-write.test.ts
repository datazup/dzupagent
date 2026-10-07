import { describe, expect, it, vi } from 'vitest'
import { NotionApiError, NotionConnector } from '../notion-connector.js'

// Obvious placeholder; never a real credential. All requests go to an injected fake fetch.
const TEST_TOKEN = 'test-notion-token-placeholder'
const PAGE_ID = '0123456789abcdef0123456789abcdef'
const DATABASE_ID = 'fedcba98-7654-3210-fedc-ba9876543210'

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

const page = { object: 'page', id: PAGE_ID, archived: false }

describe('NotionConnector.createPage', () => {
  it('POSTs /v1/pages with the JSON payload and returns the created page', async () => {
    const fetchImpl = fakeFetch(jsonResponse(page))
    const payload = {
      parent: { database_id: DATABASE_ID },
      properties: { Name: { title: [{ text: { content: 'Roadmap' } }] } },
    }

    const result = await connectorWith(fetchImpl).createPage(payload)

    expect(result).toEqual(page)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.notion.com/v1/pages')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual(payload)
    const headers = headersOf(init)
    expect(headers['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers['notion-version']).toBe('2022-06-28')
    expect(headers['content-type']).toBe('application/json')
  })

  it('maps API errors to NotionApiError with the token redacted', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse(
        { object: 'error', status: 400, code: 'validation_error', message: `bad body for ${TEST_TOKEN}` },
        400,
      ),
    )

    const error = await connectorWith(fetchImpl)
      .createPage({ parent: { page_id: PAGE_ID } })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotionApiError)
    expect(error).toMatchObject({ status: 400, code: 'validation_error' })
    expect(String((error as Error).message)).not.toContain(TEST_TOKEN)
    expect((error as NotionApiError).body).not.toContain(TEST_TOKEN)
  })

  it.each([
    ['no parent', { properties: {} }],
    ['null parent', { parent: null }],
    ['array payload', [] as unknown as Record<string, unknown>],
  ])('rejects %s without fetching', async (_label, payload) => {
    const fetchImpl = fakeFetch()

    await expect(connectorWith(fetchImpl).createPage(payload)).rejects.toThrow(/parent/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws before fetching when no token is configured', async () => {
    const fetchImpl = fakeFetch()

    await expect(
      new NotionConnector({ fetch: fetchImpl }).createPage({ parent: { page_id: PAGE_ID } }),
    ).rejects.toThrow(/token/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('NotionConnector.updatePage', () => {
  it('PATCHes /v1/pages/{id} with the JSON payload and returns the page', async () => {
    const updated = { ...page, properties: { Status: { select: { name: 'Done' } } } }
    const fetchImpl = fakeFetch(jsonResponse(updated))
    const payload = { properties: { Status: { select: { name: 'Done' } } } }

    const result = await connectorWith(fetchImpl).updatePage(PAGE_ID, payload)

    expect(result).toEqual(updated)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://api.notion.com/v1/pages/${PAGE_ID}`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual(payload)
    const headers = headersOf(init)
    expect(headers['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers['content-type']).toBe('application/json')
  })

  it('maps API errors to NotionApiError', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse({ object: 'error', status: 404, code: 'object_not_found', message: 'No page.' }, 404),
    )

    const error = await connectorWith(fetchImpl)
      .updatePage(PAGE_ID, { properties: {} })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotionApiError)
    expect(error).toMatchObject({ status: 404, code: 'object_not_found' })
  })

  it.each(['', '../databases', `${PAGE_ID}/properties`, `${PAGE_ID}?archived=true`])(
    'rejects invalid page id %j without fetching',
    async (badId) => {
      const fetchImpl = fakeFetch()

      await expect(connectorWith(fetchImpl).updatePage(badId, {})).rejects.toThrow(/id/i)
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )
})

describe('NotionConnector.archivePage', () => {
  it('PATCHes /v1/pages/{id} with { archived: true } and returns the page', async () => {
    const archived = { ...page, archived: true }
    const fetchImpl = fakeFetch(jsonResponse(archived))

    const result = await connectorWith(fetchImpl).archivePage(PAGE_ID)

    expect(result).toEqual(archived)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://api.notion.com/v1/pages/${PAGE_ID}`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ archived: true })
    expect(headersOf(init)['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
  })

  it('maps API errors to NotionApiError', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse({ object: 'error', status: 403, code: 'restricted_resource', message: 'No access.' }, 403),
    )

    const error = await connectorWith(fetchImpl).archivePage(PAGE_ID).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotionApiError)
    expect(error).toMatchObject({ status: 403, code: 'restricted_resource' })
  })

  it.each(['', '../blocks', `${PAGE_ID}/x`])('rejects invalid page id %j without fetching', async (badId) => {
    const fetchImpl = fakeFetch()

    await expect(connectorWith(fetchImpl).archivePage(badId)).rejects.toThrow(/id/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
