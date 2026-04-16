import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { StepTypeRegistry, defaultStepTypeRegistry } from '../step-type-registry.js'
import type { StepContext, StepTypeDescriptor } from '../step-type-registry.js'

/** Helper: create a minimal StepContext for tests. */
function makeCtx(overrides?: Partial<StepContext>): StepContext {
  return {
    sessionId: 'test-session',
    tools: [],
    previousOutputs: {},
    ...overrides,
  }
}

/** Helper: create a simple descriptor with string config and string output. */
function makeDescriptor(
  type: string,
  executeFn?: StepTypeDescriptor['execute'],
): StepTypeDescriptor<{ topic: string }, { markdown: string }> {
  return {
    type,
    configSchema: z.object({ topic: z.string() }),
    outputSchema: z.object({ markdown: z.string() }),
    execute:
      executeFn ??
      vi.fn(async (config: { topic: string }) => ({
        markdown: `# ${config.topic}`,
      })),
  }
}

describe('StepTypeRegistry', () => {
  it('register() adds a step type retrievable with get()', () => {
    const registry = new StepTypeRegistry()
    const descriptor = makeDescriptor('synthesize_report')

    registry.register(descriptor)

    const retrieved = registry.get('synthesize_report')
    expect(retrieved).toBeDefined()
    expect(retrieved!.type).toBe('synthesize_report')
  })

  it('register() throws if the same type is registered twice', () => {
    const registry = new StepTypeRegistry()
    registry.register(makeDescriptor('duplicate'))

    expect(() => registry.register(makeDescriptor('duplicate'))).toThrow(
      "Step type 'duplicate' is already registered",
    )
  })

  it('list() returns all registered type names', () => {
    const registry = new StepTypeRegistry()
    registry.register(makeDescriptor('alpha'))
    registry.register(makeDescriptor('beta'))
    registry.register(makeDescriptor('gamma'))

    expect(registry.list()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('has() returns true for registered types and false for unregistered', () => {
    const registry = new StepTypeRegistry()
    registry.register(makeDescriptor('exists'))

    expect(registry.has('exists')).toBe(true)
    expect(registry.has('missing')).toBe(false)
  })

  it('execute() runs the step with validated config and returns validated output', async () => {
    const registry = new StepTypeRegistry()
    const executeFn = vi.fn(async (config: { topic: string }) => ({
      markdown: `# ${config.topic}`,
    }))
    registry.register(makeDescriptor('report', executeFn))

    const ctx = makeCtx()
    const result = await registry.execute('report', { topic: 'AI Safety' }, ctx)

    expect(result).toEqual({ markdown: '# AI Safety' })
    expect(executeFn).toHaveBeenCalledWith({ topic: 'AI Safety' }, ctx)
  })

  it('execute() throws for an unknown step type with a helpful error', async () => {
    const registry = new StepTypeRegistry()
    registry.register(makeDescriptor('known'))

    await expect(registry.execute('unknown', {}, makeCtx())).rejects.toThrow(
      "Unknown step type 'unknown'. Registered types: known",
    )
  })

  it('execute() throws a Zod error when config fails schema validation', async () => {
    const registry = new StepTypeRegistry()
    registry.register(makeDescriptor('strict'))

    // Missing required 'topic' field
    await expect(
      registry.execute('strict', { wrong_field: 123 }, makeCtx()),
    ).rejects.toThrow()
  })

  it('execute() throws a Zod error when executor returns output that fails output schema', async () => {
    const registry = new StepTypeRegistry()
    const badExecutor = vi.fn(async () => ({ not_markdown: 42 }))
    registry.register({
      type: 'bad_output',
      configSchema: z.object({ topic: z.string() }),
      outputSchema: z.object({ markdown: z.string() }),
      execute: badExecutor as unknown as StepTypeDescriptor['execute'],
    })

    await expect(
      registry.execute('bad_output', { topic: 'test' }, makeCtx()),
    ).rejects.toThrow()
  })

  it('unregister() removes a step type', () => {
    const registry = new StepTypeRegistry()
    registry.register(makeDescriptor('temp'))

    expect(registry.has('temp')).toBe(true)
    const removed = registry.unregister('temp')
    expect(removed).toBe(true)
    expect(registry.has('temp')).toBe(false)
    expect(registry.unregister('temp')).toBe(false)
  })

  it('defaultStepTypeRegistry is exported and is a StepTypeRegistry instance', () => {
    expect(defaultStepTypeRegistry).toBeInstanceOf(StepTypeRegistry)
  })
})
