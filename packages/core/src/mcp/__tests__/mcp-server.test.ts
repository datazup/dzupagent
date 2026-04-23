import { describe, expect, it, vi } from 'vitest'
import { DzupAgentMCPServer, isMCPRequest } from '../mcp-server.js'

describe('DzupAgentMCPServer', () => {
  it('advertises initialize capabilities for tools, resources, and sampling', async () => {
    const server = new DzupAgentMCPServer({
      name: 'tooling-server',
      version: '1.2.3',
      tools: [{
        name: 'echo',
        description: 'Echo input',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        handler: async (args) => String(args['text'] ?? ''),
      }],
      resources: [{
        uri: 'memory://overview',
        name: 'Overview',
        mimeType: 'text/plain',
        read: async () => 'Framework overview',
      }],
      samplingHandler: async () => ({
        role: 'assistant',
        content: { type: 'text', text: 'sampled' },
        model: 'gpt-test',
      }),
    })

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'tooling-server',
          version: '1.2.3',
        },
        capabilities: {
          tools: {},
          resources: {},
          sampling: {},
        },
      },
    })
  })

  it('supports resources/list, resources/templates/list, and resources/read', async () => {
    const server = new DzupAgentMCPServer({
      name: 'resources-server',
      version: '1.0.0',
      resources: [{
        uri: 'memory://overview',
        name: 'Overview',
        mimeType: 'text/plain',
        read: async () => ({ uri: 'memory://overview', text: 'overview text' }),
      }],
      resourceTemplates: [{
        uriTemplate: 'project://{projectId}/report',
        name: 'Project report',
        mimeType: 'application/json',
        read: async (uri) => ({
          uri,
          mimeType: 'application/json',
          text: '{"ok":true}',
        }),
      }],
    })

    const listed = await server.handleRequest({
      jsonrpc: '2.0',
      id: 'resources',
      method: 'resources/list',
    })
    expect(listed).toEqual({
      jsonrpc: '2.0',
      id: 'resources',
      result: {
        resources: [{
          uri: 'memory://overview',
          name: 'Overview',
          mimeType: 'text/plain',
        }],
      },
    })

    const templates = await server.handleRequest({
      jsonrpc: '2.0',
      id: 'templates',
      method: 'resources/templates/list',
    })
    expect(templates).toEqual({
      jsonrpc: '2.0',
      id: 'templates',
      result: {
        resourceTemplates: [{
          uriTemplate: 'project://{projectId}/report',
          name: 'Project report',
          mimeType: 'application/json',
        }],
      },
    })

    const readDirect = await server.handleRequest({
      jsonrpc: '2.0',
      id: 'read-direct',
      method: 'resources/read',
      params: { uri: 'memory://overview' },
    })
    expect(readDirect).toEqual({
      jsonrpc: '2.0',
      id: 'read-direct',
      result: {
        contents: [{
          uri: 'memory://overview',
          text: 'overview text',
        }],
      },
    })

    const readFromTemplate = await server.handleRequest({
      jsonrpc: '2.0',
      id: 'read-template',
      method: 'resources/read',
      params: { uri: 'project://abc/report' },
    })
    expect(readFromTemplate).toEqual({
      jsonrpc: '2.0',
      id: 'read-template',
      result: {
        contents: [{
          uri: 'project://abc/report',
          mimeType: 'application/json',
          text: '{"ok":true}',
        }],
      },
    })
  })

  it('delegates sampling/createMessage when a sampling handler is configured', async () => {
    const samplingHandler = vi.fn(async () => ({
      role: 'assistant' as const,
      content: { type: 'text' as const, text: 'sample reply' },
      model: 'gpt-test',
      stopReason: 'endTurn' as const,
    }))

    const server = new DzupAgentMCPServer({
      name: 'sampling-server',
      version: '1.0.0',
      samplingHandler,
    })

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'sampling/createMessage',
      params: {
        messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
        maxTokens: 64,
      },
    })

    expect(samplingHandler).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
      maxTokens: 64,
    })
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: {
        role: 'assistant',
        content: { type: 'text', text: 'sample reply' },
        model: 'gpt-test',
        stopReason: 'endTurn',
      },
    })
  })

  it('returns null for notifications that omit an id while still executing the handler', async () => {
    const handler = vi.fn(async () => 'ok')
    const server = new DzupAgentMCPServer({
      name: 'notify-server',
      version: '1.0.0',
      tools: [{
        name: 'echo',
        description: 'Echo input',
        inputSchema: { type: 'object', properties: {} },
        handler,
      }],
    })

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    })

    expect(response).toBeNull()
    expect(handler).toHaveBeenCalledWith({ text: 'hi' })
  })

  it('supports structured tool results and id:null requests', async () => {
    const server = new DzupAgentMCPServer({
      name: 'structured-server',
      version: '1.0.0',
      tools: [{
        name: 'inspect',
        description: 'Return structured content',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({
          content: [{ type: 'resource', data: 'memory://overview', mimeType: 'text/uri-list' }],
        }),
      }],
    })

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: null,
      method: 'tools/call',
      params: { name: 'inspect', arguments: {} },
    })

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: null,
      result: {
        content: [{ type: 'resource', data: 'memory://overview', mimeType: 'text/uri-list' }],
        isError: false,
      },
    })
  })

  it('returns protocol errors for invalid requests and missing resource params', async () => {
    const server = new DzupAgentMCPServer({
      name: 'errors-server',
      version: '1.0.0',
    })

    expect(isMCPRequest({ jsonrpc: '2.0', method: 'tools/list' })).toBe(true)
    expect(isMCPRequest({ jsonrpc: '1.0', method: 'tools/list' })).toBe(false)
    expect(isMCPRequest({ jsonrpc: '2.0', id: true, method: 'tools/list' })).toBe(false)
    expect(isMCPRequest({ jsonrpc: '2.0', method: 'tools/list', params: 'bad' })).toBe(false)

    const invalidRequest = await server.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: '' as string,
    })
    expect(invalidRequest).toEqual({
      jsonrpc: '2.0',
      id: 10,
      error: {
        code: -32601,
        message: 'Unknown method: ',
        data: undefined,
      },
    })

    const missingUri = await server.handleRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'resources/read',
      params: {},
    })
    expect(missingUri).toEqual({
      jsonrpc: '2.0',
      id: 11,
      error: {
        code: -32602,
        message: 'Missing required param: uri',
        data: undefined,
      },
    })
  })
})
