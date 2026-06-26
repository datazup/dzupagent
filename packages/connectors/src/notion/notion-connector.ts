export interface NotionConnectorConfig {
  token?: string
  client?: unknown
  enabledTools?: string[]
}

export type NotionPayload = Record<string, unknown>

export class NotionConnector {
  constructor(readonly config: NotionConnectorConfig = {}) {}

  async createPage(payload: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.createPage is not implemented')
  }

  async readPage(pageId: string): Promise<unknown> {
    throw new Error('NotionConnector.readPage is not implemented')
  }

  async updatePage(pageId: string, payload: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.updatePage is not implemented')
  }

  async archivePage(pageId: string): Promise<unknown> {
    throw new Error('NotionConnector.archivePage is not implemented')
  }

  async queryDatabase(databaseId: string, query: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.queryDatabase is not implemented')
  }

  async appendBlockChildren(blockId: string, children: NotionPayload[]): Promise<unknown> {
    throw new Error('NotionConnector.appendBlockChildren is not implemented')
  }

  async updateBlock(blockId: string, payload: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.updateBlock is not implemented')
  }

  async deleteBlock(blockId: string): Promise<unknown> {
    throw new Error('NotionConnector.deleteBlock is not implemented')
  }

  async listBlockChildren(blockId: string): Promise<unknown> {
    throw new Error('NotionConnector.listBlockChildren is not implemented')
  }

  async search(payload: NotionPayload): Promise<unknown> {
    throw new Error('NotionConnector.search is not implemented')
  }
}
