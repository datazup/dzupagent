/**
 * RF-09 — Per-tool retry with exponential backoff.
 *
 * Verifies that the policy-enabled tool executor:
 *   1. retries transient failures up to `maxAttempts`
 *   2. preserves the legacy zero-retry surface when no `toolRetry` entry
 *      is configured
 *   3. respects custom `retryOn` predicates
 *   4. NEVER retries permission denials, validation errors, cancellation,
 *      or per-call timeouts
 */
import { describe, it, expect, vi } from 'vitest'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { ForgeError } from '@dzupagent/core'
import { executePolicyEnabledToolCall } from '../agent/tool-loop/policy-enabled-tool-executor.js'
import type { ToolLoopConfig } from '../agent/tool-loop.js'
import type { StatGetter, ToolCall } from '../agent/tool-loop/contracts.js'

function makeTool(
  name: string,
  invokeFn: (args: Record<string, unknown>) => Promise<unknown>,
): StructuredToolInterface {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(invokeFn),
  } as unknown as StructuredToolInterface
}

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'tc_1', name, args }
}

function makeStatGetter(): StatGetter {
  const stat = { calls: 0, errors: 0, totalMs: 0 }
  return () => stat
}

function makeParams(
  tools: StructuredToolInterface[],
  configOverrides: Partial<ToolLoopConfig> = {},
) {
  return {
    toolMap: new Map(tools.map((t) => [t.name, t])),
    config: { maxIterations: 10, ...configOverrides } as ToolLoopConfig,
    getOrCreateStat: makeStatGetter(),
  }
}

describe('executePolicyEnabledToolCall — RF-09 retry policy', () => {
  it('retries a transiently failing tool until it succeeds', async () => {
    let attempts = 0
    const tool = makeTool('flaky', async () => {
      attempts++
      if (attempts < 3) {
        throw new Error('429 rate_limit exceeded')
      }
      return 'ok-after-retry'
    })

    const params = makeParams([tool], {
      toolRetry: {
        // Use small backoff so the test is fast and deterministic.
        flaky: { maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 5, jitter: false },
      },
    })

    const result = await executePolicyEnabledToolCall(makeToolCall('flaky'), params)

    expect(attempts).toBe(3)
    expect(result.message.content).toBe('ok-after-retry')
    expect(tool.invoke).toHaveBeenCalledTimes(3)
  })

  it('does not retry by default (no toolRetry entry)', async () => {
    const tool = makeTool('never-configured', async () => {
      throw new Error('429 rate limit')
    })

    const params = makeParams([tool])

    const result = await executePolicyEnabledToolCall(
      makeToolCall('never-configured'),
      params,
    )

    expect(tool.invoke).toHaveBeenCalledTimes(1)
    expect(result.message.content).toContain('Error executing tool')
  })

  it('surfaces the final error after exhausting maxAttempts', async () => {
    const tool = makeTool('always-rate-limited', async () => {
      throw new Error('429 rate_limit')
    })

    const params = makeParams([tool], {
      toolRetry: {
        'always-rate-limited': {
          maxAttempts: 3,
          initialBackoffMs: 1,
          maxBackoffMs: 5,
          jitter: false,
        },
      },
    })

    const result = await executePolicyEnabledToolCall(
      makeToolCall('always-rate-limited'),
      params,
    )

    expect(tool.invoke).toHaveBeenCalledTimes(3)
    expect(result.message.content).toContain('Error executing tool')
    expect(result.message.content).toContain('429')
  })

  it('does NOT retry non-transient errors (default predicate)', async () => {
    const tool = makeTool('validation-bug', async () => {
      // No transient marker — isTransientError returns false.
      throw new Error('Bad input field foo')
    })

    const params = makeParams([tool], {
      toolRetry: {
        'validation-bug': {
          maxAttempts: 3,
          initialBackoffMs: 1,
          maxBackoffMs: 5,
          jitter: false,
        },
      },
    })

    await executePolicyEnabledToolCall(makeToolCall('validation-bug'), params)

    expect(tool.invoke).toHaveBeenCalledTimes(1)
  })

  it('honors a custom retryOn predicate', async () => {
    let attempts = 0
    const tool = makeTool('custom-retry', async () => {
      attempts++
      if (attempts < 2) throw new Error('domain-specific transient: stale snapshot')
      return 'recovered'
    })

    const retryOn = vi.fn((err: Error) => err.message.includes('stale snapshot'))

    const params = makeParams([tool], {
      toolRetry: {
        'custom-retry': {
          maxAttempts: 3,
          initialBackoffMs: 1,
          maxBackoffMs: 5,
          jitter: false,
          retryOn,
        },
      },
    })

    const result = await executePolicyEnabledToolCall(
      makeToolCall('custom-retry'),
      params,
    )

    expect(retryOn).toHaveBeenCalled()
    expect(attempts).toBe(2)
    expect(result.message.content).toBe('recovered')
  })

  it('does NOT retry ForgeError (permission/governance denials)', async () => {
    // Build a tool that throws a ForgeError mid-execution. Permission
    // ForgeErrors raised before tool.invoke are tested elsewhere; this
    // simulates a tool that itself wraps an upstream denial.
    const tool = makeTool('locked', async () => {
      throw new ForgeError({
        code: 'TOOL_PERMISSION_DENIED',
        message: 'locked by upstream',
      })
    })

    const params = makeParams([tool], {
      toolRetry: {
        locked: { maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 5, jitter: false },
      },
    })

    // ForgeError from inside tool.invoke (no phase='issuance') is caught and
    // returned as a ToolMessage, NOT retried — invoke must be called exactly once.
    const result = await executePolicyEnabledToolCall(makeToolCall('locked'), params)

    expect(tool.invoke).toHaveBeenCalledTimes(1)
    expect(result.message.content).toContain('Error executing tool')
  })

  it('does NOT retry once an external abort signal fires between attempts', async () => {
    const controller = new AbortController()
    let attempts = 0
    const tool = makeTool('abortable', async () => {
      attempts++
      // Trigger abort on the first failure so the next iteration sees it.
      if (attempts === 1) controller.abort()
      throw new Error('429 transient')
    })

    const params = makeParams([tool], {
      signal: controller.signal,
      toolRetry: {
        abortable: {
          maxAttempts: 5,
          initialBackoffMs: 1,
          maxBackoffMs: 5,
          jitter: false,
        },
      },
    })

    await executePolicyEnabledToolCall(makeToolCall('abortable'), params)

    // First attempt ran; the abort short-circuits any retry.
    expect(attempts).toBe(1)
  })

  it('emits a retry diagnostic via onToolLatency before each retry', async () => {
    let attempts = 0
    const tool = makeTool('observed', async () => {
      attempts++
      if (attempts < 3) throw new Error('overloaded')
      return 'ok'
    })
    const onToolLatency = vi.fn()

    const params = makeParams([tool], {
      onToolLatency,
      toolRetry: {
        observed: { maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 5, jitter: false },
      },
    })

    await executePolicyEnabledToolCall(makeToolCall('observed'), params)

    // Two retry diagnostics (attempts 1 and 2) plus one terminal latency
    // record from the success path = 3 total calls.
    const retryCalls = onToolLatency.mock.calls.filter(
      ([, , err]) => typeof err === 'string' && err.startsWith('retry'),
    )
    expect(retryCalls).toHaveLength(2)
    expect(retryCalls[0]?.[2]).toContain('retry 1/2')
  })
})
