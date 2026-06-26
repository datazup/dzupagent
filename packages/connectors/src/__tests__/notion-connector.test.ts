import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotionConnector, type NotionPayload } from '../notion/notion-connector.js'

interface MockPage {
  id: string
  parent: { database_id?: string; page_id?: string }
  properties: Record<string, unknown>
  title: string
  content: string
  archived: boolean
}

interface MockRow {
  id: string
  databaseId: string
  properties: Record<string, unknown>
}

interface MockBlock {
  id: string
  parentId: string
  type: string
  content: string
  archived: boolean
}

type QueryFilter = {
  property: string
  equals?: unknown
  notEquals?: unknown
  contains?: string
  greaterThan?: number
  lessThan?: number
  checkbox?: boolean
}

let connector: NotionConnector
let pages: Map<string, MockPage>
let databaseRows: MockRow[]
let blocks: Map<string, MockBlock>

function page(id: string, title: string, properties: Record<string, unknown> = {}): MockPage {
  return {
    id,
    parent: { database_id: 'db-products' },
    properties,
    title,
    content: `${title} workspace note`,
    archived: false,
  }
}

function block(id: string, parentId: string, content: string, archived = false): MockBlock {
  return { id, parentId, type: 'paragraph', content, archived }
}

function matchesFilter(row: MockRow, filter?: QueryFilter): boolean {
  if (!filter) return true
  const value = row.properties[filter.property]
  if ('equals' in filter && value !== filter.equals) return false
  if ('notEquals' in filter && value === filter.notEquals) return false
  if (filter.contains && !String(value).includes(filter.contains)) return false
  if (typeof filter.greaterThan === 'number' && Number(value) <= filter.greaterThan) return false
  if (typeof filter.lessThan === 'number' && Number(value) >= filter.lessThan) return false
  if (typeof filter.checkbox === 'boolean' && value !== filter.checkbox) return false
  return true
}

function installMockBehavior(): void {
  vi.spyOn(connector, 'createPage').mockImplementation(async (payload: NotionPayload) => {
    const id = typeof payload.id === 'string' ? payload.id : `page-${pages.size + 1}`
    const properties = (payload.properties as Record<string, unknown> | undefined) ?? {}
    const created = page(id, String(properties.title ?? payload.title ?? id), properties)
    pages.set(id, created)
    return { success: true, page: created }
  })

  vi.spyOn(connector, 'readPage').mockImplementation(async (pageId: string) => {
    const existing = pages.get(pageId)
    return existing && !existing.archived
      ? { success: true, page: existing }
      : { success: false, error: 'Page not found' }
  })

  vi.spyOn(connector, 'updatePage').mockImplementation(async (pageId: string, payload: NotionPayload) => {
    const existing = pages.get(pageId)
    if (!existing || existing.archived) return { success: false, error: 'Page not found' }
    const properties = { ...existing.properties, ...((payload.properties as Record<string, unknown> | undefined) ?? {}) }
    const updated = { ...existing, properties, title: String(properties.title ?? existing.title) }
    pages.set(pageId, updated)
    return { success: true, page: updated }
  })

  vi.spyOn(connector, 'archivePage').mockImplementation(async (pageId: string) => {
    const existing = pages.get(pageId)
    if (!existing || existing.archived) return { success: false, error: 'Page not found' }
    const archived = { ...existing, archived: true }
    pages.set(pageId, archived)
    return { success: true, page: archived }
  })

  vi.spyOn(connector, 'queryDatabase').mockImplementation(async (databaseId: string, query: NotionPayload) => {
    const filter = query.filter as QueryFilter | undefined
    return {
      success: true,
      results: databaseRows.filter((row) => row.databaseId === databaseId && matchesFilter(row, filter)),
    }
  })

  vi.spyOn(connector, 'appendBlockChildren').mockImplementation(async (blockId: string, children: NotionPayload[]) => {
    const created = children.map((child, index) => {
      const id = typeof child.id === 'string' ? child.id : `${blockId}-child-${index + 1}`
      const next = block(id, blockId, String(child.content ?? ''))
      blocks.set(id, next)
      return next
    })
    return { success: true, children: created }
  })

  vi.spyOn(connector, 'updateBlock').mockImplementation(async (blockId: string, payload: NotionPayload) => {
    const existing = blocks.get(blockId)
    if (!existing || existing.archived) return { success: false, error: 'Block not found' }
    const updated = { ...existing, content: String(payload.content ?? existing.content) }
    blocks.set(blockId, updated)
    return { success: true, block: updated }
  })

  vi.spyOn(connector, 'deleteBlock').mockImplementation(async (blockId: string) => {
    const existing = blocks.get(blockId)
    if (!existing || existing.archived) return { success: false, error: 'Block not found' }
    const archived = { ...existing, archived: true }
    blocks.set(blockId, archived)
    return { success: true, block: archived }
  })

  vi.spyOn(connector, 'listBlockChildren').mockImplementation(async (blockId: string) => ({
    success: true,
    children: [...blocks.values()].filter((child) => child.parentId === blockId && !child.archived),
  }))

  vi.spyOn(connector, 'search').mockImplementation(async (payload: NotionPayload) => {
    const query = String(payload.query ?? '').toLowerCase()
    const filter = payload.filter as { value?: 'page' | 'database' | 'block' } | undefined
    const pageResults = [...pages.values()]
      .filter((candidate) => !candidate.archived)
      .filter((candidate) => `${candidate.title} ${candidate.content}`.toLowerCase().includes(query))
      .map((candidate) => ({ object: 'page', id: candidate.id, title: candidate.title }))
    const databaseResults = databaseRows
      .filter((candidate) => JSON.stringify(candidate.properties).toLowerCase().includes(query))
      .map((candidate) => ({ object: 'database', id: candidate.id, databaseId: candidate.databaseId }))
    const blockResults = [...blocks.values()]
      .filter((candidate) => !candidate.archived && candidate.content.toLowerCase().includes(query))
      .map((candidate) => ({ object: 'block', id: candidate.id, content: candidate.content }))
    const results = [...pageResults, ...databaseResults, ...blockResults].filter((candidate) =>
      filter?.value ? candidate.object === filter.value : true,
    )
    return { success: true, results }
  })
}

