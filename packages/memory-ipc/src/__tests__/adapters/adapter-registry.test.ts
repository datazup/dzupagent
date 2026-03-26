import { describe, it, expect } from 'vitest'
import {
  createAdapterRegistry,
  createDefaultRegistry,
  LangGraphAdapter,
  MastraAdapter,
  Mem0Adapter,
  LettaAdapter,
  MCPKGAdapter,
} from '../../adapters/index.js'

describe('createAdapterRegistry', () => {
  it('starts empty', () => {
    const registry = createAdapterRegistry()
    expect(registry.list()).toEqual([])
  })

  it('registers and retrieves an adapter', () => {
    const registry = createAdapterRegistry()
    const adapter = new LangGraphAdapter()
    registry.register(adapter)

    expect(registry.get('langgraph')).toBe(adapter)
    expect(registry.list()).toEqual(['langgraph'])
  })

  it('returns undefined for unknown adapter', () => {
    const registry = createAdapterRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('overwrites adapter with same sourceSystem', () => {
    const registry = createAdapterRegistry()
    const adapter1 = new LangGraphAdapter()
    const adapter2 = new LangGraphAdapter()

    registry.register(adapter1)
    registry.register(adapter2)

    expect(registry.get('langgraph')).toBe(adapter2)
    expect(registry.list()).toEqual(['langgraph'])
  })

  it('registers multiple adapters', () => {
    const registry = createAdapterRegistry()
    registry.register(new LangGraphAdapter())
    registry.register(new MastraAdapter())
    registry.register(new Mem0Adapter())

    expect(registry.list()).toHaveLength(3)
    expect(registry.list()).toContain('langgraph')
    expect(registry.list()).toContain('mastra')
    expect(registry.list()).toContain('mem0')
  })
})

describe('createDefaultRegistry', () => {
  it('has all 5 built-in adapters', () => {
    const registry = createDefaultRegistry()
    const adapters = registry.list()

    expect(adapters).toHaveLength(5)
    expect(adapters).toContain('langgraph')
    expect(adapters).toContain('mastra')
    expect(adapters).toContain('mem0')
    expect(adapters).toContain('letta')
    expect(adapters).toContain('mcp-knowledge-graph')
  })

  it('returns correct adapter instances', () => {
    const registry = createDefaultRegistry()

    expect(registry.get('langgraph')).toBeInstanceOf(LangGraphAdapter)
    expect(registry.get('mastra')).toBeInstanceOf(MastraAdapter)
    expect(registry.get('mem0')).toBeInstanceOf(Mem0Adapter)
    expect(registry.get('letta')).toBeInstanceOf(LettaAdapter)
    expect(registry.get('mcp-knowledge-graph')).toBeInstanceOf(MCPKGAdapter)
  })

  it('allows adding custom adapters to the default registry', () => {
    const registry = createDefaultRegistry()

    // Create a minimal custom adapter
    const customAdapter = new LangGraphAdapter()
    // Re-register (overwrites)
    registry.register(customAdapter)

    expect(registry.list()).toHaveLength(5)
    expect(registry.get('langgraph')).toBe(customAdapter)
  })
})
