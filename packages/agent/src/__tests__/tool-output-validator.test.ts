/**
 * RF-08 — Unit tests for ToolOutputValidator and its wiring into
 * executePolicyEnabledToolCall.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { DzupEventBus } from '@dzupagent/core'
import { ToolOutputValidator } from '../agent/tool-loop/output-validator.js'
import { executePolicyEnabledToolCall } from '../agent/tool-loop/policy-enabled-tool-executor.js'
import type { PolicyEnabledToolExecutorParams } from '../agent/tool-loop/policy-enabled-tool-executor.js'
import type { ToolLoopConfig } from '../agent/tool-loop.js'
import type { ToolCall, StatGetter } from '../agent/tool-loop/contracts.js'

function makeTool(
  name: string,
  invokeFn: (args: Record<string, unknown>) => Promise<string> = async () => 'ok',
): StructuredToolInterface {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(invokeFn),
  } as unknown as StructuredToolInterface
}

function makeStatGetter(): StatGetter {
  const stat = { calls: 0, errors: 0, totalMs: 0 }
  return () => stat
}

function makeParams(
  tools: StructuredToolInterface[],
  configOverrides: Partial<ToolLoopConfig> = {},
): PolicyEnabledToolExecutorParams {
  return {
    toolMap: new Map(tools.map((t) => [t.name, t])),
    // MC-3 (AGENT-H-06): output-validation wiring tests assert the executor's
    // raw result content, which is orthogonal to the prompt-injection wrapping
    // default. Opt out of wrapping so the exact-content assertions hold.
    config: { maxIterations: 10, wrapToolResults: false, ...configOverrides },
    getOrCreateStat: makeStatGetter(),
  }
}

function makeEventBus(): { bus: DzupEventBus; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = []
  const bus = {
    emit: vi.fn((event: unknown) => events.push(event as Record<string, unknown>)),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as DzupEventBus
  return { bus, events }
}

const makeCall = (name: string): ToolCall => ({ id: 'tc_1', name, args: {} })

describe('ToolOutputValidator', () => {
  it('returns valid when no schema is registered', () => {
    const v = new ToolOutputValidator()
    expect(v.validate('any', 'whatever').valid).toBe(true)
  })

  it('validates JSON output against a Zod schema', () => {
    const v = new ToolOutputValidator({
      summarize: z.object({ text: z.string() }),
    })

    const ok = v.validate('summarize', JSON.stringify({ text: 'hi' }))
    expect(ok.valid).toBe(true)

    const bad = v.validate('summarize', JSON.stringify({ text: 42 }))
    expect(bad.valid).toBe(false)
    expect(bad.error).toMatch(/text/)
  })

  it('treats non-JSON results as raw strings for string schemas', () => {
    const v = new ToolOutputValidator({
      slug: z.string().min(3),
    })
    expect(v.validate('slug', 'hello').valid).toBe(true)
    expect(v.validate('slug', 'hi').valid).toBe(false)
  })

  it('supports predicate functions', () => {
    const v = new ToolOutputValidator({
      onlyDigits: (r) => /^\d+$/.test(r),
    })
    expect(v.validate('onlyDigits', '12345').valid).toBe(true)
    const bad = v.validate('onlyDigits', 'abc')
    expect(bad.valid).toBe(false)
    expect(bad.error).toContain('Predicate returned false')
  })

  it('treats predicate throws as soft failures', () => {
    const v = new ToolOutputValidator({
      explodes: () => {
        throw new Error('boom')
      },
    })
    const result = v.validate('explodes', 'x')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('register replaces an existing schema', () => {
    const v = new ToolOutputValidator()
    v.register('t', () => false)
    expect(v.validate('t', 'x').valid).toBe(false)
    v.register('t', () => true)
    expect(v.validate('t', 'x').valid).toBe(true)
  })
})

describe('executePolicyEnabledToolCall — output validation wiring', () => {
  it('passes valid outputs through unchanged and emits no warning', async () => {
    const tool = makeTool('greet', async () => JSON.stringify({ text: 'hi' }))
    const { bus, events } = makeEventBus()
    const validator = new ToolOutputValidator({
      greet: z.object({ text: z.string() }),
    })

    const result = await executePolicyEnabledToolCall(
      makeCall('greet'),
      makeParams([tool], {
        eventBus: bus,
        toolOutputValidator: validator,
      }),
    )

    expect(result.message.content).toBe(JSON.stringify({ text: 'hi' }))
    expect(events.find((e) => e['type'] === 'tool:output:invalid')).toBeUndefined()
  })

  it('emits tool:output:invalid for failing schemas but continues execution', async () => {
    const tool = makeTool('greet', async () => JSON.stringify({ text: 42 }))
    const { bus, events } = makeEventBus()
    const onInvalid = vi.fn()
    const validator = new ToolOutputValidator({
      greet: z.object({ text: z.string() }),
    })

    const result = await executePolicyEnabledToolCall(
      makeCall('greet'),
      makeParams([tool], {
        eventBus: bus,
        toolOutputValidator: validator,
        onToolOutputInvalid: onInvalid,
        agentId: 'agent-1',
        runId: 'run-1',
      }),
    )

    // The original output is preserved (soft failure).
    expect(result.message.content).toBe(JSON.stringify({ text: 42 }))

    const warning = events.find((e) => e['type'] === 'tool:output:invalid')
    expect(warning).toBeDefined()
    expect(warning?.['toolName']).toBe('greet')
    expect(warning?.['agentId']).toBe('agent-1')
    expect(warning?.['runId']).toBe('run-1')
    expect(typeof warning?.['error']).toBe('string')

    expect(onInvalid).toHaveBeenCalledTimes(1)
    expect(onInvalid.mock.calls[0]?.[0]?.toolName).toBe('greet')
  })

  it('does not validate tools without registered schemas', async () => {
    const tool = makeTool('unwatched', async () => 'arbitrary')
    const { bus, events } = makeEventBus()
    const validator = new ToolOutputValidator({
      other: z.object({ text: z.string() }),
    })

    const result = await executePolicyEnabledToolCall(
      makeCall('unwatched'),
      makeParams([tool], {
        eventBus: bus,
        toolOutputValidator: validator,
      }),
    )

    expect(result.message.content).toBe('arbitrary')
    expect(events.find((e) => e['type'] === 'tool:output:invalid')).toBeUndefined()
  })

  it('swallows validator implementation errors', async () => {
    const tool = makeTool('greet', async () => 'x')
    const { bus, events } = makeEventBus()
    // Build a validator whose validate throws — wraps a built one to exercise
    // the try/catch around the validation call.
    const inner = new ToolOutputValidator()
    inner.register('greet', () => true)
    const broken: ToolOutputValidator = Object.assign(
      Object.create(ToolOutputValidator.prototype) as ToolOutputValidator,
      {
        has: () => true,
        validate: () => {
          throw new Error('validator exploded')
        },
        register: () => {},
      },
    )

    const result = await executePolicyEnabledToolCall(
      makeCall('greet'),
      makeParams([tool], {
        eventBus: bus,
        toolOutputValidator: broken,
      }),
    )

    expect(result.message.content).toBe('x')
    expect(events.find((e) => e['type'] === 'tool:output:invalid')).toBeUndefined()
  })
})
