import { describe, it, expect, vi } from 'vitest'
import { normalizeDocumentTool, normalizeDocumentTools } from '../connector-contract.js'
import type { StructuredToolInterface } from '@langchain/core/tools'

// ---------------------------------------------------------------------------
// Helpers — create a minimal mock StructuredToolInterface
// ---------------------------------------------------------------------------

function createMockTool(overrides: Partial<StructuredToolInterface> = {}): StructuredToolInterface {
  return {
    name: overrides.name ?? 'mock-tool',
    description: overrides.description ?? 'A mock tool for testing',
    schema: overrides.schema ?? { type: 'object' },
    invoke: overrides.invoke ?? vi.fn().mockResolvedValue('mock-result'),
    // Remaining required fields from the interface
    lc_namespace: [],
    ...overrides,
  } as unknown as StructuredToolInterface
}

// ---------------------------------------------------------------------------
// normalizeDocumentTool
// ---------------------------------------------------------------------------

describe('normalizeDocumentTool', () => {
  it('maps tool name to both id and name', () => {
    const tool = createMockTool({ name: 'my-tool' })
    const normalized = normalizeDocumentTool(tool)
    expect(normalized.id).toBe('my-tool')
    expect(normalized.name).toBe('my-tool')
  })

  it('preserves description', () => {
    const tool = createMockTool({ description: 'Does things' })
    const normalized = normalizeDocumentTool(tool)
    expect(normalized.description).toBe('Does things')
  })

  it('preserves schema', () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } }
    const tool = createMockTool({ schema: schema as unknown as StructuredToolInterface['schema'] })
    const normalized = normalizeDocumentTool(tool)
    expect(normalized.schema).toEqual(schema)
  })

  it('invoke delegates to the underlying tool', async () => {
    const mockInvoke = vi.fn().mockResolvedValue('result-42')
    const tool = createMockTool({ invoke: mockInvoke as unknown as StructuredToolInterface['invoke'] })
    const normalized = normalizeDocumentTool(tool)

    const result = await normalized.invoke('input-data')
    expect(result).toBe('result-42')
    expect(mockInvoke).toHaveBeenCalledWith('input-data')
  })

  it('invoke propagates errors from the underlying tool', async () => {
    const mockInvoke = vi.fn().mockRejectedValue(new Error('tool failed'))
    const tool = createMockTool({ invoke: mockInvoke as unknown as StructuredToolInterface['invoke'] })
    const normalized = normalizeDocumentTool(tool)

    await expect(normalized.invoke('bad-input')).rejects.toThrow('tool failed')
  })
})

// ---------------------------------------------------------------------------
// normalizeDocumentTools
// ---------------------------------------------------------------------------

describe('normalizeDocumentTools', () => {
  it('returns empty array for empty input', () => {
    const result = normalizeDocumentTools([])
    expect(result).toEqual([])
  })

  it('normalizes multiple tools preserving order', () => {
    const tools = [
      createMockTool({ name: 'tool-a' }),
      createMockTool({ name: 'tool-b' }),
      createMockTool({ name: 'tool-c' }),
    ]
    const result = normalizeDocumentTools(tools)
    expect(result).toHaveLength(3)
    expect(result.map((t) => t.id)).toEqual(['tool-a', 'tool-b', 'tool-c'])
  })

  it('each normalized tool is independently invocable', async () => {
    const invokeA = vi.fn().mockResolvedValue('A')
    const invokeB = vi.fn().mockResolvedValue('B')
    const tools = [
      createMockTool({ name: 'a', invoke: invokeA as unknown as StructuredToolInterface['invoke'] }),
      createMockTool({ name: 'b', invoke: invokeB as unknown as StructuredToolInterface['invoke'] }),
    ]
    const result = normalizeDocumentTools(tools)

    expect(await result[0]!.invoke('x')).toBe('A')
    expect(await result[1]!.invoke('y')).toBe('B')
    expect(invokeA).toHaveBeenCalledWith('x')
    expect(invokeB).toHaveBeenCalledWith('y')
  })

  it('handles single tool array', () => {
    const tools = [createMockTool({ name: 'single' })]
    const result = normalizeDocumentTools(tools)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('single')
  })
})
