export interface NotionConnectorConfig {
  token?: string
  client?: unknown
  enabledTools?: string[]
}

export type NotionPayload = Record<string, unknown>

export class NotionConnector {
  constructor(readonly config: NotionConnectorConfig = {}) {}

  async createPage(_payload: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.createPage is not implemented')
  }

  async readPage(_pageId: string): Promise<unknown> {
    throw new Error('NotionConnector.readPage is not implemented')
  }

  async updatePage(_pageId: string, _payload: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.updatePage is not implemented')
  }

  async archivePage(_pageId: string): Promise<unknown> {
    throw new Error('NotionConnector.archivePage is not implemented')
  }

  async queryDatabase(_databaseId: string, _query: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.queryDatabase is not implemented')
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

  async listBlockChildren(_blockId: string): Promise<unknown> {
    throw new Error('NotionConnector.listBlockChildren is not implemented')
  }

  async search(_payload: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.search is not implemented')
  }
}
