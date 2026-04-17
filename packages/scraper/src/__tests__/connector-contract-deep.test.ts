import { describe, it, expect, vi } from 'vitest'
import { normalizeScraperTool } from '../connector-contract.js'
import type { ScraperConnectorTool } from '../connector-contract.js'

describe('normalizeScraperTool - detailed', () => {
  it('returns a tool object with all required properties', () => {
    const tool = normalizeScraperTool({
      name: 'test_scraper',
      description: 'A test scraper tool',
      schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      invoke: async () => 'result',
    })

    expect(tool).toHaveProperty('id')
    expect(tool).toHaveProperty('name')
    expect(tool).toHaveProperty('description')
    expect(tool).toHaveProperty('schema')
    expect(tool).toHaveProperty('invoke')
  })

  it('uses name as id when no id is given', () => {
    const tool = normalizeScraperTool({
      name: 'auto_id_tool',
      description: 'Test',
      schema: { type: 'object', properties: {}, required: [] },
      invoke: async () => '',
    })

    expect(tool.id).toBe('auto_id_tool')
  })

  it('preserves explicit id over name', () => {
    const tool = normalizeScraperTool({
      id: 'explicit_id',
      name: 'different_name',
      description: 'Test',
      schema: { type: 'object', properties: {}, required: [] },
      invoke: async () => '',
    })

    expect(tool.id).toBe('explicit_id')
    expect(tool.name).toBe('different_name')
  })

  it('preserves schema with multiple properties', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL' },
        mode: { type: 'string', enum: ['text', 'html'] },
        timeout: { type: 'number' },
      },
      required: ['url'] as string[],
    }

    const tool = normalizeScraperTool({
      name: 'multi_prop',
      description: 'Multi property tool',
      schema,
      invoke: async () => '',
    })

    expect(tool.schema).toEqual(schema)
  })

  it('invoke function is callable and returns expected result', async () => {
    const invoke = vi.fn().mockResolvedValue('scraped content')
    const tool = normalizeScraperTool({
      name: 'callable',
      description: 'Callable tool',
      schema: { type: 'object', properties: {}, required: [] },
      invoke,
    })

    const result = await tool.invoke({ url: 'https://test.com' })
    expect(result).toBe('scraped content')
    expect(invoke).toHaveBeenCalledWith({ url: 'https://test.com' })
  })

  it('invoke function receives full input object', async () => {
    const invoke = vi.fn().mockResolvedValue('ok')
    const tool = normalizeScraperTool({
      name: 'full_input',
      description: 'Test',
      schema: { type: 'object', properties: {}, required: [] },
      invoke,
    })

    const input = {
      url: 'https://example.com',
      extractMode: 'html' as const,
      cleanHtml: false,
      maxLength: 1000,
    }
    await tool.invoke(input)
    expect(invoke).toHaveBeenCalledWith(input)
  })

  it('preserves description text exactly', () => {
    const longDesc = 'This is a very detailed description of what this tool does, including edge cases and limitations.'
    const tool = normalizeScraperTool({
      name: 'desc_test',
      description: longDesc,
      schema: { type: 'object', properties: {}, required: [] },
      invoke: async () => '',
    })

    expect(tool.description).toBe(longDesc)
  })

  it('handles empty required array in schema', () => {
    const tool = normalizeScraperTool({
      name: 'no_required',
      description: 'Test',
      schema: { type: 'object', properties: { url: { type: 'string' } }, required: [] },
      invoke: async () => '',
    })

    expect(tool.schema.required).toEqual([])
  })

  it('handles empty properties in schema', () => {
    const tool = normalizeScraperTool({
      name: 'no_props',
      description: 'Test',
      schema: { type: 'object', properties: {}, required: [] },
      invoke: async () => '',
    })

    expect(tool.schema.properties).toEqual({})
  })

  it('returns a properly typed ScraperConnectorTool', () => {
    const tool: ScraperConnectorTool = normalizeScraperTool({
      name: 'typed_tool',
      description: 'Typed',
      schema: { type: 'object', properties: {}, required: [] },
      invoke: async () => 'typed result',
    })

    // Type check — tool is ScraperConnectorTool
    expect(tool.schema.type).toBe('object')
  })
})
