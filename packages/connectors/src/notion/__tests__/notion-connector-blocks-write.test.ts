import { describe, expect, it, vi } from 'vitest'
import { NotionApiError, NotionConnector } from '../notion-connector.js'

// Obvious placeholder; never a real credential. All requests go to an injected fake fetch.
const TEST_TOKEN = 'test-notion-token-placeholder'
const BLOCK_ID = '0123456789abcdef0123456789abcdef'
const CHILD_ID = 'fedcba98-7654-3210-fedc-ba9876543210'

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

const paragraph = (content: string) => ({
  object: 'block',
  type: 'paragraph',
  paragraph: { rich_text: [{ type: 'text', text: { content } }] },
})

const childBlock = { object: 'block', id: CHILD_ID, type: 'paragraph', archived: false }

describe('NotionConnector.appendBlockChildren', () => {
  it('PATCHes /v1/blocks/{id}/children with { children } and returns the list', async () => {
    const list = { object: 'list', results: [childBlock], next_cursor: null, has_more: false }
    const fetchImpl = fakeFetch(jsonResponse(list))
    const children = [paragraph('Hello')]

    const result = await connectorWith(fetchImpl).appendBlockChildren(BLOCK_ID, children)

    expect(result).toEqual(list)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://api.notion.com/v1/blocks/${BLOCK_ID}/children`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ children })
    const headers = headersOf(init)
    expect(headers['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers['notion-version']).toBe('2022-06-28')
    expect(headers['content-type']).toBe('application/json')
  })

  it('accepts exactly 100 children', async () => {
    const fetchImpl = fakeFetch(jsonResponse({ object: 'list', results: [], next_cursor: null, has_more: false }))
    const children = Array.from({ length: 100 }, (_, i) => paragraph(`line ${i}`))

    await connectorWith(fetchImpl).appendBlockChildren(BLOCK_ID, children)

    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).children).toHaveLength(100)
  })

  it('maps API errors to NotionApiError with the token redacted', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse(
        { object: 'error', status: 400, code: 'validation_error', message: `bad children for ${TEST_TOKEN}` },
        400,
      ),
    )

    const error = await connectorWith(fetchImpl)
      .appendBlockChildren(BLOCK_ID, [paragraph('x')])
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotionApiError)
    expect(error).toMatchObject({ status: 400, code: 'validation_error' })
    expect(String((error as Error).message)).not.toContain(TEST_TOKEN)
    expect((error as NotionApiError).body).not.toContain(TEST_TOKEN)
  })

  it.each([
    ['an empty array', []],
    ['more than 100 children', Array.from({ length: 101 }, () => paragraph('x'))],
    ['a non-array', { type: 'paragraph' } as unknown as Record<string, unknown>[]],
    ['a null child', [null] as unknown as Record<string, unknown>[]],
    ['an array child', [[]] as unknown as Record<string, unknown>[]],
  ])('rejects %s without fetching', async (_label, children) => {
    const fetchImpl = fakeFetch()

    await expect(connectorWith(fetchImpl).appendBlockChildren(BLOCK_ID, children)).rejects.toThrow(/children/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['', '../pages', `${BLOCK_ID}/children`])('rejects invalid block id %j without fetching', async (badId) => {
    const fetchImpl = fakeFetch()

    await expect(connectorWith(fetchImpl).appendBlockChildren(badId, [paragraph('x')])).rejects.toThrow(/id/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws before fetching when no token is configured', async () => {
    const fetchImpl = fakeFetch()

    await expect(
      new NotionConnector({ fetch: fetchImpl }).appendBlockChildren(BLOCK_ID, [paragraph('x')]),
    ).rejects.toThrow(/token/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('NotionConnector.updateBlock', () => {
  it('PATCHes /v1/blocks/{id} with the JSON payload and returns the block', async () => {
    const updated = { ...childBlock, paragraph: { rich_text: [] } }
    const fetchImpl = fakeFetch(jsonResponse(updated))
    const payload = { paragraph: { rich_text: [{ type: 'text', text: { content: 'Edited' } }] } }

    const result = await connectorWith(fetchImpl).updateBlock(CHILD_ID, payload)

    expect(result).toEqual(updated)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://api.notion.com/v1/blocks/${CHILD_ID}`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual(payload)
    const headers = headersOf(init)
    expect(headers['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers['content-type']).toBe('application/json')
  })

  it('maps API errors to NotionApiError', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse({ object: 'error', status: 404, code: 'object_not_found', message: 'No block.' }, 404),
    )

    const error = await connectorWith(fetchImpl)
      .updateBlock(CHILD_ID, { paragraph: {} })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotionApiError)
    expect(error).toMatchObject({ status: 404, code: 'object_not_found' })
  })

  it.each(['', '../pages', `${BLOCK_ID}?archived=true`])('rejects invalid block id %j without fetching', async (badId) => {
    const fetchImpl = fakeFetch()

    await expect(connectorWith(fetchImpl).updateBlock(badId, {})).rejects.toThrow(/id/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('NotionConnector.deleteBlock', () => {
  it('DELETEs /v1/blocks/{id} without a body and returns the archived block', async () => {
    const archived = { ...childBlock, archived: true }
    const fetchImpl = fakeFetch(jsonResponse(archived))

    const result = await connectorWith(fetchImpl).deleteBlock(CHILD_ID)

    expect(result).toEqual(archived)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://api.notion.com/v1/blocks/${CHILD_ID}`)
    expect(init?.method).toBe('DELETE')
    expect(init?.body).toBeUndefined()
    const headers = headersOf(init)
    expect(headers['authorization']).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers['notion-version']).toBe('2022-06-28')
    expect(headers['content-type']).toBeUndefined()
  })

  it('maps API errors to NotionApiError', async () => {
    const fetchImpl = fakeFetch(
      jsonResponse({ object: 'error', status: 403, code: 'restricted_resource', message: 'No access.' }, 403),
    )

    const error = await connectorWith(fetchImpl).deleteBlock(CHILD_ID).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotionApiError)
    expect(error).toMatchObject({ status: 403, code: 'restricted_resource' })
  })

  it.each(['', '../pages', `${BLOCK_ID}/children`])('rejects invalid block id %j without fetching', async (badId) => {
    const fetchImpl = fakeFetch()

    await expect(connectorWith(fetchImpl).deleteBlock(badId)).rejects.toThrow(/id/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