beforeEach(() => {
  connector = new NotionConnector({ token: 'test-token', client: { request: vi.fn() } })
  pages = new Map([
    ['page-alpha', page('page-alpha', 'Alpha launch', { title: 'Alpha launch', status: 'Draft', owner: 'Ada' })],
    ['page-beta', page('page-beta', 'Beta metrics', { title: 'Beta metrics', status: 'Published', owner: 'Grace' })],
  ])
  databaseRows = [
    { id: 'row-1', databaseId: 'db-products', properties: { title: 'Alpha', status: 'Active', priority: 3, owner: 'Ada', done: false } },
    { id: 'row-2', databaseId: 'db-products', properties: { title: 'Beta', status: 'Archived', priority: 1, owner: 'Grace', done: true } },
    { id: 'row-3', databaseId: 'db-products', properties: { title: 'Gamma', status: 'Active', priority: 5, owner: 'Linus', done: false } },
    { id: 'row-4', databaseId: 'db-archive', properties: { title: 'Delta', status: 'Active', priority: 8, owner: 'Ada', done: false } },
  ]
  blocks = new Map([
    ['block-root', block('block-root', 'page-alpha', 'Root block')],
    ['block-child-a', block('block-child-a', 'block-root', 'Alpha requirements')],
    ['block-child-b', block('block-child-b', 'block-root', 'Beta appendix')],
    ['block-deleted', block('block-deleted', 'block-root', 'Deleted content', true)],
  ])
  installMockBehavior()
})

describe('NotionConnector compile surface', () => {
  it.each([
    ['stores token config', () => expect(connector.config.token).toBe('test-token')],
    ['stores injected client config', () => expect(connector.config.client).toMatchObject({ request: expect.any(Function) })],
    ['exposes createPage method', () => expect(connector.createPage).toEqual(expect.any(Function))],
    ['exposes queryDatabase method', () => expect(connector.queryDatabase).toEqual(expect.any(Function))],
    ['exposes block methods', () => expect(connector.deleteBlock).toEqual(expect.any(Function))],
  ])('%s', async (_label, assertion) => {
    assertion()
  })
})

