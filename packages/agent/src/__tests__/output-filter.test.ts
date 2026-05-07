/**
 * Unit tests for the pluggable output filter chain (M-13).
 *
 * Covers:
 *  - No filters: output passes through unchanged
 *  - Empty filter list: output passes through unchanged
 *  - Single sync filter transforms output
 *  - Single async filter transforms output
 *  - Multiple filters run in sequence
 *  - Filter returning null stops the chain (preserves current value)
 *  - Filter throwing propagates the error
 *  - Context object forwarded to each filter
 *  - Integration via DzupAgentConfig.outputFilters wired through processGeneratedRun
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  applyOutputFilterChain,
} from '../agent/output-filter.js'
import type { OutputFilter, OutputFilterContext } from '../agent/output-filter.js'
import {
  processGeneratedRun,
  type RunLoopResult,
} from '../agent/run-engine-generate-helpers.js'
import type { ExecuteGenerateRunParams } from '../agent/run-engine.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<OutputFilterContext> = {}): OutputFilterContext {
  return {
    agentId: 'test-agent',
    tenantId: 'test-tenant',
    runId: 'run-001',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// applyOutputFilterChain
// ---------------------------------------------------------------------------

describe('applyOutputFilterChain', () => {
  it('returns the original output unchanged when the filter list is empty', async () => {
    const result = await applyOutputFilterChain('hello world', [], makeCtx())
    expect(result).toBe('hello world')
  })

  it('applies a single synchronous filter', async () => {
    const upper: OutputFilter = {
      name: 'upper',
      filter: (output) => output.toUpperCase(),
    }
    const result = await applyOutputFilterChain('hello', [upper], makeCtx())
    expect(result).toBe('HELLO')
  })

  it('applies a single async filter', async () => {
    const append: OutputFilter = {
      name: 'append',
      filter: async (output) => `${output} appended`,
    }
    const result = await applyOutputFilterChain('text', [append], makeCtx())
    expect(result).toBe('text appended')
  })

  it('runs multiple filters in sequence, each receiving the previous result', async () => {
    const addFoo: OutputFilter = { name: 'addFoo', filter: (o) => `${o}:foo` }
    const addBar: OutputFilter = { name: 'addBar', filter: (o) => `${o}:bar` }

    const result = await applyOutputFilterChain('start', [addFoo, addBar], makeCtx())
    expect(result).toBe('start:foo:bar')
  })

  it('stops the chain when a filter returns null and preserves the current value', async () => {
    const step1: OutputFilter = { name: 'step1', filter: (o) => `${o}:step1` }
    const nullFilter: OutputFilter = { name: 'null', filter: () => null }
    const step3Spy = vi.fn((o: string) => `${o}:step3`)
    const step3: OutputFilter = { name: 'step3', filter: step3Spy }

    const result = await applyOutputFilterChain('start', [step1, nullFilter, step3], makeCtx())
    expect(result).toBe('start:step1')
    expect(step3Spy).not.toHaveBeenCalled()
  })

  it('propagates errors thrown by a filter', async () => {
    const boom: OutputFilter = {
      name: 'boom',
      filter: () => { throw new Error('filter exploded') },
    }
    await expect(
      applyOutputFilterChain('content', [boom], makeCtx()),
    ).rejects.toThrow('filter exploded')
  })

  it('propagates errors thrown by an async filter', async () => {
    const asyncBoom: OutputFilter = {
      name: 'asyncBoom',
      filter: async () => { throw new Error('async filter exploded') },
    }
    await expect(
      applyOutputFilterChain('content', [asyncBoom], makeCtx()),
    ).rejects.toThrow('async filter exploded')
  })

  it('forwards the context object to every filter in the chain', async () => {
    const capturedCtxs: OutputFilterContext[] = []
    const captureCtx: OutputFilter = {
      name: 'captureCtx',
      filter: (o, ctx) => {
        capturedCtxs.push(ctx)
        return o
      },
    }
    const captureCtx2: OutputFilter = {
      name: 'captureCtx2',
      filter: (o, ctx) => {
        capturedCtxs.push(ctx)
        return o
      },
    }

    const ctx = makeCtx({ agentId: 'my-agent', tenantId: 'my-tenant', runId: 'r-99' })
    await applyOutputFilterChain('data', [captureCtx, captureCtx2], ctx)

    expect(capturedCtxs).toHaveLength(2)
    for (const c of capturedCtxs) {
      expect(c.agentId).toBe('my-agent')
      expect(c.tenantId).toBe('my-tenant')
      expect(c.runId).toBe('r-99')
    }
  })

  it('handles an async filter that returns null mid-chain', async () => {
    const upper: OutputFilter = {
      name: 'upper',
      filter: (o) => o.toUpperCase(),
    }
    const asyncNull: OutputFilter = {
      name: 'asyncNull',
      filter: async () => null,
    }
    const suffix: OutputFilter = {
      name: 'suffix',
      filter: (o) => `${o}!`,
    }

    const result = await applyOutputFilterChain('hi', [upper, asyncNull, suffix], makeCtx())
    expect(result).toBe('HI')
  })
})

describe('processGeneratedRun outputFilters', () => {
  it('runs the filter chain after the legacy output filter with provenance context', async () => {
    const model = {} as BaseChatModel
    const memoryFrame = { id: 'frame-1' }
    const chainFilter = vi.fn((output: string, ctx: OutputFilterContext) => (
      `${ctx.agentId}:${ctx.tenantId}:${ctx.runId}:${output}:chain`
    ))
    const maybeUpdateSummary = vi.fn(async () => {})

    const params: ExecuteGenerateRunParams = {
      agentId: 'agent-123',
      config: {
        id: 'agent-123',
        instructions: 'test instructions',
        model,
        guardrails: {
          outputFilter: (output) => `legacy:${output}`,
        },
        memoryScope: {
          tenantId: 'tenant-7',
        },
        outputFilters: [
          {
            name: 'chain',
            filter: chainFilter,
          },
        ],
      },
      options: {
        runId: 'run-42',
      },
      runState: {
        maxIterations: 1,
        preparedMessages: [],
        tools: [],
        toolMap: new Map(),
        model,
        memoryFrame,
      },
      invokeModel: async () => new AIMessage('unused'),
      transformToolResult: async (_toolName, _input, result) => result,
      maybeUpdateSummary,
    }

    const loopResult: RunLoopResult = {
      messages: [new AIMessage('raw')],
      totalInputTokens: 3,
      totalOutputTokens: 4,
      llmCalls: 1,
      hitIterationLimit: false,
      stopReason: 'complete',
      toolStats: [],
    }

    const generated = await processGeneratedRun(params, loopResult, [])

    expect(generated.content).toBe('agent-123:tenant-7:run-42:legacy:raw:chain')
    expect(chainFilter).toHaveBeenCalledWith('legacy:raw', {
      agentId: 'agent-123',
      tenantId: 'tenant-7',
      runId: 'run-42',
    })
    expect(maybeUpdateSummary).toHaveBeenCalledWith(loopResult.messages, memoryFrame)
  })
})
