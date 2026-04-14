import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  createHTTPConnector,
  normalizeConnectorTool,
  normalizeConnectorTools,
  isConnectorTool,
} from '../index.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('connector contract normalization', () => {
  it('normalizes a forge-style tool descriptor into the canonical contract', async () => {
    const tool = normalizeConnectorTool({
      name: 'example-tool',
      description: 'Example tool',
      schema: { type: 'object' },
      invoke: async (input: { value: string }) => `value:${input.value}`,
      toModelOutput: (output: string) => output.toUpperCase(),
    })

    expect(tool).toMatchObject({
      id: 'example-tool',
      name: 'example-tool',
      description: 'Example tool',
      schema: { type: 'object' },
    })
    expect(isConnectorTool(tool)).toBe(true)
    await expect(tool.invoke({ value: 'alpha' })).resolves.toBe('value:alpha')
    expect(tool.toModelOutput?.('ok')).toBe('OK')
  })

  it('normalizes real DynamicStructuredTool outputs from a connector factory', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true }),
      text: async () => JSON.stringify({ ok: true }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const tools = createHTTPConnector({
      baseUrl: 'https://api.example.com',
      headers: { Authorization: 'Bearer token' },
      allowedMethods: ['GET'],
    })

    const normalized = normalizeConnectorTools(tools)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      id: 'http_request',
      name: 'http_request',
    })
    expect(isConnectorTool(normalized[0])).toBe(true)

    const output = await normalized[0]!.invoke({
      method: 'GET',
      path: '/health',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(output)).toContain('200 OK')
  })
})
