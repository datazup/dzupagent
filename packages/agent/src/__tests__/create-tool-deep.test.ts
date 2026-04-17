import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createForgeTool } from '../tools/create-tool.js'

describe('createForgeTool', () => {
  it('creates a tool that returns string output directly', async () => {
    const tool = createForgeTool({
      id: 'greet',
      description: 'Greets a person',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => `Hello, ${name}!`,
    })

    expect(tool.name).toBe('greet')
    const result = await tool.invoke({ name: 'Alice' })
    expect(result).toBe('Hello, Alice!')
  })

  it('creates a tool that JSON-stringifies non-string output', async () => {
    const tool = createForgeTool({
      id: 'calc',
      description: 'Adds numbers',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    })

    const result = await tool.invoke({ a: 3, b: 4 })
    expect(JSON.parse(result as string)).toEqual({ sum: 7 })
  })

  it('validates output against outputSchema when provided', async () => {
    const tool = createForgeTool({
      id: 'validated',
      description: 'Returns validated data',
      inputSchema: z.object({ x: z.string() }),
      outputSchema: z.object({ value: z.string() }),
      execute: async ({ x }) => ({ value: x }),
    })

    const result = await tool.invoke({ x: 'test' })
    expect(JSON.parse(result as string)).toEqual({ value: 'test' })
  })

  it('throws when output fails outputSchema validation', async () => {
    const tool = createForgeTool({
      id: 'bad-output',
      description: 'Returns invalid data',
      inputSchema: z.object({ x: z.string() }),
      outputSchema: z.object({ value: z.number() }),
      execute: async () => ({ value: 'not-a-number' }),
    })

    await expect(tool.invoke({ x: 'test' })).rejects.toThrow()
  })

  it('uses toModelOutput when provided', async () => {
    const tool = createForgeTool({
      id: 'formatted',
      description: 'Returns formatted output',
      inputSchema: z.object({ items: z.array(z.string()) }),
      execute: async ({ items }) => items,
      toModelOutput: (items) => `Found ${items.length} items`,
    })

    const result = await tool.invoke({ items: ['a', 'b', 'c'] })
    expect(result).toBe('Found 3 items')
  })

  it('uses toModelOutput with outputSchema validation', async () => {
    const tool = createForgeTool({
      id: 'both',
      description: 'Validates and formats',
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ doubled: z.number() }),
      execute: async ({ n }) => ({ doubled: n * 2 }),
      toModelOutput: (result) => `Result: ${result.doubled}`,
    })

    const result = await tool.invoke({ n: 5 })
    expect(result).toBe('Result: 10')
  })

  it('propagates execution errors', async () => {
    const tool = createForgeTool({
      id: 'failing',
      description: 'Always fails',
      inputSchema: z.object({}),
      execute: async () => { throw new Error('tool exploded') },
    })

    await expect(tool.invoke({})).rejects.toThrow('tool exploded')
  })

  it('tool has correct description', () => {
    const tool = createForgeTool({
      id: 'desc-test',
      description: 'A test tool',
      inputSchema: z.object({ q: z.string() }),
      execute: async () => 'ok',
    })

    expect(tool.description).toBe('A test tool')
  })
})