describe('NotionConnector page CRUD with mocked client behavior', () => {
  it.each([
    ['creates a page with a caller-provided id', { id: 'page-created', properties: { title: 'Created', status: 'Draft' } }, 'page-created'],
    ['creates a page with a generated id', { properties: { title: 'Generated', status: 'Draft' } }, 'page-3'],
    ['preserves utf-8 title text', { id: 'page-utf8', properties: { title: 'Cafe notes' } }, 'page-utf8'],
    ['preserves JSON-like custom properties', { id: 'page-json', properties: { tags: ['a', 'b'], score: 9 } }, 'page-json'],
  ])('%s', async (_label, payload, expectedId) => {
    const result = await connector.createPage(payload)

    expect(result).toMatchObject({ success: true, page: { id: expectedId } })
    expect(await connector.readPage(expectedId)).toMatchObject({ success: true, page: { id: expectedId } })
  })

  it.each([
    ['reads an existing draft page', 'page-alpha', 'Alpha launch'],
    ['reads an existing published page', 'page-beta', 'Beta metrics'],
    ['does not report success for a missing page', 'page-missing', undefined],
    ['does not report success after archive hides the page', 'page-alpha', undefined],
  ])('%s', async (_label, pageId, expectedTitle) => {
    if (_label.includes('after archive')) await connector.archivePage(pageId)

    const result = await connector.readPage(pageId)

    expect(result).toMatchObject(
      expectedTitle ? { success: true, page: { title: expectedTitle } } : { success: false },
    )
  })

  it.each([
    ['updates status property', 'page-alpha', { properties: { status: 'Published' } }, 'Published'],
    ['updates title property', 'page-alpha', { properties: { title: 'Alpha revised' } }, 'Alpha revised'],
    ['keeps unrelated properties', 'page-beta', { properties: { status: 'Reviewed' } }, 'Grace'],
    ['does not update a missing page', 'page-missing', { properties: { status: 'Published' } }, undefined],
    ['does not update an archived page', 'page-beta', { properties: { status: 'Reviewed' } }, undefined],
  ])('%s', async (_label, pageId, payload, expectedValue) => {
    if (_label.includes('archived')) await connector.archivePage(pageId)

    const result = await connector.updatePage(pageId, payload)

    expect(result).toMatchObject(expectedValue ? { success: true } : { success: false })
    if (expectedValue) expect(JSON.stringify(result)).toContain(expectedValue)
  })

  it.each([
    ['archives an existing page', 'page-alpha', true],
    ['archives a second existing page', 'page-beta', true],
    ['does not archive a missing page', 'page-missing', false],
    ['does not report success when archiving twice', 'page-alpha', false],
    ['prevents a prior success after a later archive', 'page-beta', true],
  ])('%s', async (_label, pageId, shouldSucceed) => {
    if (_label.includes('twice')) await connector.archivePage(pageId)
    const result = await connector.archivePage(pageId)
    const readAfterArchive = await connector.readPage(pageId)

    expect(result).toMatchObject({ success: shouldSucceed })
    expect(readAfterArchive).toMatchObject({ success: false })
  })
})

describe('NotionConnector database query filters with mocked rows', () => {
  it.each([
    ['includes rows matching equals filter', { property: 'status', equals: 'Active' }, ['row-1', 'row-3']],
    ['excludes rows failing equals filter', { property: 'status', equals: 'Active' }, ['row-2']],
    ['includes rows matching notEquals filter', { property: 'owner', notEquals: 'Ada' }, ['row-2', 'row-3']],
    ['excludes rows failing notEquals filter', { property: 'owner', notEquals: 'Ada' }, ['row-1']],
    ['includes rows containing text', { property: 'title', contains: 'amm' }, ['row-3']],
    ['excludes rows not containing text', { property: 'title', contains: 'amm' }, ['row-1', 'row-2']],
    ['includes rows greater than threshold', { property: 'priority', greaterThan: 2 }, ['row-1', 'row-3']],
    ['excludes rows at or below threshold', { property: 'priority', greaterThan: 2 }, ['row-2']],
    ['includes rows less than threshold', { property: 'priority', lessThan: 4 }, ['row-1', 'row-2']],
    ['excludes rows at or above threshold', { property: 'priority', lessThan: 4 }, ['row-3']],
    ['includes unchecked checkbox rows', { property: 'done', checkbox: false }, ['row-1', 'row-3']],
    ['excludes checked checkbox rows', { property: 'done', checkbox: false }, ['row-2']],
    ['scopes results to the requested database', undefined, ['row-1', 'row-2', 'row-3']],
    ['excludes rows from other databases', undefined, ['row-4']],
    ['returns no rows for unmatched filters', { property: 'status', equals: 'Missing' }, []],
    ['does not carry a prior failed filter into later success', { property: 'owner', equals: 'Ada' }, ['row-1']],
  ])('%s', async (label, filter, expectedIds) => {
    if (label.includes('prior failed')) {
      expect(await connector.queryDatabase('db-products', { filter: { property: 'owner', equals: 'Nobody' } })).toMatchObject({
        results: [],
      })
    }

    const result = await connector.queryDatabase('db-products', { filter })
    const ids = (result as { results: MockRow[] }).results.map((row) => row.id)

    if (label.includes('excludes')) {
      expect(ids).not.toEqual(expect.arrayContaining(expectedIds))
    } else {
      expect(ids).toEqual(expect.arrayContaining(expectedIds))
    }
  })
})

