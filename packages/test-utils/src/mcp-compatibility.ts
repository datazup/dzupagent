import { describe, expect, it } from 'vitest'
import type { MCPResource, MCPResourceTemplate, MCPToolDescriptor } from '@dzupagent/core'

export interface McpCompatibilityResponse {
  statusCode: number
  body?: unknown
  headers?: Record<string, string>
}

export interface McpCompatibilityHarness {
  get: (
    path: string,
    options?: { headers?: Record<string, string> },
  ) => Promise<McpCompatibilityResponse>
  post: (
    path: string,
    body: unknown,
    options?: { headers?: Record<string, string> },
  ) => Promise<McpCompatibilityResponse>
}

export interface McpCompatibilityToolCallCase {
  request: {
    name: string
    arguments?: Record<string, unknown>
  }
  expectedStatus?: number
  expectBody?: (body: unknown) => void
}

export type McpCompatibilityCaseName =
  | 'tools'
  | 'initialize'
  | 'null-id'
  | 'notification'
  | 'invalid-request'
  | 'tool-call'
  | 'resources'
  | 'resource-templates'

export interface McpPublisherCompatibilitySuiteOptions {
  suiteName: string
  createHarness: () => Promise<McpCompatibilityHarness> | McpCompatibilityHarness
  basePath?: string
  authHeaders?: Record<string, string>
  prepareCase?: (caseName: McpCompatibilityCaseName) => Promise<void> | void
  expectedTools: Array<Partial<MCPToolDescriptor>>
  expectedInitializeBody?: unknown
  expectedNullIdBody?: unknown
  notificationRequestBody?: unknown
  invalidRequestBody?: unknown
  toolCallCase?: McpCompatibilityToolCallCase
  expectedResources?: Array<Partial<MCPResource>>
  expectedResourceTemplates?: Array<Partial<MCPResourceTemplate>>
}

export function describeMcpPublisherCompatibilitySuite(
  options: McpPublisherCompatibilitySuiteOptions,
): void {
  const basePath = options.basePath ?? '/mcp'
  const authHeaders = options.authHeaders ?? {}

  describe(options.suiteName, () => {
    it('lists MCP tools through the metadata route', async () => {
      await options.prepareCase?.('tools')
      const harness = await options.createHarness()
      const response = await harness.get(`${basePath}/tools`, { headers: authHeaders })

      expect(response.statusCode).toBe(200)
      expect(response.body).toEqual({
        tools: options.expectedTools,
      })
    })

    it('routes initialize requests through the MCP JSON-RPC endpoint', async () => {
      await options.prepareCase?.('initialize')
      const harness = await options.createHarness()
      const response = await harness.post(basePath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      }, { headers: authHeaders })

      expect(response.statusCode).toBe(200)
      expect(response.body).toEqual(options.expectedInitializeBody ?? {
        jsonrpc: '2.0',
        id: 1,
        result: { ok: true },
      })
    })

    it('preserves null request ids in JSON-RPC responses', async () => {
      await options.prepareCase?.('null-id')
      const harness = await options.createHarness()
      const response = await harness.post(basePath, {
        jsonrpc: '2.0',
        id: null,
        method: 'initialize',
      }, { headers: authHeaders })

      expect(response.statusCode).toBe(200)
      expect(response.body).toEqual(options.expectedNullIdBody ?? {
        jsonrpc: '2.0',
        id: null,
        result: { ok: true },
      })
    })

    it('treats id-less requests as notifications', async () => {
      await options.prepareCase?.('notification')
      const harness = await options.createHarness()
      const response = await harness.post(
        basePath,
        options.notificationRequestBody ?? {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'echo', arguments: { value: 'hello' } },
        },
        { headers: authHeaders },
      )

      expect(response.statusCode).toBe(204)
      expect(response.body).toBeUndefined()
    })

    it('rejects malformed JSON-RPC payloads with invalid-request', async () => {
      await options.prepareCase?.('invalid-request')
      const harness = await options.createHarness()
      const response = await harness.post(
        basePath,
        options.invalidRequestBody ?? {
          jsonrpc: '2.0',
          id: true,
          method: 'initialize',
        },
        { headers: authHeaders },
      )

      expect(response.statusCode).toBe(400)
      expect(response.body).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid MCP request',
        },
      })
    })

    if (options.toolCallCase) {
      it('routes tool calls through the MCP JSON-RPC endpoint', async () => {
        await options.prepareCase?.('tool-call')
        const harness = await options.createHarness()
        const response = await harness.post(basePath, {
          jsonrpc: '2.0',
          id: 'tool-call-1',
          method: 'tools/call',
          params: options.toolCallCase?.request,
        }, { headers: authHeaders })

        expect(response.statusCode).toBe(options.toolCallCase?.expectedStatus ?? 200)
        options.toolCallCase?.expectBody?.(response.body)
      })
    }

    if (options.expectedResources) {
      it('lists published MCP resources', async () => {
        await options.prepareCase?.('resources')
        const harness = await options.createHarness()
        const response = await harness.get(`${basePath}/resources`, { headers: authHeaders })

        expect(response.statusCode).toBe(200)
        expect(response.body).toEqual({
          resources: options.expectedResources,
        })
      })
    }

    if (options.expectedResourceTemplates) {
      it('lists published MCP resource templates', async () => {
        await options.prepareCase?.('resource-templates')
        const harness = await options.createHarness()
        const response = await harness.get(`${basePath}/resource-templates`, { headers: authHeaders })

        expect(response.statusCode).toBe(200)
        expect(response.body).toEqual({
          resourceTemplates: options.expectedResourceTemplates,
        })
      })
    }
  })
}
