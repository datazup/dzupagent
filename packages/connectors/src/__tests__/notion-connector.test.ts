import { describe, expect, it, vi } from 'vitest'
import { NotionApiError, NotionConnector } from '../notion/notion-connector.js'

const ID = '0123456789abcdef0123456789abcdef'
const TOKEN = 'test-notion-contract-placeholder'
const page = { object: 'page', id: ID, properties: { title: 'Café notes' } }
const block = { object: 'block', id: ID, type: 'paragraph' }
const list = { object: 'list', results: [page], has_more: false, next_cursor: null }

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Exercise the real methods: only the HTTP boundary is replaced. The former
// suite mocked every public method and could pass with obsolete return shapes.
describe('NotionConnector transport contract', () => {
  const cases: Array<{
    name: string
    invoke: (connector: NotionConnector) => Promise<unknown>
    path: string
    method: string
    body: unknown
  }> = [
    { name: 'createPage', invoke: c => c.createPage({ parent: { database_id: ID }, properties: page.properties }), path: '/v1/pages', method: 'POST', body: page },
    { name: 'readPage', invoke: c => c.readPage(ID), path: `/v1/pages/${ID}`, method: 'GET', body: page },
    { name: 'updatePage', invoke: c => c.updatePage(ID, { properties: page.properties }), path: `/v1/pages/${ID}`, method: 'PATCH', body: page },
    { name: 'archivePage', invoke: c => c.archivePage(ID), path: `/v1/pages/${ID}`, method: 'PATCH', body: { ...page, archived: true } },
    { name: 'queryDatabase', invoke: c => c.queryDatabase(ID), path: `/v1/databases/${ID}/query`, method: 'POST', body: list },
    { name: 'appendBlockChildren', invoke: c => c.appendBlockChildren(ID, [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }]), path: `/v1/blocks/${ID}/children`, method: 'PATCH', body: { ...list, results: [block] } },
    { name: 'updateBlock', invoke: c => c.updateBlock(ID, { paragraph: { rich_text: [] } }), path: `/v1/blocks/${ID}`, method: 'PATCH', body: block },
    { name: 'deleteBlock', invoke: c => c.deleteBlock(ID), path: `/v1/blocks/${ID}`, method: 'DELETE', body: { ...block, archived: true } },
    { name: 'listBlockChildren', invoke: c => c.listBlockChildren(ID), path: `/v1/blocks/${ID}/children`, method: 'GET', body: { ...list, results: [block] } },
    { name: 'search', invoke: c => c.search({ query: 'Café' }), path: '/v1/search', method: 'POST', body: list },
  ]

  it.each(cases)('$name returns the REST response and uses the expected endpoint', async ({ invoke, path, method, body }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(body))
    const connector = new NotionConnector({ token: TOKEN, fetch: fetchImpl })

    expect(await invoke(connector)).toEqual(body)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://api.notion.com${path}`)
    expect(init?.method).toBe(method)
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('propagates a typed server failure and recovers on a later request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 'object_not_found', message: `missing ${TOKEN}` }, 404))
      .mockResolvedValueOnce(response(page))
    const connector = new NotionConnector({ token: TOKEN, fetch: fetchImpl })

    const error: unknown = await connector.readPage(ID).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(NotionApiError)
    expect(error).toMatchObject({ status: 404, code: 'object_not_found' })
    expect(String(error)).not.toContain(TOKEN)
    expect(await connector.readPage(ID)).toEqual(page)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