describe('NotionConnector block operations with mocked blocks', () => {
  it.each([
    ['appends one child block', [{ id: 'block-new-a', content: 'New child' }], ['block-new-a']],
    ['appends multiple child blocks in order', [{ id: 'block-new-b', content: 'First' }, { id: 'block-new-c', content: 'Second' }], ['block-new-b', 'block-new-c']],
    ['generates child ids when omitted', [{ content: 'Generated child' }], ['block-root-child-1']],
    ['preserves utf-8 block content', [{ id: 'block-utf8', content: 'Cafe block' }], ['block-utf8']],
  ])('%s', async (_label, children, expectedIds) => {
    const result = await connector.appendBlockChildren('block-root', children)
    const listed = await connector.listBlockChildren('block-root')

    expect(result).toMatchObject({ success: true })
    expect((listed as { children: MockBlock[] }).children.map((child) => child.id)).toEqual(expect.arrayContaining(expectedIds))
  })

  it.each([
    ['updates an active block', 'block-child-a', 'Updated requirements', true],
    ['updates a second active block', 'block-child-b', 'Updated appendix', true],
    ['does not update a missing block', 'block-missing', 'Missing', false],
    ['does not update a deleted block', 'block-deleted', 'Deleted update', false],
    ['does not let prior failed update block later success', 'block-child-a', 'Recovered update', true],
  ])('%s', async (label, blockId, content, shouldSucceed) => {
    if (label.includes('prior failed')) {
      expect(await connector.updateBlock('block-missing', { content: 'Nope' })).toMatchObject({ success: false })
    }

    const result = await connector.updateBlock(blockId, { content })

    expect(result).toMatchObject({ success: shouldSucceed })
    if (shouldSucceed) expect(result).toMatchObject({ block: { content } })
  })

  it.each([
    ['deletes an active child block', 'block-child-a', true],
    ['deletes a second active child block', 'block-child-b', true],
    ['does not delete a missing block', 'block-missing', false],
    ['does not delete an already deleted block', 'block-deleted', false],
    ['does not list a deleted block as active', 'block-child-a', true],
  ])('%s', async (_label, blockId, shouldSucceed) => {
    const result = await connector.deleteBlock(blockId)
    const listed = await connector.listBlockChildren('block-root')

    expect(result).toMatchObject({ success: shouldSucceed })
    expect((listed as { children: MockBlock[] }).children.map((child) => child.id)).not.toContain(blockId)
  })
})

describe('NotionConnector full-text workspace search with mocked content', () => {
  it.each([
    ['finds matching page title text', { query: 'alpha launch' }, ['page-alpha']],
    ['finds matching page body text', { query: 'workspace note' }, ['page-alpha', 'page-beta']],
    ['finds matching database row text', { query: 'gamma' }, ['row-3']],
    ['finds matching block text', { query: 'requirements' }, ['block-child-a']],
    ['filters search to pages', { query: 'alpha', filter: { value: 'page' } }, ['page-alpha']],
    ['filters search to databases', { query: 'active', filter: { value: 'database' } }, ['row-1', 'row-3', 'row-4']],
    ['filters search to blocks', { query: 'beta', filter: { value: 'block' } }, ['block-child-b']],
    ['is case insensitive', { query: 'ALPHA' }, ['page-alpha', 'row-1', 'block-child-a']],
    ['returns no unrelated pages for no match', { query: 'zanzibar' }, []],
    ['does not include archived pages', { query: 'beta metrics' }, []],
    ['does not include deleted blocks', { query: 'deleted content' }, []],
    ['does not carry no-match state into later success', { query: 'alpha' }, ['page-alpha']],
  ])('%s', async (label, payload, expectedIds) => {
    if (label.includes('archived pages')) await connector.archivePage('page-beta')
    if (label.includes('no-match state')) {
      expect(await connector.search({ query: 'nothing-here' })).toMatchObject({ results: [] })
    }

    const result = await connector.search(payload)
    const ids = (result as { results: Array<{ id: string }> }).results.map((item) => item.id)

    expect(ids).toEqual(expect.arrayContaining(expectedIds))
    if (expectedIds.length === 0) expect(ids).toEqual([])
  })
})
