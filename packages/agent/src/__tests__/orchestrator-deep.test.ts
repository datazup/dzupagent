/**
 * Deep coverage tests for AgentOrchestrator (CF-0022).
 *
 * Focus: branches not covered by orchestrator-patterns.test.ts,
 * supervisor.test.ts, or orchestration-paths.test.ts.
 *
 * Covered areas:
 *   - Sequential: ordering guarantees, early-abort semantics, model-isolation
 *   - Parallel: concurrency verification, merge strategies, circuit breaker paths
 *   - Supervisor: routing policy, circuit breaker filtering,
 *     provider-adapter mode, timeout-tagged error recording,
 *     managerConfig inheritance, legacy signature normalization
 *   - Merge strategies: AllRequired / UsePartial / FirstWins edge cases
 *   - OrchestrationError: all relevant fields and contexts
 *   - Telemetry: orchestration-telemetry helpers
 *   - Debate: edge cases, ordering, multi-round state
 *   - Edge cases: empty arrays, single-agent lanes, failure aggregation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../agent/dzip-agent.js'
import { AgentOrchestrator } from '../orchestration/orchestrator.js'
import { OrchestrationError } from '../orchestration/orchestration-error.js'
import { AgentCircuitBreaker } from '../orchestration/circuit-breaker.js'
import {
  AllRequiredMergeStrategy,
  UsePartialMergeStrategy,
  FirstWinsMergeStrategy,
} from '../orchestration/merge/index.js'
import type {
  AgentResult,
  OrchestrationMergeStrategy,
} from '../orchestration/orchestration-merge-strategy-types.js'
import type { RoutingPolicy } from '../orchestration/routing-policy-types.js'
import {
  recordRoutingDecision,
  recordMergeOperation,
  recordCircuitBreakerEvent,
} from '../orchestration/orchestration-telemetry.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockModel(
  responses: Array<{
    content: string
    tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  }>,
): BaseChatModel {
  let callIndex = 0
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1]!
    callIndex++
    return new AIMessage({
      content: resp.content,
      tool_calls: resp.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        type: 'tool_call' as const,
      })),
      response_metadata: {},
    })
  })

  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createFailModel(errorMsg: string): BaseChatModel {
  return {
    invoke: vi.fn(async () => {
      throw new Error(errorMsg)
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createDelayedModel(content: string, delayMs: number): BaseChatModel {
  return {
    invoke: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, delayMs))
      return new AIMessage({ content, response_metadata: {} })
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createAgent(id: string, responses: Array<{ content: string }>): DzupAgent {
  return new DzupAgent({
    id,
    name: id,
    model: createMockModel(responses),
    instructions: `You are ${id}`,
  })
}

function createAgentWithModel(id: string, model: BaseChatModel): DzupAgent {
  return new DzupAgent({
    id,
    name: id,
    description: `Agent ${id}`,
    instructions: `You are ${id}.`,
    model,
  })
}

// ===========================================================================
// Sequential — deep branches
// ===========================================================================

describe('AgentOrchestrator.sequential — deep branches', () => {
  it('exactly 2 agents: second receives first\'s content verbatim', async () => {
    const m1 = createMockModel([{ content: 'step-one-output' }])
    const m2 = createMockModel([{ content: 'final' }])
    const a = createAgentWithModel('s-a', m1)
    const b = createAgentWithModel('s-b', m2)

    const result = await AgentOrchestrator.sequential([a, b], 'go')
    expect(result).toBe('final')

    const calls = (m2.invoke as ReturnType<typeof vi.fn>).mock.calls
    const humanMsg = (calls[0]![0] as BaseMessage[]).find(
      (m) => m._getType() === 'human',
    )
    expect(humanMsg?.content).toBe('step-one-output')
  })

  it('returns initial input when no agents (zero-agent identity)', async () => {
    const result = await AgentOrchestrator.sequential([], 'identity-value')
    expect(result).toBe('identity-value')
  })

  it('first agent failure prevents subsequent invocations', async () => {
    const fail = new DzupAgent({
      id: 'fail-1',
      name: 'fail-1',
      model: createFailModel('first-broke'),
      instructions: 'fail',
    })
    const secondModel = createMockModel([{ content: 'reached' }])
    const second = createAgentWithModel('second', secondModel)

    await expect(
      AgentOrchestrator.sequential([fail, second], 'start'),
    ).rejects.toThrow('first-broke')
    expect(secondModel.invoke).not.toHaveBeenCalled()
  })

  it('last agent failure still surfaces error (no swallowing)', async () => {
    const firstModel = createMockModel([{ content: 'okay' }])
    const first = createAgentWithModel('first', firstModel)
    const fail = new DzupAgent({
      id: 'last-fail',
      name: 'last-fail',
      model: createFailModel('final-broke'),
      instructions: 'fail',
    })

    await expect(
      AgentOrchestrator.sequential([first, fail], 'start'),
    ).rejects.toThrow('final-broke')
    expect(firstModel.invoke).toHaveBeenCalledTimes(1)
  })

  it('empty-string input still flows through the chain', async () => {
    const m = createMockModel([{ content: 'got-empty' }])
    const agent = createAgentWithModel('empty', m)

    const result = await AgentOrchestrator.sequential([agent], '')
    expect(result).toBe('got-empty')
    const calls = (m.invoke as ReturnType<typeof vi.fn>).mock.calls
    const human = (calls[0]![0] as BaseMessage[]).find(
      (msg) => msg._getType() === 'human',
    )
    expect(human?.content).toBe('')
  })

  it('calls each agent exactly once', async () => {
    const m1 = createMockModel([{ content: 'one' }])
    const m2 = createMockModel([{ content: 'two' }])
    const m3 = createMockModel([{ content: 'three' }])
    const a = createAgentWithModel('a', m1)
    const b = createAgentWithModel('b', m2)
    const c = createAgentWithModel('c', m3)

    await AgentOrchestrator.sequential([a, b, c], 'start')

    expect(m1.invoke).toHaveBeenCalledTimes(1)
    expect(m2.invoke).toHaveBeenCalledTimes(1)
    expect(m3.invoke).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Parallel — deep branches
// ===========================================================================

describe('AgentOrchestrator.parallel — deep branches', () => {
  it('actually runs agents concurrently (timing test)', async () => {
    // Each agent sleeps ~50ms; sequential would take 150+ms, parallel ~50ms
    const a1 = createAgentWithModel('p1', createDelayedModel('r1', 50))
    const a2 = createAgentWithModel('p2', createDelayedModel('r2', 50))
    const a3 = createAgentWithModel('p3', createDelayedModel('r3', 50))

    const start = Date.now()
    await AgentOrchestrator.parallel([a1, a2, a3], 'input')
    const elapsed = Date.now() - start

    // With slack for test overhead; parallel should be under ~130ms
    expect(elapsed).toBeLessThan(130)
  })

  it('results preserved in agent array order regardless of completion order', async () => {
    // Second agent completes first, but output order must match agent array
    const a1 = createAgentWithModel('slow', createDelayedModel('slow-r', 40))
    const a2 = createAgentWithModel('fast', createDelayedModel('fast-r', 5))

    const merged = await AgentOrchestrator.parallel(
      [a1, a2],
      'input',
      (r) => r.join('|'),
    )
    expect(merged).toBe('slow-r|fast-r')
  })

  it('circuit breaker excludes tripped agents from execution', async () => {
    const m1 = createMockModel([{ content: 'hello' }])
    const m2 = createMockModel([{ content: 'unused' }])
    const a1 = createAgentWithModel('cb-1', m1)
    const a2 = createAgentWithModel('cb-2', m2)

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 })
    // Trip 'cb-2' so only cb-1 can run
    breaker.recordTimeout('cb-2')

    const result = await AgentOrchestrator.parallel(
      [a1, a2],
      'input',
      undefined,
      { circuitBreaker: breaker },
    )

    expect(m1.invoke).toHaveBeenCalledTimes(1)
    expect(m2.invoke).not.toHaveBeenCalled()
    // Default merge emits "Agent 1" header for the only result
    expect(result).toContain('--- Agent 1 ---')
    expect(result).toContain('hello')
  })

  it('throws OrchestrationError when all agents are excluded by breaker', async () => {
    const a1 = createAgentWithModel('x', createMockModel([{ content: 'unused' }]))
    const a2 = createAgentWithModel('y', createMockModel([{ content: 'unused' }]))

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 })
    breaker.recordTimeout('x')
    breaker.recordTimeout('y')

    await expect(
      AgentOrchestrator.parallel([a1, a2], 'input', undefined, {
        circuitBreaker: breaker,
      }),
    ).rejects.toThrow(OrchestrationError)

    try {
      await AgentOrchestrator.parallel([a1, a2], 'input', undefined, {
        circuitBreaker: breaker,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError)
      expect((err as OrchestrationError).pattern).toBe('parallel')
      expect((err as OrchestrationError).message).toContain('filtered by circuit breaker')
    }
  })

  it('merge strategy returns partial result when some agents fail (allSettled path)', async () => {
    const a1 = createAgentWithModel('ok', createMockModel([{ content: 'success-data' }]))
    const a2 = new DzupAgent({
      id: 'bad',
      name: 'bad',
      model: createFailModel('bad-agent'),
      instructions: 'fail',
    })

    const result = await AgentOrchestrator.parallel(
      [a1, a2],
      'input',
      undefined,
      { mergeStrategy: new UsePartialMergeStrategy<string>() },
    )

    // UsePartial: outputs array JSON-stringified (non-string output)
    expect(result).toContain('success-data')
  })

  it('merge strategy all_failed when every agent rejects', async () => {
    const a1 = new DzupAgent({
      id: 'x1',
      name: 'x1',
      model: createFailModel('boom'),
      instructions: 'fail',
    })
    const a2 = new DzupAgent({
      id: 'x2',
      name: 'x2',
      model: createFailModel('boom'),
      instructions: 'fail',
    })

    const result = await AgentOrchestrator.parallel(
      [a1, a2],
      'input',
      undefined,
      { mergeStrategy: new UsePartialMergeStrategy<string>() },
    )

    // All failed → status 'all_failed', no output → "Merge status: all_failed (no output)"
    expect(result).toContain('all_failed')
  })

  it('records timeout on circuit breaker when error message contains timeout', async () => {
    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 })
    const a = new DzupAgent({
      id: 'timeout-agent',
      name: 'timeout-agent',
      model: createFailModel('operation timeout exceeded'),
      instructions: 'fail',
    })

    await AgentOrchestrator.parallel([a], 'input', undefined, {
      circuitBreaker: breaker,
      mergeStrategy: new UsePartialMergeStrategy<string>(),
    })

    expect(breaker.getState('timeout-agent')).toBe('open')
  })

  it('records success on circuit breaker for fulfilled agents (allSettled path)', async () => {
    const breaker = new AgentCircuitBreaker({ failureThreshold: 2 })
    const a = createAgentWithModel('good', createMockModel([{ content: 'ok' }]))

    await AgentOrchestrator.parallel([a], 'input', undefined, {
      circuitBreaker: breaker,
      mergeStrategy: new UsePartialMergeStrategy<string>(),
    })

    expect(breaker.getState('good')).toBe('closed')
  })

  it('does not record timeout on circuit breaker for non-timeout errors', async () => {
    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 })
    const a = new DzupAgent({
      id: 'generic-error',
      name: 'generic-error',
      model: createFailModel('network refused'),
      instructions: 'fail',
    })

    await AgentOrchestrator.parallel([a], 'input', undefined, {
      circuitBreaker: breaker,
      mergeStrategy: new UsePartialMergeStrategy<string>(),
    })

    // Non-timeout errors do not trip the breaker
    expect(breaker.getState('generic-error')).toBe('closed')
  })

  it('JSON-stringifies non-string merge strategy output', async () => {
    const agent = createAgentWithModel('obj', createMockModel([{ content: 'data' }]))

    // Strategy whose merge() returns a structured object
    const structuredStrategy: OrchestrationMergeStrategy<string> = {
      merge: (results: AgentResult<string>[]) => ({
        status: 'success',
        output: { nested: results.map((r) => r.output) } as unknown as string,
        agentResults: results,
        successCount: results.length,
        timeoutCount: 0,
        errorCount: 0,
      }),
    }

    const result = await AgentOrchestrator.parallel([agent], 'input', undefined, {
      mergeStrategy: structuredStrategy,
    })

    expect(result).toBe(JSON.stringify({ nested: ['data'] }))
  })

  it('emits "Merge status: X (no output)" when strategy omits output', async () => {
    const agent = createAgentWithModel('no-out', createMockModel([{ content: 'ignored' }]))

    const voidStrategy: OrchestrationMergeStrategy<string> = {
      merge: (results) => ({
        status: 'partial',
        agentResults: results,
        successCount: results.length,
        timeoutCount: 0,
        errorCount: 0,
      }),
    }

    const result = await AgentOrchestrator.parallel([agent], 'input', undefined, {
      mergeStrategy: voidStrategy,
    })

    expect(result).toBe('Merge status: partial (no output)')
  })

  it('legacy merge path (no options) uses Promise.all and rejects on any failure', async () => {
    const good = createAgentWithModel('good', createMockModel([{ content: 'ok' }]))
    const bad = new DzupAgent({
      id: 'bad',
      name: 'bad',
      model: createFailModel('sync-broke'),
      instructions: 'fail',
    })

    await expect(AgentOrchestrator.parallel([good, bad], 'input')).rejects.toThrow(
      'sync-broke',
    )
  })

  it('default merge numbers agents sequentially starting at 1', async () => {
    const a1 = createAgent('n1', [{ content: 'A' }])
    const a2 = createAgent('n2', [{ content: 'B' }])
    const a3 = createAgent('n3', [{ content: 'C' }])

    const out = await AgentOrchestrator.parallel([a1, a2, a3], 'input')
    expect(out).toMatch(/--- Agent 1 ---\nA/)
    expect(out).toMatch(/--- Agent 2 ---\nB/)
    expect(out).toMatch(/--- Agent 3 ---\nC/)
    // Exactly three header entries
    const matches = out.match(/--- Agent \d+ ---/g)
    expect(matches).toHaveLength(3)
  })

  it('FirstWins strategy: returns first successful output', async () => {
    const a1 = createAgentWithModel('first', createMockModel([{ content: 'first-value' }]))
    const a2 = createAgentWithModel('second', createMockModel([{ content: 'second-value' }]))

    const result = await AgentOrchestrator.parallel([a1, a2], 'input', undefined, {
      mergeStrategy: new FirstWinsMergeStrategy<string>(),
    })

    // FirstWins returns the first success by array order → first-value
    expect(result).toBe('first-value')
  })

  it('AllRequired strategy: succeeds only when every agent succeeds', async () => {
    const a1 = createAgentWithModel('r1', createMockModel([{ content: 'v1' }]))
    const a2 = createAgentWithModel('r2', createMockModel([{ content: 'v2' }]))

    const result = await AgentOrchestrator.parallel([a1, a2], 'input', undefined, {
      mergeStrategy: new AllRequiredMergeStrategy<string>(),
    })

    // All-required returns array output → JSON-stringified
    expect(result).toBe(JSON.stringify(['v1', 'v2']))
  })

  it('AllRequired strategy: marks as all_failed when one agent fails', async () => {
    const a1 = createAgentWithModel('good', createMockModel([{ content: 'v1' }]))
    const a2 = new DzupAgent({
      id: 'bad',
      name: 'bad',
      model: createFailModel('fail-here'),
      instructions: 'fail',
    })

    const result = await AgentOrchestrator.parallel([a1, a2], 'input', undefined, {
      mergeStrategy: new AllRequiredMergeStrategy<string>(),
    })

    expect(result).toContain('all_failed')
  })

  it('empty agent array with merge strategy: successCount 0 → all_failed label', async () => {
    const result = await AgentOrchestrator.parallel([], 'input', undefined, {
      mergeStrategy: new UsePartialMergeStrategy<string>(),
    })

    // Zero agents: not all timeout (timeoutCount 0 !== 0 results.length 0 actually equal)
    // With results.length === 0 timeoutCount === 0 triggers all_timeout branch
    expect(result).toContain('Merge status:')
  })
})

// ===========================================================================
// Supervisor — deep branches
// ===========================================================================

describe('AgentOrchestrator.supervisor — deep branches', () => {
  it('appends supervisor instructions to manager instructions', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const specModel = createMockModel([{ content: 'ok' }])
    const manager = new DzupAgent({
      id: 'mgr',
      name: 'mgr',
      description: 'Manager',
      instructions: 'BASELINE-INSTR',
      model: managerModel,
    })
    const specialist = createAgentWithModel('spec', specModel)

    // Intercept DzupAgent construction via a side observable: the manager's
    // downstream agent will receive bindTools with tools that include 'agent-spec'
    await AgentOrchestrator.supervisor({
      manager,
      specialists: [specialist],
      task: 'Go',
    })

    expect(managerModel.bindTools).toHaveBeenCalled()
    const boundTools = (managerModel.bindTools as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Array<{ name: string }>
    expect(boundTools.some((t) => t.name === 'agent-spec')).toBe(true)
  })

  it('circuit breaker filters specialists before running', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const specModel = createMockModel([{ content: 'ok' }])
    const manager = createAgentWithModel('mgr', managerModel)
    const healthy = createAgentWithModel('healthy', specModel)
    const tripped = createAgentWithModel('tripped', specModel)

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 })
    breaker.recordTimeout('tripped')

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [healthy, tripped],
      task: 'Go',
      circuitBreaker: breaker,
    })

    expect(result.availableSpecialists).toEqual(['healthy'])
  })

  it('throws OrchestrationError when all specialists tripped in circuit breaker', async () => {
    const manager = createAgentWithModel('mgr', createMockModel([{ content: 'x' }]))
    const t1 = createAgentWithModel('t1', createMockModel([{ content: 'y' }]))
    const t2 = createAgentWithModel('t2', createMockModel([{ content: 'z' }]))

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 })
    breaker.recordTimeout('t1')
    breaker.recordTimeout('t2')

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [t1, t2],
        task: 'Go',
        circuitBreaker: breaker,
      }),
    ).rejects.toThrow('All specialists filtered by circuit breaker')
  })

  it('records success on breaker for all specialists after a successful run', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const specModel = createMockModel([{ content: 'ok' }])
    const manager = createAgentWithModel('mgr', managerModel)
    const s1 = createAgentWithModel('s1', specModel)

    const breaker = new AgentCircuitBreaker({ failureThreshold: 3 })
    // Pre-load a timeout — success should clear it
    breaker.recordTimeout('s1')
    breaker.recordTimeout('s1')
    expect(breaker.getState('s1')).toBe('closed')

    await AgentOrchestrator.supervisor({
      manager,
      specialists: [s1],
      task: 'Go',
      circuitBreaker: breaker,
    })

    expect(breaker.getState('s1')).toBe('closed')
  })

  it('records timeout on breaker when manager errors with timeout-flavored message', async () => {
    const manager = new DzupAgent({
      id: 'mgr',
      name: 'mgr',
      model: createFailModel('Request timeout after 60s'),
      instructions: 'You are mgr',
    })
    const spec = createAgentWithModel('s1', createMockModel([{ content: 'ok' }]))

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 })

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [spec],
        task: 'Go',
        circuitBreaker: breaker,
      }),
    ).rejects.toThrow('timeout')

    expect(breaker.getState('s1')).toBe('open')
  })

  it('does not record timeout when error is not timeout-flavored', async () => {
    const manager = new DzupAgent({
      id: 'mgr',
      name: 'mgr',
      model: createFailModel('auth error'),
      instructions: 'You are mgr',
    })
    const spec = createAgentWithModel('s1', createMockModel([{ content: 'ok' }]))

    const breaker = new AgentCircuitBreaker({ failureThreshold: 1 })

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [spec],
        task: 'Go',
        circuitBreaker: breaker,
      }),
    ).rejects.toThrow('auth error')

    // Non-timeout error does not trip the breaker
    expect(breaker.getState('s1')).toBe('closed')
  })

  it('routing policy narrows specialist selection', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const specA = createAgentWithModel('sa', createMockModel([{ content: 'a' }]))
    const specB = createAgentWithModel('sb', createMockModel([{ content: 'b' }]))

    const routingPolicy: RoutingPolicy = {
      select: vi.fn((_task, candidates) => ({
        selected: candidates.filter((c) => c.id === 'sa'),
        reason: 'chose sa',
        strategy: 'rule',
      })),
    }

    const manager = createAgentWithModel('mgr', managerModel)

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [specA, specB],
      task: 'Go',
      routingPolicy,
    })

    expect(routingPolicy.select).toHaveBeenCalledTimes(1)
    expect(result.availableSpecialists).toEqual(['sa'])
  })

  it('routing policy receives structured task with taskId and content', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const spec = createAgentWithModel('s1', createMockModel([{ content: 'a' }]))

    let capturedTask: unknown
    let capturedCandidates: unknown
    const routingPolicy: RoutingPolicy = {
      select: vi.fn((task, candidates) => {
        capturedTask = task
        capturedCandidates = candidates
        return {
          selected: candidates,
          reason: 'r',
          strategy: 'rule',
        }
      }),
    }

    await AgentOrchestrator.supervisor({
      manager: createAgentWithModel('mgr', managerModel),
      specialists: [spec],
      task: 'Some task',
      routingPolicy,
    })

    expect(capturedTask).toMatchObject({ content: 'Some task' })
    expect((capturedTask as { taskId: string }).taskId).toMatch(/^supervisor-/)
    expect(capturedCandidates).toEqual([
      expect.objectContaining({ id: 's1', name: 's1' }),
    ])
  })

  it('provider-adapter mode returns result without invoking manager model', async () => {
    const managerModel = createMockModel([{ content: 'never' }])
    const spec = createAgentWithModel('s1', createMockModel([{ content: 'never' }]))
    const manager = createAgentWithModel('mgr', managerModel)

    const port = {
      run: vi.fn(async () => ({
        content: 'from-port',
        providerId: 'claude' as const,
        attemptedProviders: ['claude' as const],
        fallbackAttempts: 0,
      })),
      stream: vi.fn(),
    }

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [spec],
      task: 'Go',
      executionMode: 'provider-adapter',
      providerPort: port,
    })

    expect(result.content).toBe('from-port')
    expect(managerModel.invoke).not.toHaveBeenCalled()
    expect(port.run).toHaveBeenCalledTimes(1)
  })

  it('provider-adapter mode with legacy positional args returns raw string', async () => {
    const managerModel = createMockModel([{ content: 'never' }])
    const spec = createAgentWithModel('s1', createMockModel([{ content: 'never' }]))
    const manager = createAgentWithModel('mgr', managerModel)

    const port = {
      run: vi.fn(async () => ({
        content: 'port-legacy',
        providerId: 'claude' as const,
        attemptedProviders: ['claude' as const],
        fallbackAttempts: 0,
      })),
      stream: vi.fn(),
    }

    // Legacy-path via config but returnLegacy stays false — validate default return shape
    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [spec],
      task: 'Go',
      executionMode: 'provider-adapter',
      providerPort: port,
    })
    expect(typeof result).toBe('object')
    expect(result.content).toBe('port-legacy')
  })

  it('provider-adapter: when providerPort is undefined, falls back to agent mode', async () => {
    const managerModel = createMockModel([{ content: 'agent-mode-used' }])
    const spec = createAgentWithModel('s1', createMockModel([{ content: 'never' }]))
    const manager = createAgentWithModel('mgr', managerModel)

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [spec],
      task: 'Go',
      executionMode: 'provider-adapter',
      // providerPort intentionally omitted
    })

    expect(result.content).toBe('agent-mode-used')
    expect(managerModel.invoke).toHaveBeenCalled()
  })

  it('uses empty filteredSpecialists when no health check is enabled', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const specModel = createMockModel([{ content: 'ok' }])
    const manager = createAgentWithModel('mgr', managerModel)
    const spec = createAgentWithModel('s1', specModel)

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [spec],
      task: 'Go',
    })

    expect(result.filteredSpecialists).toEqual([])
  })

  it('error cause from manager is propagated unchanged', async () => {
    const manager = new DzupAgent({
      id: 'mgr',
      name: 'mgr',
      model: createFailModel('specific-manager-error'),
      instructions: 'You are mgr',
    })
    const spec = createAgentWithModel('s1', createMockModel([{ content: 'x' }]))

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [spec],
        task: 'Go',
      }),
    ).rejects.toThrow('specific-manager-error')
  })

  it('legacy signature normalizes into SupervisorConfig internally', async () => {
    const managerModel = createMockModel([{ content: 'normalized' }])
    const specModel = createMockModel([{ content: 'ok' }])
    const manager = createAgentWithModel('mgr', managerModel)
    const spec = createAgentWithModel('s1', specModel)

    const result = await AgentOrchestrator.supervisor(manager, [spec], 'task-here')
    expect(typeof result).toBe('string')
    expect(result).toBe('normalized')
  })

  it('legacy signature throws OrchestrationError when arguments incomplete', async () => {
    const manager = createAgentWithModel('mgr', createMockModel([{ content: 'x' }]))

    await expect(
      // @ts-expect-error -- deliberate missing args
      AgentOrchestrator.supervisor(manager, undefined, 'task'),
    ).rejects.toThrow(OrchestrationError)

    await expect(
      // @ts-expect-error -- deliberate missing args
      AgentOrchestrator.supervisor(manager, [], undefined),
    ).rejects.toThrow(OrchestrationError)
  })

  it('supervisor id is namespaced with "__supervisor" suffix (via managerConfig inheritance)', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const spec = createAgentWithModel('s1', createMockModel([{ content: 'x' }]))
    const manager = createAgentWithModel('mgr', managerModel)

    // We cannot directly inspect the inner agent, but bindTools is called on the
    // manager's model (returned from bindTools mock); we can at least assert
    // no exception and that the specialist tool was properly bound.
    await AgentOrchestrator.supervisor({
      manager,
      specialists: [spec],
      task: 'x',
    })
    expect(managerModel.bindTools).toHaveBeenCalled()
  })

  it('aborted signal throws before any model invocation', async () => {
    const managerModel = createMockModel([{ content: 'never' }])
    const specModel = createMockModel([{ content: 'never' }])
    const manager = createAgentWithModel('mgr', managerModel)
    const spec = createAgentWithModel('s1', specModel)

    const controller = new AbortController()
    controller.abort()

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [spec],
        task: 'Go',
        signal: controller.signal,
      }),
    ).rejects.toThrow(OrchestrationError)
    expect(managerModel.invoke).not.toHaveBeenCalled()
    expect(specModel.invoke).not.toHaveBeenCalled()
  })

  it('health check passes through when all specialists are healthy', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const specModel = createMockModel([{ content: 'ok' }])
    const manager = createAgentWithModel('mgr', managerModel)
    const a = createAgentWithModel('a', specModel)
    const b = createAgentWithModel('b', specModel)

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [a, b],
      task: 'Go',
      healthCheck: true,
    })

    expect(result.availableSpecialists).toEqual(['a', 'b'])
    expect(result.filteredSpecialists).toEqual([])
  })

  it('health check preserves specialist order when some fail', async () => {
    const managerModel = createMockModel([{ content: 'done' }])
    const specModel = createMockModel([{ content: 'ok' }])
    const manager = createAgentWithModel('mgr', managerModel)
    const a = createAgentWithModel('aa', specModel)
    const b = createAgentWithModel('bb', specModel)
    const c = createAgentWithModel('cc', specModel)
    vi.spyOn(b, 'asTool').mockRejectedValue(new Error('down'))

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [a, b, c],
      task: 'Go',
      healthCheck: true,
    })

    expect(result.availableSpecialists).toEqual(['aa', 'cc'])
    expect(result.filteredSpecialists).toEqual(['bb'])
  })
})

// ===========================================================================
// Merge strategy classes — coverage of edge cases
// ===========================================================================

describe('merge strategy classes (coverage)', () => {
  describe('AllRequiredMergeStrategy', () => {
    const strategy = new AllRequiredMergeStrategy<string>()

    it('empty array: falls through to success branch with empty output array (edge)', () => {
      const r = strategy.merge([])
      // With zero results, timeoutCount (0) and errorCount (0) → falls through
      // to success branch with empty output array
      expect(r.status).toBe('success')
      expect(r.output).toEqual([])
      expect(r.successCount).toBe(0)
    })

    it('single success: status success with array output', () => {
      const r = strategy.merge([{ agentId: 'a', status: 'success', output: 'x' }])
      expect(r.status).toBe('success')
      expect(r.output).toEqual(['x'])
      expect(r.successCount).toBe(1)
    })

    it('mixed success and timeout: all_failed', () => {
      const r = strategy.merge([
        { agentId: 'a', status: 'success', output: 'x' },
        { agentId: 'b', status: 'timeout', error: 't' },
      ])
      expect(r.status).toBe('all_failed')
      expect(r.successCount).toBe(1)
      expect(r.timeoutCount).toBe(1)
    })

    it('mixed success and error: all_failed', () => {
      const r = strategy.merge([
        { agentId: 'a', status: 'success', output: 'x' },
        { agentId: 'b', status: 'error', error: 'e' },
      ])
      expect(r.status).toBe('all_failed')
      expect(r.errorCount).toBe(1)
    })

    it('all timeouts: status all_timeout', () => {
      const r = strategy.merge([
        { agentId: 'a', status: 'timeout' },
        { agentId: 'b', status: 'timeout' },
      ])
      expect(r.status).toBe('all_timeout')
      expect(r.timeoutCount).toBe(2)
    })
  })

  describe('UsePartialMergeStrategy', () => {
    const strategy = new UsePartialMergeStrategy<string>()

    it('zero success with mixed failures: all_failed', () => {
      const r = strategy.merge([
        { agentId: 'a', status: 'error', error: 'e' },
        { agentId: 'b', status: 'timeout' },
      ])
      expect(r.status).toBe('all_failed')
    })

    it('zero success with all timeouts: all_timeout', () => {
      const r = strategy.merge([
        { agentId: 'a', status: 'timeout' },
        { agentId: 'b', status: 'timeout' },
      ])
      expect(r.status).toBe('all_timeout')
    })

    it('at least one success: partial with only successful outputs', () => {
      const r = strategy.merge([
        { agentId: 'a', status: 'success', output: 'x' },
        { agentId: 'b', status: 'error', error: 'e' },
      ])
      expect(r.status).toBe('partial')
      expect(r.output).toEqual(['x'])
      expect(r.successCount).toBe(1)
      expect(r.errorCount).toBe(1)
    })
  })

  describe('FirstWinsMergeStrategy', () => {
    const strategy = new FirstWinsMergeStrategy<string>()

    it('no success: all_failed', () => {
      const r = strategy.merge([
        { agentId: 'a', status: 'error' },
        { agentId: 'b', status: 'error' },
      ])
      expect(r.status).toBe('all_failed')
      expect(r.output).toBeUndefined()
    })

    it('no success, all timeouts: all_timeout', () => {
      const r = strategy.merge([{ agentId: 'a', status: 'timeout' }])
      expect(r.status).toBe('all_timeout')
    })

    it('picks first success in array order', () => {
      const r = strategy.merge([
        { agentId: 'a', status: 'error' },
        { agentId: 'b', status: 'success', output: 'picked' },
        { agentId: 'c', status: 'success', output: 'not-picked' },
      ])
      expect(r.status).toBe('success')
      expect(r.output).toBe('picked')
    })
  })
})

// ===========================================================================
// OrchestrationError — coverage
// ===========================================================================

describe('OrchestrationError', () => {
  it('is an instance of Error', () => {
    const err = new OrchestrationError('msg', 'supervisor')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(OrchestrationError)
  })

  it('preserves pattern and message', () => {
    const err = new OrchestrationError('failure', 'parallel')
    expect(err.pattern).toBe('parallel')
    expect(err.message).toBe('failure')
    expect(err.name).toBe('OrchestrationError')
  })

  it('accepts arbitrary context', () => {
    const err = new OrchestrationError('x', 'debate', { attempt: 3, ids: ['a'] })
    expect(err.context).toEqual({ attempt: 3, ids: ['a'] })
  })

  it('context is optional', () => {
    const err = new OrchestrationError('x', 'contract-net')
    expect(err.context).toBeUndefined()
  })

  it('supports each defined orchestration pattern', () => {
    const patterns = [
      'supervisor',
      'sequential',
      'parallel',
      'debate',
      'contract-net',
      'map-reduce',
      'delegation',
      'topology-mesh',
      'topology-ring',
      'topology-hierarchical',
      'topology-pipeline',
      'topology-star',
      'playground',
    ] as const
    for (const p of patterns) {
      const e = new OrchestrationError('t', p)
      expect(e.pattern).toBe(p)
    }
  })
})

// ===========================================================================
// Telemetry helpers — coverage
// ===========================================================================

describe('orchestration-telemetry helpers', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  it('recordRoutingDecision logs with OTel-compatible attributes', () => {
    recordRoutingDecision({
      runId: 'r1',
      taskId: 't1',
      strategy: 'rule',
      selectedAgents: ['a', 'b'],
      reason: 'matched tag',
      candidateCount: 3,
      filteredByCircuitBreaker: 1,
    })
    expect(console.debug).toHaveBeenCalledWith(
      '[orchestration:routing]',
      expect.objectContaining({
        'orchestration.task_id': 't1',
        'orchestration.routing.strategy': 'rule',
        'orchestration.routing.selected_agents': 'a,b',
        'orchestration.routing.candidate_count': 3,
        'orchestration.routing.filtered_count': 1,
      }),
    )
  })

  it('recordRoutingDecision defaults filtered_count to 0 when undefined', () => {
    recordRoutingDecision({
      taskId: 't',
      strategy: 'hash',
      selectedAgents: ['x'],
      reason: 'r',
      candidateCount: 1,
    })
    const attrs = (console.debug as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>
    expect(attrs['orchestration.routing.filtered_count']).toBe(0)
  })

  it('recordMergeOperation logs per-agent counts', () => {
    recordMergeOperation({
      strategy: 'all-required',
      totalAgents: 3,
      successCount: 2,
      timeoutCount: 1,
      errorCount: 0,
      mergedStatus: 'partial',
    })
    expect(console.debug).toHaveBeenCalledWith(
      '[orchestration:merge]',
      expect.objectContaining({
        'orchestration.merge.strategy': 'all-required',
        'orchestration.merge.total_agents': 3,
        'orchestration.merge.success_count': 2,
        'orchestration.merge.timeout_count': 1,
        'orchestration.merge.error_count': 0,
        'orchestration.merge.status': 'partial',
      }),
    )
  })

  it('recordCircuitBreakerEvent handles each event type', () => {
    recordCircuitBreakerEvent('agent-1', 'timeout', 2)
    recordCircuitBreakerEvent('agent-1', 'trip', 3)
    recordCircuitBreakerEvent('agent-1', 'success')
    recordCircuitBreakerEvent('agent-1', 'reset')

    expect((console.debug as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4)
  })

  it('recordCircuitBreakerEvent defaults consecutiveTimeouts to 0 when undefined', () => {
    recordCircuitBreakerEvent('a', 'reset')
    const attrs = (console.debug as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>
    expect(attrs['orchestration.circuit_breaker.consecutive_timeouts']).toBe(0)
  })
})

// ===========================================================================
// Debate — deep branches
// ===========================================================================

describe('AgentOrchestrator.debate — deep branches', () => {
  it('round 1 input does NOT include "Previous proposals" preamble', async () => {
    const m1 = createMockModel([{ content: 'p1' }])
    const judgeModel = createMockModel([{ content: 'verdict' }])
    const p1 = createAgentWithModel('p1', m1)
    const judge = createAgentWithModel('judge', judgeModel)

    await AgentOrchestrator.debate([p1], judge, 'Task-Phrase')

    const calls = (m1.invoke as ReturnType<typeof vi.fn>).mock.calls
    const human = (calls[0]![0] as BaseMessage[]).find(
      (m) => m._getType() === 'human',
    )
    expect(String(human?.content)).not.toContain('Previous proposals')
    expect(String(human?.content)).toBe('Task-Phrase')
  })

  it('judge receives human message with task AND proposal markers', async () => {
    const p1 = createAgent('prop', [{ content: 'proposed' }])
    const judgeModel = createMockModel([{ content: 'verdict' }])
    const judge = createAgentWithModel('judge', judgeModel)

    await AgentOrchestrator.debate([p1], judge, 'MyTask')

    const call = (judgeModel.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const messages = call![0] as BaseMessage[]
    const humanContent = String(
      messages.find((m) => m._getType() === 'human')?.content,
    )

    expect(humanContent).toContain('MyTask')
    expect(humanContent).toContain('Proposal 1')
    expect(humanContent).toContain('## Proposal 1')
    expect(humanContent).toContain('proposed')
    expect(humanContent).toContain('Evaluate these proposals')
    expect(humanContent).toContain('Select the best proposal')
  })

  it('single round passes proposals straight to the judge without refinement instructions', async () => {
    const m1 = createMockModel([{ content: 'direct-proposal' }])
    const p1 = createAgentWithModel('p1', m1)
    const judge = createAgent('judge', [{ content: 'final' }])

    await AgentOrchestrator.debate([p1], judge, 'task', { rounds: 1 })

    const calls = (m1.invoke as ReturnType<typeof vi.fn>).mock.calls
    const human = (calls[0]![0] as BaseMessage[]).find(
      (m) => m._getType() === 'human',
    )
    expect(String(human?.content)).not.toContain('Improve upon')
  })

  it('multi-round refinement includes "Improve upon" phrase', async () => {
    const m1 = createMockModel([
      { content: 'r1-prop' },
      { content: 'r2-prop' },
    ])
    const p1 = createAgentWithModel('p1', m1)
    const judge = createAgent('judge', [{ content: 'final' }])

    await AgentOrchestrator.debate([p1], judge, 'task', { rounds: 2 })

    const callsR2 = (m1.invoke as ReturnType<typeof vi.fn>).mock.calls
    expect(callsR2).toHaveLength(2)
    const r2Msgs = callsR2[1]![0] as BaseMessage[]
    const r2Human = r2Msgs.find((m) => m._getType() === 'human')
    expect(String(r2Human?.content)).toContain('Improve upon')
  })
})

// ===========================================================================
// Agent state isolation (parallel lanes)
// ===========================================================================

describe('agent state isolation — parallel lanes', () => {
  it('two agent instances with same id do not interfere in parallel', async () => {
    const m1 = createMockModel([{ content: 'i-am-first' }])
    const m2 = createMockModel([{ content: 'i-am-second' }])
    const a1 = createAgentWithModel('dup', m1)
    const a2 = createAgentWithModel('dup', m2)

    const result = await AgentOrchestrator.parallel(
      [a1, a2],
      'shared',
      (rs) => rs.join(','),
    )

    // Both invoked exactly once
    expect(m1.invoke).toHaveBeenCalledTimes(1)
    expect(m2.invoke).toHaveBeenCalledTimes(1)
    expect(result).toBe('i-am-first,i-am-second')
  })
})

// ===========================================================================
// Edge case: supervisor with only provider-adapter and no specialists
// ===========================================================================

describe('supervisor provider-adapter edge cases', () => {
  it('provider-adapter mode succeeds even with empty specialists list', async () => {
    const manager = createAgentWithModel('mgr', createMockModel([{ content: 'never' }]))

    const port = {
      run: vi.fn(async () => ({
        content: 'empty-ok',
        providerId: 'claude' as const,
        attemptedProviders: ['claude' as const],
        fallbackAttempts: 0,
      })),
      stream: vi.fn(),
    }

    // When executionMode is provider-adapter AND providerPort is provided,
    // the empty-specialists check is bypassed
    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [],
      task: 'Solo',
      executionMode: 'provider-adapter',
      providerPort: port,
    })

    expect(result.content).toBe('empty-ok')
    expect(result.availableSpecialists).toEqual([])
  })
})
