import { describe, expect, it, vi } from 'vitest'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { instrumentSpecialistTool } from '../orchestration/specialist-tool-instrumentation.js'
import type { AgentCircuitBreaker } from '../orchestration/circuit-breaker.js'

function createBreakerSpy(): AgentCircuitBreaker & {
  recordSuccess: ReturnType<typeof vi.fn>
  recordFailure: ReturnType<typeof vi.fn>
  recordTimeout: ReturnType<typeof vi.fn>
} {
  return {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordTimeout: vi.fn(),
    filterAvailable: vi.fn((agents) => agents),
    getState: vi.fn(() => 'closed'),
  } as unknown as AgentCircuitBreaker & {
    recordSuccess: ReturnType<typeof vi.fn>
    recordFailure: ReturnType<typeof vi.fn>
    recordTimeout: ReturnType<typeof vi.fn>
  }
}

function createTool(invoke: ReturnType<typeof vi.fn>): StructuredToolInterface {
  return {
    name: 'shared',
    description: 'shared tool',
    invoke,
  } as unknown as StructuredToolInterface
}

describe('instrumentSpecialistTool', () => {
  it('wraps shared tool instances without mutating the original invoke', async () => {
    const baseInvoke = vi.fn(async (input: unknown) => `ok:${String(input)}`)
    const tool = createTool(baseInvoke)
    const breaker = createBreakerSpy()

    const first = instrumentSpecialistTool(tool, 'first', breaker)
    const second = instrumentSpecialistTool(tool, 'second', breaker)

    expect(first).not.toBe(tool)
    expect(second).not.toBe(tool)
    expect(tool.invoke).toBe(baseInvoke)

    await first.invoke('a')
    await second.invoke('b')

    expect(baseInvoke).toHaveBeenCalledTimes(2)
    expect(breaker.recordSuccess).toHaveBeenCalledWith('first')
    expect(breaker.recordSuccess).toHaveBeenCalledWith('second')
    expect(breaker.recordFailure).not.toHaveBeenCalled()
    expect(breaker.recordTimeout).not.toHaveBeenCalled()
  })

  it('records timeout-shaped failures against the wrapped specialist only', async () => {
    const tool = createTool(vi.fn(async () => {
      throw new Error('tool timeout')
    }))
    const breaker = createBreakerSpy()
    const wrapped = instrumentSpecialistTool(tool, 'slow-specialist', breaker)

    await expect(wrapped.invoke({})).rejects.toThrow('tool timeout')

    expect(breaker.recordTimeout).toHaveBeenCalledWith('slow-specialist')
    expect(breaker.recordFailure).not.toHaveBeenCalled()
  })
})
