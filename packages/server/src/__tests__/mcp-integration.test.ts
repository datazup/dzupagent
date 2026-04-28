/**
 * MCP integration tests for the tool resolver.
 *
 * Tests the full MCP path through resolveAgentTools():
 *   - Server connection lifecycle
 *   - Tool discovery and filtering
 *   - Tool execution via LangChain bridge
 *   - Multi-server scenarios
 *   - LangChain StructuredToolInterface conversion
 *   - Cleanup callbacks
 *
 * All MCP infrastructure is mocked — no real network calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { MCPToolDescriptor, MCPToolResult } from '@dzupagent/core'
import { resolveAgentTools, type ToolResolverContext } from '../runtime/tool-resolver.js'

// ---------------------------------------------------------------------------
// Mock MCP Server
// ---------------------------------------------------------------------------

interface MockMcpServerOptions {
  id: string
  name?: string
  tools: MCPToolDescriptor[]
  /** If true, connect() will fail */
  failConnect?: boolean
  /** Canned responses keyed by tool name */
  responses?: Record<string, MCPToolResult>
}

/**
 * Lightweight mock MCP server that tracks call history and returns canned
 * responses. Plugged into the mock MCPClient below.
 */
class MockMcpServer {
  readonly id: string
  readonly name: string
  readonly tools: MCPToolDescriptor[]
  readonly failConnect: boolean
  readonly responses: Record<string, MCPToolResult>
  readonly callHistory: Array<{ tool: string; args: Record<string, unknown> }> = []

  constructor(opts: MockMcpServerOptions) {
    this.id = opts.id
    this.name = opts.name ?? opts.id
    this.tools = opts.tools
    this.failConnect = opts.failConnect ?? false
    this.responses = opts.responses ?? {}
  }

  invoke(toolName: string, args: Record<string, unknown>): MCPToolResult {
    this.callHistory.push({ tool: toolName, args })

    if (this.responses[toolName]) {
      return this.responses[toolName]
    }
    return {
      content: [{ type: 'text', text: `Mock response from ${toolName}` }],
    }
  }
}

// ---------------------------------------------------------------------------
// Mock MCPClient
// ---------------------------------------------------------------------------

/**
 * Simulates the MCPClient interface that tool-resolver.ts constructs via
 * dynamic import of @dzupagent/core. The mock:
 *   - addServer() / connect() follow the same contract
 *   - getEagerTools() returns tools from connected servers
 *   - disconnectAll() tracks that cleanup was called
 *   - invokeTool() delegates to MockMcpServer
 */
class MockMCPClient {
  private servers = new Map<string, MockMcpServer>()
  private configs = new Map<string, { id: string; name: string; maxEagerTools?: number }>()
  private connected = new Set<string>()
  disconnectAllCalled = false

  /** Register a mock server backend for a given id */
  registerBackend(server: MockMcpServer): void {
    this.servers.set(server.id, server)
  }

  addServer(config: { id: string; name: string; maxEagerTools?: number }): void {
    this.configs.set(config.id, config)
  }

  async connect(serverId: string): Promise<boolean> {
    const backend = this.servers.get(serverId)
    if (!backend) {
      // No backend registered — simulate connection failure (no server listening)
      return false
    }
    if (backend.failConnect) {
      return false
    }
    this.connected.add(serverId)
    return true
  }

  getEagerTools(): MCPToolDescriptor[] {
    const tools: MCPToolDescriptor[] = []
    for (const id of this.connected) {
      const backend = this.servers.get(id)
      if (!backend) continue

      const config = this.configs.get(id)
      const maxEager = config?.maxEagerTools ?? Infinity
      const eager = backend.tools.slice(0, maxEager)
      tools.push(...eager)
    }
    return tools
  }

