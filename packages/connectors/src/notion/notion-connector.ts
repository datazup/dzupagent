/**
 * Notion connector — direct REST calls through the outbound URL policy.
 *
 * Read paths (`readPage`, `queryDatabase`, `listBlockChildren`, `search`) are implemented; the remaining
 * methods are stubs until their own packets land.
 */
import { fetchWithOutboundUrlPolicy, type OutboundUrlSecurityPolicy } from '@dzupagent/core/security'

import { NotionApiError } from './notion-api-error.js'

export { NotionApiError } from './notion-api-error.js'

export interface NotionConnectorConfig {
  token?: string
  client?: unknown
  enabledTools?: string[]
  /** Fetch implementation; defaults to the platform fetch behind the outbound URL policy. */
  fetch?: typeof fetch
  /** Defaults to `https://api.notion.com`. */
  baseUrl?: string
  /** `Notion-Version` header; defaults to `2022-06-28`. */
  notionVersion?: string
}

export type NotionPayload = Record<string, unknown>

export interface NotionPage {
  object: 'page'
  id: string
  [key: string]: unknown
}

export interface NotionList<T> {
  object: 'list'
  results: T[]
  next_cursor: string | null
  has_more: boolean
  [key: string]: unknown
}

export interface NotionDatabaseQuery {
  filter?: NotionPayload
  sorts?: NotionPayload[]
  start_cursor?: string
  page_size?: number
  [key: string]: unknown
}

export interface NotionBlock {
  object: 'block'
  id: string
  [key: string]: unknown
}

export interface NotionPaginationOptions {
  start_cursor?: string
  page_size?: number
}

export interface NotionSearchQuery extends NotionPaginationOptions {
  query?: string
  filter?: NotionPayload
  sort?: NotionPayload
  [key: string]: unknown
}

const DEFAULT_BASE_URL = 'https://api.notion.com'
const DEFAULT_NOTION_VERSION = '2022-06-28'
const NOTION_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function defaultNotionOutboundPolicy(baseUrl: string): OutboundUrlSecurityPolicy | undefined {
  try {
    if (new URL(baseUrl).hostname === 'api.notion.com') {
      return { allowedHosts: ['api.notion.com'] }
    }
  } catch {
    return undefined
  }
  return undefined
}

function assertNotionId(kind: string, id: string): void {
  if (!NOTION_ID_PATTERN.test(id)) {
    throw new Error(`Invalid Notion ${kind} id: expected 32 hex characters (dashes optional)`)
  }
}

function assertPageSize(pageSize: unknown): void {
  if (pageSize === undefined) return
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('Invalid Notion page_size: expected an integer from 1 to 100')
  }
}

export class NotionConnector {
  private readonly baseUrl: string
  private readonly outboundUrlPolicy: OutboundUrlSecurityPolicy | undefined

  constructor(readonly config: NotionConnectorConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.outboundUrlPolicy = defaultNotionOutboundPolicy(this.baseUrl)
  }

  /** Low-level request helper — returns parsed JSON or throws NotionApiError. */
  private async request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const token = this.config.token
    if (!token) {
      throw new Error('NotionConnector requires a token')
    }
    const { json, ...rest } = init
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Notion-Version': this.config.notionVersion ?? DEFAULT_NOTION_VERSION,
    }
    if (json !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetchWithOutboundUrlPolicy(
      `${this.baseUrl}${path}`,
      {
        ...rest,
        headers,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      },
      { policy: this.outboundUrlPolicy, fetchImpl: this.config.fetch },
    )
    if (!res.ok) {
      throw new NotionApiError(res.status, await res.text(), [token])
    }
    return res.json() as Promise<T>
  }

  async createPage(_payload: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.createPage is not implemented')
  }

  /** `GET /v1/pages/{pageId}`. */
  async readPage(pageId: string): Promise<NotionPage> {
    assertNotionId('page', pageId)
    return this.request<NotionPage>(`/v1/pages/${pageId}`, { method: 'GET' })
  }

  async updatePage(_pageId: string, _payload: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.updatePage is not implemented')
  }

  async archivePage(_pageId: string): Promise<unknown> {
    throw new Error('NotionConnector.archivePage is not implemented')
  }

  /**
   * `POST /v1/databases/{databaseId}/query` — returns one page of results.
   * Callers paginate by passing `next_cursor` back as `start_cursor`.
   */
  async queryDatabase(databaseId: string, query: NotionDatabaseQuery = {}): Promise<NotionList<NotionPage>> {
    assertNotionId('database', databaseId)
    assertPageSize(query.page_size)
    return this.request<NotionList<NotionPage>>(`/v1/databases/${databaseId}/query`, {
      method: 'POST',
      json: query,
    })
  }

  async appendBlockChildren(_blockId: string, _children: NotionPayload[]): Promise<unknown> {
    throw new Error('NotionConnector.appendBlockChildren is not implemented')
  }

  async updateBlock(_blockId: string, _payload: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.updateBlock is not implemented')
  }

  async deleteBlock(_blockId: string): Promise<unknown> {
    throw new Error('NotionConnector.deleteBlock is not implemented')
  }

  /**
   * `GET /v1/blocks/{blockId}/children` — returns one page of child blocks.
   * Callers paginate by passing `next_cursor` back as `start_cursor`.
   */
  async listBlockChildren(
    blockId: string,
    options: NotionPaginationOptions = {},
  ): Promise<NotionList<NotionBlock>> {
    assertNotionId('block', blockId)
    assertPageSize(options.page_size)
    const params = new URLSearchParams()
    if (options.start_cursor !== undefined) params.set('start_cursor', options.start_cursor)
    if (options.page_size !== undefined) params.set('page_size', String(options.page_size))
    const query = params.toString()
    return this.request<NotionList<NotionBlock>>(
      `/v1/blocks/${blockId}/children${query ? `?${query}` : ''}`,
      { method: 'GET' },
    )
  }

  /** `POST /v1/search` — returns one page of matching pages/databases. */
  async search(payload: NotionSearchQuery = {}): Promise<NotionList<NotionPayload>> {
    assertPageSize(payload.page_size)
    return this.request<NotionList<NotionPayload>>('/v1/search', {
      method: 'POST',
      json: payload,
    })
  }
}
