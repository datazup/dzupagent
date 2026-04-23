import { beforeEach, describe, expect, vi } from 'vitest'
import { describeMcpPublisherCompatibilitySuite } from '../mcp-compatibility.js'

type FakeResponse = {
  statusCode: number
  body?: unknown
}

const dispatchMock = vi.fn<
  (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<FakeResponse>
>()

beforeEach(() => {
  dispatchMock.mockReset()
})

describeMcpPublisherCompatibilitySuite({
  suiteName: 'mcp compatibility suite helper',
  createHarness: () => ({
    get: (path) => dispatchMock('GET', path),
    post: (path, body) => dispatchMock('POST', path, body),
  }),
  prepareCase: async (caseName) => {
    switch (caseName) {
      case 'tools':
        dispatchMock.mockResolvedValueOnce({
          statusCode: 200,
          body: {
            tools: [{
              name: 'echo',
              description: 'Echo',
              inputSchema: { type: 'object', properties: {} },
            }],
          },
        })
        return
      case 'initialize':
        dispatchMock.mockResolvedValueOnce({
          statusCode: 200,
          body: {
            jsonrpc: '2.0',
            id: 1,
            result: { ok: true },
          },
        })
        return
      case 'null-id':
        dispatchMock.mockResolvedValueOnce({
          statusCode: 200,
          body: {
            jsonrpc: '2.0',
            id: null,
            result: { ok: true },
          },
        })
        return
      case 'notification':
        dispatchMock.mockResolvedValueOnce({
          statusCode: 204,
        })
        return
      case 'invalid-request':
        dispatchMock.mockResolvedValueOnce({
          statusCode: 400,
          body: {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32600,
              message: 'Invalid MCP request',
            },
          },
        })
        return
      case 'tool-call':
        dispatchMock.mockResolvedValueOnce({
          statusCode: 200,
          body: {
            jsonrpc: '2.0',
            id: 'tool-call-1',
            result: { echoed: 'hello' },
          },
        })
        return
      case 'resources':
        dispatchMock.mockResolvedValueOnce({
          statusCode: 200,
          body: {
            resources: [{
              uri: 'memory://overview',
              name: 'Overview',
            }],
          },
        })
        return
      case 'resource-templates':
        dispatchMock.mockResolvedValueOnce({
          statusCode: 200,
          body: {
            resourceTemplates: [{
              uriTemplate: 'project://{projectId}/report',
              name: 'Report',
            }],
          },
        })
        return
    }
  },
  expectedTools: [{
    name: 'echo',
    description: 'Echo',
    inputSchema: { type: 'object', properties: {} },
  }],
  toolCallCase: {
    request: {
      name: 'echo',
      arguments: { value: 'hello' },
    },
    expectBody: (body) => {
      expect(body).toEqual({
        jsonrpc: '2.0',
        id: 'tool-call-1',
        result: { echoed: 'hello' },
      })
    },
  },
  expectedResources: [{
    uri: 'memory://overview',
    name: 'Overview',
  }],
  expectedResourceTemplates: [{
    uriTemplate: 'project://{projectId}/report',
    name: 'Report',
  }],
})