  async invokeTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    for (const id of this.connected) {
      const backend = this.servers.get(id)
      if (!backend) continue
      const hasTool = backend.tools.some(t => t.name === toolName)
      if (hasTool) {
        return backend.invoke(toolName, args)
      }
    }
    return {
      content: [{ type: 'text', text: `Tool "${toolName}" not found` }],
      isError: true,
    }
  }

  async disconnectAll(): Promise<void> {
    this.disconnectAllCalled = true
    this.connected.clear()
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDescriptor(
  name: string,
  serverId: string,
  properties: Record<string, { type: string; description?: string }> = {},
  required?: string[],
): MCPToolDescriptor {
  return {
    name,
    description: `MCP tool: ${name}`,
    inputSchema: {
      type: 'object',
      properties: properties as MCPToolDescriptor['inputSchema']['properties'],
      required,
    },
    serverId,
  }
}

function makeContext(
  toolNames: string[],
  mcpServers: Array<{ id: string; name?: string; url: string; transport?: string; timeoutMs?: number; maxEagerTools?: number }>,
  env?: NodeJS.ProcessEnv,
): ToolResolverContext {
  return {
    toolNames,
    metadata: { mcpServers },
    env: env ?? { DZIP_MCP_ALLOWED_HTTP_HOSTS: 'mock:8000' },
  }
}

// ---------------------------------------------------------------------------
// Test setup: mock @dzupagent/core dynamic import
// ---------------------------------------------------------------------------

let mockClient: MockMCPClient

/**
 * mcpToolToLangChain mock — creates a minimal StructuredToolInterface that
 * delegates invoke() to the mock MCPClient. The real bridge does the same
 * thing via @langchain/core/tools `tool()`.
 */
function mockMcpToolToLangChain(
  descriptor: MCPToolDescriptor,
  client: MockMCPClient,
): StructuredToolInterface {
  // We need a real LangChain tool to satisfy StructuredToolInterface.
  // Import synchronously since vitest runs in Node with ESM support.
  const { z } = require('zod')
  const { tool } = require('@langchain/core/tools')

  const shape: Record<string, unknown> = {}
  for (const [key, param] of Object.entries(descriptor.inputSchema.properties)) {
    shape[key] = param.type === 'number' ? z.number().optional() : z.string().optional()
  }

  return tool(
    async (args: Record<string, unknown>) => {
      const result = await client.invokeTool(descriptor.name, args)
      if (result.isError) {
        return `Error: ${result.content.map(c => c.text).join('\n')}`
      }
      return result.content.map(c => c.text ?? '').join('\n')
    },
    {
      name: descriptor.name,
      description: descriptor.description,
      schema: z.object(shape),
    },
  )
}

beforeEach(() => {
  mockClient = new MockMCPClient()

  // Mock the dynamic import of @dzupagent/core that tool-resolver does
  vi.mock('@dzupagent/core', () => {
    return {
      MCPClient: class {
        // Proxy all method calls to the shared mockClient instance
        addServer(...args: unknown[]) {
          return (mockClient.addServer as Function).apply(mockClient, args)
        }
        connect(...args: unknown[]) {
          return (mockClient.connect as Function).apply(mockClient, args)
        }
        getEagerTools() {
          return mockClient.getEagerTools()
        }
        disconnectAll() {
          return mockClient.disconnectAll()
        }
        invokeTool(...args: unknown[]) {
          return (mockClient.invokeTool as Function).apply(mockClient, args)
        }
      },
      validateOutboundUrl: async (url: string, policy?: { allowedHosts?: Iterable<string> }) => {
        const parsed = new URL(url)
        const allowedHosts = new Set(Array.from(policy?.allowedHosts ?? []))
        if (allowedHosts.has(parsed.hostname) || allowedHosts.has(parsed.host)) {
          return { ok: true, url: parsed, resolvedAddresses: [] }
        }
        if (parsed.hostname === '127.0.0.1') {
          return { ok: false, reason: `URL host "${parsed.hostname}" is not a public IP address.` }
        }
        if (parsed.protocol !== 'https:' && parsed.hostname !== 'mock') {
          return { ok: false, reason: 'URL protocol must be https unless trusted HTTP is explicitly allowed.' }
        }
        return { ok: true, url: parsed, resolvedAddresses: [] }
      },
      mcpToolToLangChain: (descriptor: MCPToolDescriptor, client: unknown) => {
        // client is the proxy instance, but we use mockClient directly
        return mockMcpToolToLangChain(descriptor, mockClient)
      },
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ===========================================================================
// Tests
// ===========================================================================

describe('MCP integration with tool-resolver', { timeout: 60_000 }, () => {
  // -----------------------------------------------------------------------
  // Server Connection
  // -----------------------------------------------------------------------
  describe('server connection', () => {
    it('connects to a mock MCP server successfully', async () => {
      const server = new MockMcpServer({
        id: 'test-server',
        tools: [makeDescriptor('echo', 'test-server', { message: { type: 'string' } }, ['message'])],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:test-server'], [{ id: 'test-server', url: 'http://mock:8000' }]),
      )

      expect(result.tools).toHaveLength(1)
      expect(result.tools[0].name).toBe('echo')
      expect(result.warnings.every(w => !w.includes('failed to connect'))).toBe(true)
    })

    it('handles connection failure gracefully', async () => {
      const server = new MockMcpServer({
        id: 'bad-server',
        tools: [],
        failConnect: true,
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:bad-server'], [{ id: 'bad-server', url: 'http://mock:8000' }]),
      )

      expect(result.tools).toHaveLength(0)
      expect(result.warnings.some(w => w.includes('failed to connect'))).toBe(true)
    })

    it('handles server timeout (no backend registered)', async () => {
      // No backend registered means connect() returns false
      const result = await resolveAgentTools(
        makeContext(['mcp:ghost'], [{ id: 'ghost', url: 'http://mock:8000', timeoutMs: 100 }]),
      )

      expect(result.tools).toHaveLength(0)
      expect(result.warnings.some(w => w.includes('failed to connect'))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Tool Discovery
  // -----------------------------------------------------------------------
  describe('tool discovery', () => {
    it('discovers all tools from a connected MCP server', async () => {
      const server = new MockMcpServer({
        id: 'srv',
        tools: [
          makeDescriptor('tool_a', 'srv'),
          makeDescriptor('tool_b', 'srv'),
          makeDescriptor('tool_c', 'srv'),
        ],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:srv'], [{ id: 'srv', url: 'http://mock:8000' }]),
      )

      expect(result.tools).toHaveLength(3)
      const names = result.tools.map(t => t.name).sort()
      expect(names).toEqual(['tool_a', 'tool_b', 'tool_c'])
    })

    it('filters tools by server name pattern (mcp:server-name)', async () => {
      const alpha = new MockMcpServer({
        id: 'alpha',
        tools: [makeDescriptor('alpha_tool', 'alpha')],
      })
      const beta = new MockMcpServer({
        id: 'beta',
        tools: [makeDescriptor('beta_tool', 'beta')],
      })
      mockClient.registerBackend(alpha)
      mockClient.registerBackend(beta)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:alpha'],
          [
            { id: 'alpha', url: 'http://mock:8001' },
            { id: 'beta', url: 'http://mock:8002' },
          ],
        ),
      )

      // Only alpha's tools should be discovered; beta should not even connect
      expect(result.tools).toHaveLength(1)
      expect(result.tools[0].name).toBe('alpha_tool')
    })

    it('filters tools by specific tool name (mcp:server-name:tool-name)', async () => {
      const server = new MockMcpServer({
        id: 'srv',
        tools: [
          makeDescriptor('wanted', 'srv'),
          makeDescriptor('not_wanted', 'srv'),
        ],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:srv:wanted'],
          [{ id: 'srv', url: 'http://mock:8000' }],
        ),
      )

      expect(result.tools).toHaveLength(1)
      expect(result.tools[0].name).toBe('wanted')
    })

    it('handles server with no tools', async () => {
      const server = new MockMcpServer({ id: 'empty', tools: [] })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:empty'], [{ id: 'empty', url: 'http://mock:8000' }]),
      )

      expect(result.tools).toHaveLength(0)
      expect(result.activated.filter(a => a.source === 'mcp')).toHaveLength(0)
    })

    it('handles deferred tool loading for large tool sets', async () => {
      // Create a server with many tools but limit eager loading to 2
      const tools = Array.from({ length: 10 }, (_, i) =>
        makeDescriptor(`tool_${i}`, 'big-srv'),
      )
      const server = new MockMcpServer({ id: 'big-srv', tools })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:big-srv'],
          [{ id: 'big-srv', url: 'http://mock:8000', maxEagerTools: 2 }],
        ),
      )

      // MockMCPClient.getEagerTools respects maxEagerTools
      expect(result.tools).toHaveLength(2)
      expect(result.tools[0].name).toBe('tool_0')
      expect(result.tools[1].name).toBe('tool_1')
    })
  })

  // -----------------------------------------------------------------------
  // Tool Execution
  // -----------------------------------------------------------------------
  describe('tool execution', () => {
    it('executes an MCP tool through the resolver pipeline', async () => {
      const server = new MockMcpServer({
        id: 'exec-srv',
        tools: [
          makeDescriptor('greet', 'exec-srv', { name: { type: 'string' } }, ['name']),
        ],
        responses: {
          greet: {
            content: [{ type: 'text', text: 'Hello, World!' }],
          },
        },
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:exec-srv'], [{ id: 'exec-srv', url: 'http://mock:8000' }]),
      )

      expect(result.tools).toHaveLength(1)
      const greetTool = result.tools[0]

      // Actually invoke the tool — it should route to MockMcpServer
      const output = await greetTool.invoke({ name: 'World' })
      expect(output).toBe('Hello, World!')
    })

    it('passes correct arguments to MCP tool', async () => {
      const server = new MockMcpServer({
        id: 'arg-srv',
        tools: [
          makeDescriptor('calc', 'arg-srv', {
            a: { type: 'number' },
            b: { type: 'number' },
          }),
        ],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:arg-srv'], [{ id: 'arg-srv', url: 'http://mock:8000' }]),
      )

      const calcTool = result.tools[0]
      await calcTool.invoke({ a: 10, b: 20 })

      expect(server.callHistory).toHaveLength(1)
      expect(server.callHistory[0].tool).toBe('calc')
      expect(server.callHistory[0].args).toEqual({ a: 10, b: 20 })
    })

    it('handles tool execution errors', async () => {
      const server = new MockMcpServer({
        id: 'err-srv',
        tools: [makeDescriptor('fail_tool', 'err-srv')],
        responses: {
          fail_tool: {
            content: [{ type: 'text', text: 'Something went wrong' }],
            isError: true,
          },
        },
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:err-srv'], [{ id: 'err-srv', url: 'http://mock:8000' }]),
      )

      const failTool = result.tools[0]
      const output = await failTool.invoke({})
      expect(output).toContain('Error')
      expect(output).toContain('Something went wrong')
    })
  })

  // -----------------------------------------------------------------------
  // Multi-Server
  // -----------------------------------------------------------------------
  describe('multi-server', () => {
    it('discovers tools from multiple servers', async () => {
      const srv1 = new MockMcpServer({
        id: 'srv1',
        tools: [makeDescriptor('tool_from_1', 'srv1')],
      })
      const srv2 = new MockMcpServer({
        id: 'srv2',
        tools: [makeDescriptor('tool_from_2', 'srv2')],
      })
      mockClient.registerBackend(srv1)
      mockClient.registerBackend(srv2)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:*'],
          [
            { id: 'srv1', url: 'http://mock:8001' },
            { id: 'srv2', url: 'http://mock:8002' },
          ],
        ),
      )

      expect(result.tools).toHaveLength(2)
      const names = result.tools.map(t => t.name).sort()
      expect(names).toEqual(['tool_from_1', 'tool_from_2'])
    })

    it('handles partial server failures (one fails, others work)', async () => {
      const good = new MockMcpServer({
        id: 'good',
        tools: [makeDescriptor('good_tool', 'good')],
      })
      const bad = new MockMcpServer({
        id: 'bad',
        tools: [],
        failConnect: true,
      })
      mockClient.registerBackend(good)
      mockClient.registerBackend(bad)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:*'],
          [
            { id: 'good', url: 'http://mock:8001' },
            { id: 'bad', url: 'http://mock:8002' },
          ],
        ),
      )

      // Should still get tools from the good server
      expect(result.tools).toHaveLength(1)
      expect(result.tools[0].name).toBe('good_tool')
      // Should warn about the bad server
      expect(result.warnings.some(w => w.includes('bad') && w.includes('failed to connect'))).toBe(true)
    })

    it('resolves tools with mcp:* pattern (all servers)', async () => {
      const a = new MockMcpServer({
        id: 'a',
        tools: [makeDescriptor('a1', 'a'), makeDescriptor('a2', 'a')],
      })
      const b = new MockMcpServer({
        id: 'b',
        tools: [makeDescriptor('b1', 'b')],
      })
      mockClient.registerBackend(a)
      mockClient.registerBackend(b)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:*'],
          [
            { id: 'a', url: 'http://mock:8001' },
            { id: 'b', url: 'http://mock:8002' },
          ],
        ),
      )

      expect(result.tools).toHaveLength(3)
      const names = result.tools.map(t => t.name).sort()
      expect(names).toEqual(['a1', 'a2', 'b1'])
    })

    it('warns when all MCP servers fail to connect', async () => {
      const bad1 = new MockMcpServer({ id: 'bad1', tools: [], failConnect: true })
      const bad2 = new MockMcpServer({ id: 'bad2', tools: [], failConnect: true })
      mockClient.registerBackend(bad1)
      mockClient.registerBackend(bad2)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:*'],
          [
            { id: 'bad1', url: 'http://mock:8001' },
            { id: 'bad2', url: 'http://mock:8002' },
          ],
        ),
      )

      expect(result.tools).toHaveLength(0)
      expect(result.warnings.some(w => w.includes('All MCP servers failed to connect'))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // LangChain Conversion
  // -----------------------------------------------------------------------
  describe('LangChain conversion', () => {
    it('MCP tool converts to valid StructuredToolInterface', async () => {
      const server = new MockMcpServer({
        id: 'lc-srv',
        tools: [
          makeDescriptor('my_tool', 'lc-srv', { query: { type: 'string' } }, ['query']),
        ],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:lc-srv'], [{ id: 'lc-srv', url: 'http://mock:8000' }]),
      )

      const lcTool = result.tools[0]
      // StructuredToolInterface shape checks
      expect(lcTool.name).toBe('my_tool')
      expect(typeof lcTool.description).toBe('string')
      expect(typeof lcTool.invoke).toBe('function')
      expect(lcTool.schema).toBeDefined()
    })

    it('tool description is preserved through conversion', async () => {
      const desc: MCPToolDescriptor = {
        name: 'described_tool',
        description: 'A tool that does something very specific and important',
        inputSchema: { type: 'object', properties: {} },
        serverId: 'desc-srv',
      }
      const server = new MockMcpServer({ id: 'desc-srv', tools: [desc] })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:desc-srv'], [{ id: 'desc-srv', url: 'http://mock:8000' }]),
      )

      expect(result.tools[0].description).toBe('A tool that does something very specific and important')
    })

    it('schema properties are correctly mapped', async () => {
      const server = new MockMcpServer({
        id: 'schema-srv',
        tools: [
          makeDescriptor('typed_tool', 'schema-srv', {
            text: { type: 'string', description: 'The text input' },
            count: { type: 'number', description: 'How many times' },
          }, ['text']),
        ],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:schema-srv'], [{ id: 'schema-srv', url: 'http://mock:8000' }]),
      )

      const lcTool = result.tools[0]
      // The schema should be a Zod object schema
      expect(lcTool.schema).toBeDefined()
      // Tool should be invocable with matching args
      const output = await lcTool.invoke({ text: 'hello', count: 3 })
      expect(typeof output).toBe('string')
    })
  })

  // -----------------------------------------------------------------------
  // Integration with resolveAgentTools
  // -----------------------------------------------------------------------
  describe('integration with resolveAgentTools', () => {
    it('MCP tools appear in activated array with source mcp', async () => {
      const server = new MockMcpServer({
        id: 'act-srv',
        tools: [
          makeDescriptor('mcp_tool_1', 'act-srv'),
          makeDescriptor('mcp_tool_2', 'act-srv'),
        ],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:act-srv'], [{ id: 'act-srv', url: 'http://mock:8000' }]),
      )

      const mcpActivated = result.activated.filter(a => a.source === 'mcp')
      expect(mcpActivated).toHaveLength(2)
      expect(mcpActivated.map(a => a.name).sort()).toEqual(['mcp_tool_1', 'mcp_tool_2'])
    })

    it('mcp: pattern tokens are removed from unresolved', async () => {
      const server = new MockMcpServer({
        id: 'res-srv',
        tools: [makeDescriptor('res_tool', 'res-srv')],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:res-srv', 'mcp:res-srv:res_tool'],
          [{ id: 'res-srv', url: 'http://mock:8000' }],
        ),
      )

      expect(result.unresolved).not.toContain('mcp:res-srv')
      expect(result.unresolved).not.toContain('mcp:res-srv:res_tool')
    })

    it('cleanup callback calls disconnectAll', async () => {
      const server = new MockMcpServer({
        id: 'clean-srv',
        tools: [makeDescriptor('clean_tool', 'clean-srv')],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:clean-srv'], [{ id: 'clean-srv', url: 'http://mock:8000' }]),
      )

      expect(result.cleanup).toBeDefined()
      expect(mockClient.disconnectAllCalled).toBe(false)

      await result.cleanup!()
      expect(mockClient.disconnectAllCalled).toBe(true)
    })

    it('cleanup is returned even when all servers fail', async () => {
      const server = new MockMcpServer({
        id: 'fail-srv',
        tools: [],
        failConnect: true,
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:fail-srv'], [{ id: 'fail-srv', url: 'http://mock:8000' }]),
      )

      expect(typeof result.cleanup).toBe('function')
      await expect(result.cleanup!()).resolves.toBeUndefined()
    })

    it('MCP tools coexist with custom resolver tools', async () => {
      const server = new MockMcpServer({
        id: 'coexist',
        tools: [makeDescriptor('mcp_echo', 'coexist')],
      })
      mockClient.registerBackend(server)

      const { tool } = await import('@langchain/core/tools')
      const { z } = await import('zod')

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:coexist', 'custom_tool'],
          [{ id: 'coexist', url: 'http://mock:8000' }],
        ),
        async () => [
          tool(async () => 'custom response', {
            name: 'custom_tool',
            description: 'A custom tool',
            schema: z.object({}),
          }),
        ],
      )

      expect(result.tools).toHaveLength(2)
      const names = result.tools.map(t => t.name).sort()
      expect(names).toEqual(['custom_tool', 'mcp_echo'])

      const mcpActivated = result.activated.find(a => a.name === 'mcp_echo')
      expect(mcpActivated?.source).toBe('mcp')
      const customActivated = result.activated.find(a => a.name === 'custom_tool')
      expect(customActivated?.source).toBe('custom')
    })

    it('custom resolver can override an MCP tool', async () => {
      const server = new MockMcpServer({
        id: 'override',
        tools: [makeDescriptor('shared_name', 'override')],
      })
      mockClient.registerBackend(server)

      const { tool } = await import('@langchain/core/tools')
      const { z } = await import('zod')

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:override'],
          [{ id: 'override', url: 'http://mock:8000' }],
        ),
        async () => [
          tool(async () => 'custom version', {
            name: 'shared_name',
            description: 'Custom override of MCP tool',
            schema: z.object({}),
          }),
        ],
      )

      // Only one tool with that name
      const matching = result.tools.filter(t => t.name === 'shared_name')
      expect(matching).toHaveLength(1)
      expect(matching[0].description).toBe('Custom override of MCP tool')

      const activated = result.activated.find(a => a.name === 'shared_name')
      expect(activated?.source).toBe('custom')
    })

    it('no MCP resolution when toolNames has no mcp: patterns', async () => {
      const server = new MockMcpServer({
        id: 'ignored',
        tools: [makeDescriptor('should_not_appear', 'ignored')],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools({
        toolNames: ['nonexistent_tool'],
        metadata: {
          mcpServers: [{ id: 'ignored', url: 'http://mock:8000' }],
        },
      })

      // No MCP tools should appear
      const mcpActivated = result.activated.filter(a => a.source === 'mcp')
      expect(mcpActivated).toHaveLength(0)
      // No MCP warnings
      expect(result.warnings.some(w => w.includes('MCP'))).toBe(false)
    })

    it('warns when mcp: requested but no mcpServers in metadata', async () => {
      const result = await resolveAgentTools({
        toolNames: ['mcp:some-server'],
        metadata: {},
      })

      expect(result.warnings.some(w => w.includes('no servers configured'))).toBe(true)
      expect(result.tools).toHaveLength(0)
    })

    it('rejects private metadata MCP HTTP URLs before connecting', async () => {
      const server = new MockMcpServer({
        id: 'private',
        tools: [makeDescriptor('private_tool', 'private')],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(['mcp:private'], [{ id: 'private', url: 'https://127.0.0.1:9999/mcp' }]),
      )

      expect(result.tools).toHaveLength(0)
      expect(result.warnings.some(w => w.includes('not a public IP address'))).toBe(true)
    })

    it('allows private metadata MCP HTTP URLs when explicitly allowlisted', async () => {
      const server = new MockMcpServer({
        id: 'allowed-private',
        tools: [makeDescriptor('allowed_private_tool', 'allowed-private')],
      })
      mockClient.registerBackend(server)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:allowed-private'],
          [{ id: 'allowed-private', url: 'http://localhost:9999/mcp' }],
          { DZIP_MCP_ALLOWED_HTTP_HOSTS: 'localhost' },
        ),
      )

      expect(result.tools).toHaveLength(1)
      expect(result.tools[0].name).toBe('allowed_private_tool')
    })

    it('bare mcp token resolves all servers', async () => {
      const srv = new MockMcpServer({
        id: 'bare',
        tools: [makeDescriptor('bare_tool', 'bare')],
      })
      mockClient.registerBackend(srv)

      const result = await resolveAgentTools(
        makeContext(['mcp'], [{ id: 'bare', url: 'http://mock:8000' }]),
      )

      expect(result.tools).toHaveLength(1)
      expect(result.tools[0].name).toBe('bare_tool')
      expect(result.unresolved).not.toContain('mcp')
    })
  })

  // -----------------------------------------------------------------------
  // parseMcpCategory edge cases (via resolveAgentTools)
  // -----------------------------------------------------------------------
  describe('MCP pattern parsing', () => {
    it('mcp:server filters to only that server', async () => {
      const target = new MockMcpServer({
        id: 'target',
        tools: [makeDescriptor('t1', 'target')],
      })
      const other = new MockMcpServer({
        id: 'other',
        tools: [makeDescriptor('o1', 'other')],
      })
      mockClient.registerBackend(target)
      mockClient.registerBackend(other)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:target'],
          [
            { id: 'target', url: 'http://mock:8001' },
            { id: 'other', url: 'http://mock:8002' },
          ],
        ),
      )

      // Only target's tools
      expect(result.tools).toHaveLength(1)
      expect(result.tools[0].name).toBe('t1')
    })

    it('mcp:server:tool filters to exactly one tool on one server', async () => {
      const srv = new MockMcpServer({
        id: 'multi',
        tools: [
          makeDescriptor('keep', 'multi'),
          makeDescriptor('skip', 'multi'),
        ],
      })
      mockClient.registerBackend(srv)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:multi:keep'],
          [{ id: 'multi', url: 'http://mock:8000' }],
        ),
      )

      expect(result.tools).toHaveLength(1)
      expect(result.tools[0].name).toBe('keep')
    })

    it('multiple mcp patterns combine results', async () => {
      const srv = new MockMcpServer({
        id: 'combo',
        tools: [
          makeDescriptor('tool_a', 'combo'),
          makeDescriptor('tool_b', 'combo'),
          makeDescriptor('tool_c', 'combo'),
        ],
      })
      mockClient.registerBackend(srv)

      const result = await resolveAgentTools(
        makeContext(
          ['mcp:combo:tool_a', 'mcp:combo:tool_c'],
          [{ id: 'combo', url: 'http://mock:8000' }],
        ),
      )

      expect(result.tools).toHaveLength(2)
      const names = result.tools.map(t => t.name).sort()
      expect(names).toEqual(['tool_a', 'tool_c'])
    })
  })
})
