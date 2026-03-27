import { describe, it, expect, vi } from 'vitest'
import { MCPResourceClient } from '../mcp-resources.js'
import type { MCPResourceClientConfig } from '../mcp-resources.js'
import type { MCPResourceContent } from '../mcp-resource-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(
  overrides: Partial<MCPResourceClientConfig> = {},
): {
  client: MCPResourceClient
  sendRequest: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
} {
  const sendRequest = vi.fn<MCPResourceClientConfig['sendRequest']>()
  const onNotification = vi.fn<NonNullable<MCPResourceClientConfig['onNotification']>>()

  const client = new MCPResourceClient({
    sendRequest: overrides.sendRequest ?? sendRequest,
    onNotification: overrides.onNotification ?? onNotification,
  })

  return { client, sendRequest, onNotification }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPResourceClient', () => {
  describe('listResources', () => {
    it('returns parsed resources from server response', async () => {
      const { client, sendRequest } = createClient()
      sendRequest.mockResolvedValueOnce({
        resources: [
          { uri: 'file:///a.txt', name: 'a.txt', description: 'File A', mimeType: 'text/plain' },
          { uri: 'file:///b.json', name: 'b.json' },
        ],
      })

      const resources = await client.listResources()

      expect(sendRequest).toHaveBeenCalledWith('resources/list')
      expect(resources).toHaveLength(2)
      expect(resources[0]).toEqual({
        uri: 'file:///a.txt',
        name: 'a.txt',
        description: 'File A',
        mimeType: 'text/plain',
      })
      expect(resources[1]).toEqual({
        uri: 'file:///b.json',
        name: 'b.json',
        description: undefined,
        mimeType: undefined,
      })
    })

    it('returns empty array when response has no resources', async () => {
      const { client, sendRequest } = createClient()
      sendRequest.mockResolvedValueOnce({})

      const resources = await client.listResources()
      expect(resources).toEqual([])
    })

    it('returns empty array when response is null', async () => {
      const { client, sendRequest } = createClient()
      sendRequest.mockResolvedValueOnce(null)

      const resources = await client.listResources()
      expect(resources).toEqual([])
    })
  })

  describe('listResourceTemplates', () => {
    it('returns parsed templates from server response', async () => {
      const { client, sendRequest } = createClient()
      sendRequest.mockResolvedValueOnce({
        resourceTemplates: [
          {
            uriTemplate: 'file:///{path}',
            name: 'File by path',
            description: 'Read a file',
            mimeType: 'application/octet-stream',
          },
        ],
      })

      const templates = await client.listResourceTemplates()

      expect(sendRequest).toHaveBeenCalledWith('resources/templates/list')
      expect(templates).toHaveLength(1)
      expect(templates[0]).toEqual({
        uriTemplate: 'file:///{path}',
        name: 'File by path',
        description: 'Read a file',
        mimeType: 'application/octet-stream',
      })
    })

    it('returns empty array when no templates', async () => {
      const { client, sendRequest } = createClient()
      sendRequest.mockResolvedValueOnce(null)

      const templates = await client.listResourceTemplates()
      expect(templates).toEqual([])
    })
  })

  describe('readResource', () => {
    it('returns text content', async () => {
      const { client, sendRequest } = createClient()
      sendRequest.mockResolvedValueOnce({
        contents: [
          { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'Hello world' },
        ],
      })

      const content = await client.readResource('file:///a.txt')

      expect(sendRequest).toHaveBeenCalledWith('resources/read', { uri: 'file:///a.txt' })
      expect(content).toEqual({
        uri: 'file:///a.txt',
        mimeType: 'text/plain',
        text: 'Hello world',
        blob: undefined,
      })
    })

    it('returns blob content', async () => {
      const { client, sendRequest } = createClient()
      const base64Data = Buffer.from('binary data').toString('base64')
      sendRequest.mockResolvedValueOnce({
        contents: [
          { uri: 'file:///img.png', mimeType: 'image/png', blob: base64Data },
        ],
      })

      const content = await client.readResource('file:///img.png')

      expect(content.blob).toBe(base64Data)
      expect(content.mimeType).toBe('image/png')
    })

    it('returns fallback content when response is empty', async () => {
      const { client, sendRequest } = createClient()
      sendRequest.mockResolvedValueOnce({ contents: [] })

      const content = await client.readResource('file:///missing.txt')
      expect(content).toEqual({ uri: 'file:///missing.txt' })
    })

    it('returns fallback content when response is null', async () => {
      const { client, sendRequest } = createClient()
      sendRequest.mockResolvedValueOnce(null)

      const content = await client.readResource('file:///missing.txt')
      expect(content).toEqual({ uri: 'file:///missing.txt' })
    })
  })

  describe('subscribeToResource', () => {
    it('sends subscribe request and registers notification handler', () => {
      const { client, sendRequest, onNotification } = createClient()
      sendRequest.mockResolvedValue(undefined)

      const handler = vi.fn()
      client.subscribeToResource('file:///watched.txt', handler)

      expect(sendRequest).toHaveBeenCalledWith('resources/subscribe', { uri: 'file:///watched.txt' })
      expect(onNotification).toHaveBeenCalledWith(
        'notifications/resources/updated',
        expect.any(Function),
      )
    })

    it('calls handler on update notification', async () => {
      const sendRequest = vi.fn<MCPResourceClientConfig['sendRequest']>()
      let notificationCallback: ((params: unknown) => void) | undefined
      const onNotification = vi.fn((method: string, handler: (params: unknown) => void) => {
        if (method === 'notifications/resources/updated') {
          notificationCallback = handler
        }
      })

      const client = new MCPResourceClient({ sendRequest, onNotification })

      // First call: subscribe request (fire-and-forget)
      sendRequest.mockResolvedValue(undefined)

      const handler = vi.fn()
      client.subscribeToResource('file:///watched.txt', handler)

      // Mock readResource response for the notification flow
      const updatedContent: MCPResourceContent = {
        uri: 'file:///watched.txt',
        mimeType: 'text/plain',
        text: 'Updated content',
      }
      sendRequest.mockResolvedValueOnce({
        contents: [updatedContent],
      })

      // Trigger the notification
      expect(notificationCallback).toBeDefined()
      notificationCallback!({ uri: 'file:///watched.txt' })

      // Wait for the async readResource + handler call
      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith('file:///watched.txt', {
          uri: 'file:///watched.txt',
          mimeType: 'text/plain',
          text: 'Updated content',
          blob: undefined,
        })
      })
    })

    it('unsubscribe removes handler and sends unsubscribe request', () => {
      const { client, sendRequest } = createClient()
      sendRequest.mockResolvedValue(undefined)

      const handler = vi.fn()
      const sub = client.subscribeToResource('file:///watched.txt', handler)

      expect(sub.uri).toBe('file:///watched.txt')

      sub.unsubscribe()

      // Should have sent unsubscribe
      expect(sendRequest).toHaveBeenCalledWith('resources/unsubscribe', { uri: 'file:///watched.txt' })
    })
  })

  describe('dispose', () => {
    it('cleans up all subscriptions', () => {
      const { client, sendRequest } = createClient()
      sendRequest.mockResolvedValue(undefined)

      const handler1 = vi.fn()
      const handler2 = vi.fn()
      client.subscribeToResource('file:///a.txt', handler1)
      client.subscribeToResource('file:///b.txt', handler2)

      client.dispose()

      // Should have sent unsubscribe for both
      const unsubCalls = sendRequest.mock.calls.filter(
        (call) => call[0] === 'resources/unsubscribe',
      )
      expect(unsubCalls).toHaveLength(2)
    })
  })
})
