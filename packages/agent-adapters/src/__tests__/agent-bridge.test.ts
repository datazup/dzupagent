import { describe, it, expect, beforeEach } from 'vitest'

import {
  AdapterAsToolWrapper,
  AgentIntegrationBridge,
} from '../integration/agent-bridge.js'
import { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  result = `Result from ${providerId}`,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: `sess-${providerId}`,
        result,
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 10,
        timestamp: Date.now(),
      }
    },
    async *resumeSession(
      _id: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: 'resumed',
        result,
        durationMs: 5,
        timestamp: Date.now(),
      }
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createFailingAdapter(
  providerId: AdapterProviderId,
  errorMsg = 'Adapter error',
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:failed',
        providerId,
        error: errorMsg,
        code: 'TEST_FAILURE',
        timestamp: Date.now(),
      }
    },
    async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {},
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createRegistry(adapters: AgentCLIAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry()
  for (const adapter of adapters) {
    registry.register(adapter)
  }
  return registry
}

// ---------------------------------------------------------------------------
// Tests: AdapterAsToolWrapper
// ---------------------------------------------------------------------------

describe('AdapterAsToolWrapper', () => {
  let registry: AdapterRegistry
  let sut: AdapterAsToolWrapper

  beforeEach(() => {
    registry = createRegistry([createMockAdapter('claude', 'Tool result')])
    sut = new AdapterAsToolWrapper(registry, {
      providerId: 'claude',
      name: 'my_claude_tool',
      description: 'A test tool',
    })
  })

  it('name and description properties', () => {
    expect(sut.name).toBe('my_claude_tool')
    expect(sut.description).toBe('A test tool')
  })

  it('uses default name when not specified', () => {
    const wrapper = new AdapterAsToolWrapper(registry, { providerId: 'claude' })
    expect(wrapper.name).toBe('adapter_claude')
  })

  it('getSchema() returns MCP-compatible schema', () => {
    const schema = sut.getSchema()

    expect(schema.name).toBe('my_claude_tool')
    expect(schema.description).toBe('A test tool')
    expect(schema.inputSchema.type).toBe('object')
    expect(schema.inputSchema.properties['prompt']).toBeDefined()
    expect(schema.inputSchema.properties['prompt']!.type).toBe('string')
    expect(schema.inputSchema.required).toContain('prompt')
    // Optional fields present
    expect(schema.inputSchema.properties['workingDirectory']).toBeDefined()
    expect(schema.inputSchema.properties['systemPrompt']).toBeDefined()
  })

  it('invoke() executes adapter and returns result', async () => {
    const result = await sut.invoke({ prompt: 'Do something' })

    expect(result.success).toBe(true)
    expect(result.result).toBe('Tool result')
    expect(result.providerId).toBe('claude')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.usage).toBeDefined()
    expect(result.usage!.inputTokens).toBe(100)
    expect(result.usage!.outputTokens).toBe(50)
  })

  it('invoke() handles adapter failure', async () => {
    const failRegistry = createRegistry([createFailingAdapter('claude', 'Something broke')])
    const failWrapper = new AdapterAsToolWrapper(failRegistry, {
      providerId: 'claude',
    })

    const result = await failWrapper.invoke({ prompt: 'Do something' })

    expect(result.success).toBe(false)
    expect(result.error).toBe('Something broke')
    expect(result.result).toBe('')
  })

  it('invoke() returns failure when adapter is not healthy', async () => {
    // Create a registry with no adapters registered for the requested provider
    const emptyRegistry = createRegistry([createMockAdapter('codex')])
    const wrapper = new AdapterAsToolWrapper(emptyRegistry, {
      providerId: 'claude',
    })

    const result = await wrapper.invoke({ prompt: 'Do something' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('not available')
  })
})

// ---------------------------------------------------------------------------
// Tests: AgentIntegrationBridge
// ---------------------------------------------------------------------------

describe('AgentIntegrationBridge', () => {
  let registry: AdapterRegistry
  let bridge: AgentIntegrationBridge

  beforeEach(() => {
    registry = createRegistry([
      createMockAdapter('claude', 'Claude result'),
      createMockAdapter('codex', 'Codex result'),
    ])
    bridge = new AgentIntegrationBridge(registry)
  })

  describe('createTool()', () => {
    it('creates wrapper for specific adapter', () => {
      const tool = bridge.createTool({ providerId: 'claude' })

      expect(tool).toBeInstanceOf(AdapterAsToolWrapper)
      expect(tool.name).toBe('adapter_claude')
    })

    it('throws for unknown provider', () => {
      expect(() => bridge.createTool({ providerId: 'gemini' })).toThrow()
    })

    it('passes config to wrapper', () => {
      const tool = bridge.createTool({
        providerId: 'claude',
        name: 'custom_name',
        description: 'Custom desc',
      })

      expect(tool.name).toBe('custom_name')
      expect(tool.description).toBe('Custom desc')
    })
  })

  describe('createAllTools()', () => {
    it('creates wrappers for all adapters', () => {
      const tools = bridge.createAllTools()

      expect(tools).toHaveLength(2)
      const names = tools.map((t) => t.name)
      expect(names).toContain('adapter_claude')
      expect(names).toContain('adapter_codex')
    })

    it('applies defaults to all wrappers', () => {
      const tools = bridge.createAllTools({
        name: 'agent',
      })

      const names = tools.map((t) => t.name)
      expect(names).toContain('agent_claude')
      expect(names).toContain('agent_codex')
    })
  })

  describe('getMCPDescriptors()', () => {
    it('returns schemas for all adapters', () => {
      const descriptors = bridge.getMCPDescriptors()

      expect(descriptors).toHaveLength(2)
      for (const desc of descriptors) {
        expect(desc.inputSchema.type).toBe('object')
        expect(desc.inputSchema.required).toContain('prompt')
      }
    })
  })

  describe('createRoutedTool()', () => {
    it('creates auto-routing tool', () => {
      const tool = bridge.createRoutedTool({ name: 'agent' })

      expect(tool.name).toBe('agent')
    })

    it('routed tool uses registry strategy to execute', async () => {
      const tool = bridge.createRoutedTool({ name: 'agent' })

      const result = await tool.invoke({ prompt: 'Hello' })

      expect(result.success).toBe(true)
      // Should get a result from one of the adapters
      expect(result.result).toBeTruthy()
    })

    it('routed tool getSchema returns prompt-based schema', () => {
      const tool = bridge.createRoutedTool({ name: 'routed_agent' })
      const schema = tool.getSchema()

      expect(schema.name).toBe('routed_agent')
      expect(schema.inputSchema.required).toContain('prompt')
    })

    it('throws when no adapters are registered', () => {
      const emptyRegistry = new AdapterRegistry()
      const emptyBridge = new AgentIntegrationBridge(emptyRegistry)

      expect(() => emptyBridge.createRoutedTool()).toThrow()
    })
  })
})
