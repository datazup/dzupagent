import { describe, it, expect, vi } from 'vitest'
import { normalizeBrowserTool, normalizeBrowserTools } from '../connector-contract.js'
import type { StructuredToolInterface } from '@langchain/core/tools'

function createMockTool(overrides: Partial<StructuredToolInterface> = {}): StructuredToolInterface {
  return {
    name: 'test-tool',
    description: 'A test tool',
    schema: { type: 'object', properties: { url: { type: 'string' } } },
    invoke: vi.fn().mockResolvedValue('result'),
    ...overrides,
  } as unknown as StructuredToolInterface
}

describe('normalizeBrowserTool', () => {
  it('maps tool name to id and name', () => {
    const tool = createMockTool({ name: 'browser-screenshot' })
    const normalized = normalizeBrowserTool(tool)

    expect(normalized.id).toBe('browser-screenshot')
    expect(normalized.name).toBe('browser-screenshot')
  })

  it('preserves the description', () => {
    const tool = createMockTool({ description: 'Take a screenshot' })
    const normalized = normalizeBrowserTool(tool)

    expect(normalized.description).toBe('Take a screenshot')
  })

  it('preserves the schema', () => {
    const schema = { type: 'object', properties: { url: { type: 'string' } } }
    const tool = createMockTool({ schema } as never)
    const normalized = normalizeBrowserTool(tool)

    expect(normalized.schema).toBe(schema)
  })

  it('wraps invoke to call the underlying tool', async () => {
    const tool = createMockTool()
    const normalized = normalizeBrowserTool(tool)

    await normalized.invoke({ url: 'https://example.com' })

    expect(tool.invoke).toHaveBeenCalledWith({ url: 'https://example.com' })
  })

  it('returns the result from invoke', async () => {
    const tool = createMockTool()
    ;(tool.invoke as ReturnType<typeof vi.fn>).mockResolvedValue('screenshot-data')
    const normalized = normalizeBrowserTool(tool)

    const result = await normalized.invoke({ url: 'https://example.com' })
    expect(result).toBe('screenshot-data')
  })
})

describe('normalizeBrowserTools', () => {
  it('normalizes an array of tools', () => {
    const tools = [
      createMockTool({ name: 'tool-a' }),
      createMockTool({ name: 'tool-b' }),
      createMockTool({ name: 'tool-c' }),
    ]
    const normalized = normalizeBrowserTools(tools)

    expect(normalized).toHaveLength(3)
    expect(normalized.map(t => t.id)).toEqual(['tool-a', 'tool-b', 'tool-c'])
  })

  it('returns an empty array for empty input', () => {
    const normalized = normalizeBrowserTools([])
    expect(normalized).toEqual([])
  })

  it('each normalized tool has invoke as a function', () => {
    const tools = [createMockTool()]
    const normalized = normalizeBrowserTools(tools)

    expect(typeof normalized[0]!.invoke).toBe('function')
  })
})
