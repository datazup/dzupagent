import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { MCPToolSharingBridge } from '../mcp/mcp-tool-sharing.js'
import type { SharedTool } from '../mcp/mcp-tool-sharing.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSharedTool(
  name: string,
  sourceProvider?: 'claude' | 'codex' | 'gemini' | 'qwen' | 'crush',
): SharedTool {
  return {
    name,
    description: `Description for ${name}`,
    inputSchema: {
      type: 'object',
      properties: { input: { type: 'string' } },
    },
    sourceProvider,
    handler: async (args: Record<string, unknown>) =>
      `Result from ${name}: ${JSON.stringify(args)}`,
  }
}

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPToolSharingBridge', () => {
  let bridge: MCPToolSharingBridge
  let bus: DzupEventBus
  let emitted: DzupEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
    bridge = new MCPToolSharingBridge({ eventBus: bus })
  })

  describe('registerTool', () => {
    it('registers a tool that appears in listTools', () => {
      const tool = createSharedTool('my-tool', 'claude')

      bridge.registerTool(tool)

      expect(bridge.listTools()).toEqual(['my-tool'])
    })
  })

  describe('registerTools', () => {
    it('registers multiple tools at once', () => {
      const tools = [
        createSharedTool('tool-a', 'claude'),
        createSharedTool('tool-b', 'codex'),
      ]

      bridge.registerTools(tools)

      expect(bridge.listTools()).toEqual(['tool-a', 'tool-b'])
    })
  })

  describe('unregisterTool', () => {
    it('removes a registered tool and returns true', () => {
      bridge.registerTool(createSharedTool('tool-a'))

      const result = bridge.unregisterTool('tool-a')

      expect(result).toBe(true)
      expect(bridge.listTools()).toEqual([])
    })

    it('returns false for unknown tool', () => {
      const result = bridge.unregisterTool('non-existent')

      expect(result).toBe(false)
    })
  })

  describe('getServerConfig', () => {
    it('returns server name and tool descriptors', () => {
      bridge.registerTool(createSharedTool('tool-a', 'claude'))

      const config = bridge.getServerConfig()

      expect(config.name).toBe('dzupagent-tools')
      expect(config.tools).toHaveLength(1)
      expect(config.tools[0]!.name).toBe('tool-a')
    })

    it('uses custom server name', () => {
      const customBridge = new MCPToolSharingBridge({
        serverName: 'custom-server',
      })

      const config = customBridge.getServerConfig()

      expect(config.name).toBe('custom-server')
    })
  })

  describe('buildAdapterToolConfig', () => {
    beforeEach(() => {
      bridge.registerTool(createSharedTool('tool-a', 'claude'))
      bridge.registerTool(createSharedTool('tool-b', 'codex'))
    })

    it('returns mcpServers shape for claude', () => {
      const config = bridge.buildAdapterToolConfig('claude')

      expect('mcpServers' in config).toBe(true)
      const claudeConfig = config as { mcpServers: Record<string, unknown> }
      const server = claudeConfig.mcpServers['dzupagent-tools'] as {
        type: string
        tools: Array<{ name: string }>
        handler: (req: unknown) => Promise<unknown>
      }
      expect(server.type).toBe('in-process')
      expect(server.tools).toHaveLength(2)
      expect(server.tools[0]!.name).toBe('tool-a')
      expect(typeof server.handler).toBe('function')
    })

    it('returns dynamicTools shape for codex', () => {
      const config = bridge.buildAdapterToolConfig('codex')

      expect('dynamicTools' in config).toBe(true)
      const codexConfig = config as {
        dynamicTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
      }
      expect(codexConfig.dynamicTools).toHaveLength(2)
      expect(codexConfig.dynamicTools[0]!.name).toBe('tool-a')
      expect(codexConfig.dynamicTools[1]!.name).toBe('tool-b')
    })

    it('returns systemPromptTools string for gemini', () => {
      const config = bridge.buildAdapterToolConfig('gemini')

      expect('systemPromptTools' in config).toBe(true)
      const cliConfig = config as { systemPromptTools: string }
      expect(cliConfig.systemPromptTools).toContain('Tool: tool-a')
      expect(cliConfig.systemPromptTools).toContain('Tool: tool-b')
      expect(cliConfig.systemPromptTools).toContain('Description: Description for tool-a')
    })

    it('returns systemPromptTools for qwen and crush too', () => {
      const qwenConfig = bridge.buildAdapterToolConfig('qwen')
      const crushConfig = bridge.buildAdapterToolConfig('crush')

      expect('systemPromptTools' in qwenConfig).toBe(true)
      expect('systemPromptTools' in crushConfig).toBe(true)
    })
  })

  describe('handleRequest', () => {
    it('delegates tools/list to internal MCP server', async () => {
      bridge.registerTool(createSharedTool('my-tool', 'claude'))

      const response = (await bridge.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
      })) as { jsonrpc: string; id: string; result?: { tools: Array<{ name: string }> } }

      expect(response.jsonrpc).toBe('2.0')
      expect(response.id).toBe('1')
      expect(response.result?.tools).toHaveLength(1)
      expect(response.result?.tools[0]!.name).toBe('my-tool')
    })

    it('delegates tools/call to internal MCP server', async () => {
      bridge.registerTool(createSharedTool('my-tool', 'claude'))

      const response = (await bridge.handleRequest({
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/call',
        params: { name: 'my-tool', arguments: { input: 'test' } },
      })) as { result?: { content: Array<{ text: string }> } }

      expect(response.result?.content[0]!.text).toContain('Result from my-tool')
    })
  })

  describe('getStats', () => {
    it('returns correct breakdown by source provider', () => {
      bridge.registerTool(createSharedTool('tool-a', 'claude'))
      bridge.registerTool(createSharedTool('tool-b', 'claude'))
      bridge.registerTool(createSharedTool('tool-c', 'codex'))
      bridge.registerTool(createSharedTool('tool-d'))

      const stats = bridge.getStats()

      expect(stats.totalTools).toBe(4)
      expect(stats.toolsBySource['claude']).toBe(2)
      expect(stats.toolsBySource['codex']).toBe(1)
      expect(stats.toolsBySource['unknown']).toBe(1)
      expect(stats.toolNames).toEqual(['tool-a', 'tool-b', 'tool-c', 'tool-d'])
    })

    it('returns empty stats when no tools registered', () => {
      const stats = bridge.getStats()

      expect(stats.totalTools).toBe(0)
      expect(stats.toolsBySource).toEqual({})
      expect(stats.toolNames).toEqual([])
    })
  })

  describe('listTools', () => {
    it('returns names of all registered tools', () => {
      bridge.registerTools([
        createSharedTool('alpha'),
        createSharedTool('beta'),
        createSharedTool('gamma'),
      ])

      expect(bridge.listTools()).toEqual(['alpha', 'beta', 'gamma'])
    })
  })

  describe('clear', () => {
    it('removes all registered tools', () => {
      bridge.registerTools([
        createSharedTool('tool-a'),
        createSharedTool('tool-b'),
      ])

      bridge.clear()

      expect(bridge.listTools()).toEqual([])
      expect(bridge.getStats().totalTools).toBe(0)
    })
  })

  describe('event emission', () => {
    it('emits mcp:connected events on registerTool', () => {
      bridge.registerTool(createSharedTool('my-tool', 'claude'))

      const mcpEvents = emitted.filter(
        (e) => e.type === ('mcp:connected' as string),
      )
      expect(mcpEvents).toHaveLength(1)

      const event = mcpEvents[0] as DzupEvent & {
        serverName?: string
        toolCount?: number
      }
      expect(event['serverName']).toBeDefined()
      expect(event['toolCount']).toBeGreaterThanOrEqual(1)
    })

    it('emits one event per tool when registerTools is called', () => {
      bridge.registerTools([
        createSharedTool('tool-a', 'claude'),
        createSharedTool('tool-b', 'codex'),
      ])

      const mcpEvents = emitted.filter(
        (e) => e.type === ('mcp:connected' as string),
      )
      expect(mcpEvents).toHaveLength(2)
    })

    it('does not throw when no event bus is configured', () => {
      const bridgeNoEvents = new MCPToolSharingBridge()

      expect(() =>
        bridgeNoEvents.registerTool(createSharedTool('tool-a')),
      ).not.toThrow()
    })
  })
})
