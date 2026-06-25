/**
 * Direct unit tests for the phase helpers extracted from executeStreamingToolCall
 * (RF-19 / CODE-02):
 *
 *  - buildSuccessResult
 *  - handleInvocationFailure
 *  - recordToolLatencyOutcome
 *  - applyBudgetGate  (budget block, governance deny, tool-not-found, approval pending)
 *
 * These helpers are all exported from run-engine-streaming-helpers.ts and
 * have zero direct test coverage in the existing suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { ToolGovernance, DzupEventBus } from '@dzupagent/core'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type { ZodSchema } from 'zod'
import {
  buildSuccessResult,
  handleInvocationFailure,
  recordToolLatencyOutcome,
  applyBudgetGate,
} from '../agent/run-engine-streaming-helpers.js'
import { createToolStatTracker } from '../agent/run-engine.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'
import { StuckDetector } from '../guardrails/stuck-detector.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function mockTool(name: string): StructuredToolInterface {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as unknown as ZodSchema,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => 'ok'),
  } as unknown as StructuredToolInterface
}

function makeToolMap(...names: string[]): Map<string, StructuredToolInterface> {
  return new Map(names.map((n) => [n, mockTool(n)]))
}

// ---------------------------------------------------------------------------
// buildSuccessResult
// ---------------------------------------------------------------------------

describe('buildSuccessResult', () => {
  it('returns ToolMessage with correct content and tool_call_id on happy path', () => {
    const result = buildSuccessResult({
      toolName: 'search',
      toolCallId: 'call_1',
      transformedResult: 'found 3 results',
      validatedArgs: { query: 'test' },
    })

    expect(result.message).toBeInstanceOf(ToolMessage)
    // MC-3 (AGENT-H-06): the CONTEXT-bound ToolMessage content is wrapped in
    // an `<untrusted_content>` delimiter by default; the raw result survives
    // as quoted data and the emitted `eventResult` stays raw.
    expect(result.message.content as string).toContain('found 3 results')
    expect(result.message.content as string).toContain('<untrusted_content source="tool_result">')
    expect(result.message.tool_call_id).toBe('call_1')
    expect(result.eventResult).toBe('found 3 results')
  })

  it('does not set stuckReason/stuckRecovery when stuckDetector is absent', () => {
    const result = buildSuccessResult({
      toolName: 'search',
      toolCallId: 'call_1',
      transformedResult: 'ok',
      validatedArgs: {},
    })

    expect(result.stuckReason).toBeUndefined()
    expect(result.stuckRecovery).toBeUndefined()
    expect(result.stuckNudge).toBeUndefined()
  })

  it('flags stuck when stuckDetector detects repeated tool call', () => {
    const detector = new StuckDetector({ maxRepeatCalls: 1 })
    const args = {
      toolName: 'search',
      toolCallId: 'call_1',
      transformedResult: 'ok',
      validatedArgs: { query: 'same query' },
      stuckDetector: detector,
    }

    // First call — detector flags stuck immediately at maxRepeatCalls=1
    const result = buildSuccessResult(args)

    expect(result.stuckReason).toBeDefined()
    expect(result.stuckRecovery).toContain('blocked')
    expect(result.stuckNudge).toBeInstanceOf(ToolMessage)
    expect(result.repeatedTool).toBe('search')
  })

  it('blocks tool in budget when stuck is detected', () => {
    const detector = new StuckDetector({ maxRepeatCalls: 1 })
    const budget = new IterationBudget({ maxIterations: 10 })

    buildSuccessResult({
      toolName: 'search',
      toolCallId: 'call_1',
      transformedResult: 'ok',
      validatedArgs: {},
      stuckDetector: detector,
      budget,
    })

    expect(budget.isToolBlocked('search')).toBe(true)
  })

  it('does not block budget when no stuck detected', () => {
    const detector = new StuckDetector({ maxRepeatCalls: 5 })
    const budget = new IterationBudget({ maxIterations: 10 })

    buildSuccessResult({
      toolName: 'search',
      toolCallId: 'call_1',
      transformedResult: 'ok',
      validatedArgs: { query: 'unique query' },
      stuckDetector: detector,
      budget,
    })

    expect(budget.isToolBlocked('search')).toBe(false)
  })

  it('stuckNudge message contains the stuck reason', () => {
    const detector = new StuckDetector({ maxRepeatCalls: 1 })

    const result = buildSuccessResult({
      toolName: 'deploy',
      toolCallId: 'call_2',
      transformedResult: 'deployed',
      validatedArgs: {},
      stuckDetector: detector,
    })

    if (result.stuckNudge) {
      expect(String(result.stuckNudge.content)).toContain('Agent appears stuck')
    }
  })
})

// ---------------------------------------------------------------------------
// handleInvocationFailure
// ---------------------------------------------------------------------------

describe('handleInvocationFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ToolMessage with error content', () => {
    const tracker = createToolStatTracker()
    const result = handleInvocationFailure({
      error: new Error('timeout'),
      toolName: 'search',
      toolCallId: 'call_1',
      inputMetadataKeys: [],
      startMs: Date.now() - 50,
      statTracker: tracker,
    })

    expect(result.message).toBeInstanceOf(ToolMessage)
    expect(String(result.message.content)).toContain('Error executing tool "search": timeout')
    expect(result.eventResult).toBe('[error: timeout]')
  })

  it('handles non-Error thrown values (string)', () => {
    const tracker = createToolStatTracker()
    const result = handleInvocationFailure({
      error: 'plain string error',
      toolName: 'search',
      toolCallId: 'call_1',
      inputMetadataKeys: [],
      startMs: Date.now(),
      statTracker: tracker,
    })

    expect(String(result.message.content)).toContain('plain string error')
  })

  it('records error on stat tracker', () => {
    const tracker = createToolStatTracker()
    handleInvocationFailure({
      error: new Error('boom'),
      toolName: 'search',
      toolCallId: 'call_1',
      inputMetadataKeys: [],
      startMs: Date.now() - 100,
      statTracker: tracker,
    })

    const stats = tracker.toArray()
    expect(stats).toHaveLength(1)
    expect(stats[0]!.errors).toBe(1)
    expect(stats[0]!.name).toBe('search')
  })

  it('calls onToolLatency with error tag', () => {
    const onToolLatency = vi.fn()
    const tracker = createToolStatTracker()
    handleInvocationFailure({
      error: new Error('network error'),
      toolName: 'search',
      toolCallId: 'call_1',
      inputMetadataKeys: [],
      startMs: Date.now() - 20,
      statTracker: tracker,
      onToolLatency,
    })

    expect(onToolLatency).toHaveBeenCalledWith(
      'search',
      expect.any(Number),
      'network error',
    )
  })

  it('sets shouldStop when stuckDetector triggers on repeated errors', () => {
    const detector = new StuckDetector({ maxErrorsInWindow: 1 })
    const tracker = createToolStatTracker()

    const result = handleInvocationFailure({
      error: new Error('repeated failure'),
      toolName: 'deploy',
      toolCallId: 'call_1',
      inputMetadataKeys: [],
      startMs: Date.now(),
      statTracker: tracker,
      stuckDetector: detector,
    })

    expect(result.stuckReason).toBeDefined()
    expect(result.shouldStop).toBe(true)
  })

  it('uses __dzupValidatedKeys from error when present', () => {
    const onToolLatency = vi.fn()
    const tracker = createToolStatTracker()
    const errorWithKeys = Object.assign(new Error('boom'), {
      __dzupValidatedKeys: ['file', 'path'],
    })

    // Should not throw — the validated keys override the inputMetadataKeys
    handleInvocationFailure({
      error: errorWithKeys,
      toolName: 'read_file',
      toolCallId: 'call_1',
      inputMetadataKeys: ['original'],
      startMs: Date.now(),
      statTracker: tracker,
      onToolLatency,
    })

    // The function should complete without error
    expect(onToolLatency).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// recordToolLatencyOutcome
// ---------------------------------------------------------------------------

describe('recordToolLatencyOutcome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records latency on stat tracker (success path)', () => {
    const tracker = createToolStatTracker()
    const durationMs = recordToolLatencyOutcome({
      statTracker: tracker,
      toolName: 'search',
      startMs: Date.now() - 100,
    })

    expect(durationMs).toBeGreaterThanOrEqual(0)
    const stats = tracker.toArray()
    expect(stats).toHaveLength(1)
    expect(stats[0]!.errors).toBe(0)
  })

  it('records error on tracker when recordOnTracker is true and errorTag provided', () => {
    const tracker = createToolStatTracker()
    recordToolLatencyOutcome({
      statTracker: tracker,
      toolName: 'search',
      startMs: Date.now(),
      errorTag: 'timeout',
      recordOnTracker: true,
    })

    const stats = tracker.toArray()
    expect(stats[0]!.errors).toBe(1)
  })

  it('does NOT record error on tracker when recordOnTracker is false even with errorTag', () => {
    const tracker = createToolStatTracker()
    recordToolLatencyOutcome({
      statTracker: tracker,
      toolName: 'search',
      startMs: Date.now(),
      errorTag: 'timeout',
      recordOnTracker: false,
    })

    const stats = tracker.toArray()
    expect(stats[0]!.errors).toBe(0)
  })

  it('calls onToolLatency without errorTag on success', () => {
    const onToolLatency = vi.fn()
    const tracker = createToolStatTracker()
    recordToolLatencyOutcome({
      statTracker: tracker,
      toolName: 'search',
      startMs: Date.now() - 50,
      onToolLatency,
    })

    expect(onToolLatency).toHaveBeenCalledWith('search', expect.any(Number))
    expect(onToolLatency).not.toHaveBeenCalledWith('search', expect.any(Number), expect.any(String))
  })

  it('calls onToolLatency with errorTag when provided', () => {
    const onToolLatency = vi.fn()
    const tracker = createToolStatTracker()
    recordToolLatencyOutcome({
      statTracker: tracker,
      toolName: 'search',
      startMs: Date.now(),
      errorTag: 'connection refused',
      onToolLatency,
    })

    expect(onToolLatency).toHaveBeenCalledWith('search', expect.any(Number), 'connection refused')
  })

  it('does not call onToolLatency when not provided', () => {
    const tracker = createToolStatTracker()
    // Should not throw when onToolLatency is absent
    expect(() => {
      recordToolLatencyOutcome({
        statTracker: tracker,
        toolName: 'search',
        startMs: Date.now(),
      })
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// applyBudgetGate
// ---------------------------------------------------------------------------

describe('applyBudgetGate', () => {
  it('returns continue decision with resolved tool for a valid, unblocked tool', () => {
    const toolMap = makeToolMap('search')
    const decision = applyBudgetGate({
      toolCall: { id: 'call_1', name: 'search', args: {} },
      toolCallId: 'call_1',
      toolName: 'search',
      inputMetadataKeys: [],
      toolMap,
    })

    expect(decision.kind).toBe('continue')
    if (decision.kind === 'continue') {
      expect(decision.tool.name).toBe('search')
    }
  })

  it('short-circuits with blocked message when tool is in budget blocklist', () => {
    const toolMap = makeToolMap('search')
    const budget = new IterationBudget({ maxIterations: 10 })
    budget.blockTool('search')

    const decision = applyBudgetGate({
      toolCall: { id: 'call_1', name: 'search', args: {} },
      toolCallId: 'call_1',
      toolName: 'search',
      inputMetadataKeys: [],
      budget,
      toolMap,
    })

    expect(decision.kind).toBe('short-circuit')
    if (decision.kind === 'short-circuit') {
      expect(decision.result.eventResult).toBe('[blocked]')
      expect(String(decision.result.message.content)).toContain('blocked by guardrails')
    }
  })

  it('short-circuits with not-found message when tool is missing from toolMap', () => {
    const toolMap = makeToolMap('read_file', 'write_file')

    const decision = applyBudgetGate({
      toolCall: { id: 'call_1', name: 'nonexistent', args: {} },
      toolCallId: 'call_1',
      toolName: 'nonexistent',
      inputMetadataKeys: [],
      toolMap,
    })

    expect(decision.kind).toBe('short-circuit')
    if (decision.kind === 'short-circuit') {
      expect(decision.result.eventResult).toBe('[not found]')
      expect(String(decision.result.message.content)).toContain('not found')
      expect(String(decision.result.message.content)).toContain('read_file')
      expect(String(decision.result.message.content)).toContain('write_file')
    }
  })

  it('lists available tool names in not-found message', () => {
    const toolMap = makeToolMap('alpha', 'beta', 'gamma')

    const decision = applyBudgetGate({
      toolCall: { id: 'call_1', name: 'missing', args: {} },
      toolCallId: 'call_1',
      toolName: 'missing',
      inputMetadataKeys: [],
      toolMap,
    })

    if (decision.kind === 'short-circuit') {
      const content = String(decision.result.message.content)
      expect(content).toContain('alpha')
      expect(content).toContain('beta')
      expect(content).toContain('gamma')
    }
  })

  it('short-circuits with denial when governance denies access', () => {
    const toolMap = makeToolMap('deploy')
    const toolGovernance = {
      checkAccess: vi.fn(() => ({ allowed: false, reason: 'deployment frozen' })),
      auditResult: vi.fn(async () => {}),
    }

    const decision = applyBudgetGate({
      toolCall: { id: 'call_1', name: 'deploy', args: { env: 'prod' } },
      toolCallId: 'call_1',
      toolName: 'deploy',
      inputMetadataKeys: [],
      toolMap,
      policy: {
        toolGovernance: toolGovernance as unknown as ToolGovernance,
      },
    })

    expect(decision.kind).toBe('short-circuit')
    if (decision.kind === 'short-circuit') {
      expect(String(decision.result.message.content)).toContain('deployment frozen')
      expect(decision.result.eventResult).toContain('[blocked:')
    }
  })

  it('short-circuits with approval_pending when governance requires approval', () => {
    const toolMap = makeToolMap('deploy')
    const toolGovernance = {
      checkAccess: vi.fn(() => ({
        allowed: true,
        requiresApproval: true,
        reason: 'Production deployment requires approval',
      })),
      auditResult: vi.fn(async () => {}),
    }
    const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }

    const decision = applyBudgetGate({
      toolCall: { id: 'call_1', name: 'deploy', args: {} },
      toolCallId: 'call_1',
      toolName: 'deploy',
      inputMetadataKeys: [],
      toolMap,
      policy: {
        toolGovernance: toolGovernance as unknown as ToolGovernance,
        eventBus: eventBus as unknown as DzupEventBus,
        runId: 'run-1',
      },
    })

    expect(decision.kind).toBe('short-circuit')
    if (decision.kind === 'short-circuit') {
      expect(decision.result.approvalPending).toBe(true)
      expect(String(decision.result.message.content)).toContain('approval_pending')
    }
  })

  it('emits approval:requested event when governance requires approval', () => {
    const toolMap = makeToolMap('deploy')
    const toolGovernance = {
      checkAccess: vi.fn(() => ({ allowed: true, requiresApproval: true })),
      auditResult: vi.fn(async () => {}),
    }
    const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }

    applyBudgetGate({
      toolCall: { id: 'call_1', name: 'deploy', args: { env: 'prod' } },
      toolCallId: 'call_1',
      toolName: 'deploy',
      inputMetadataKeys: [],
      toolMap,
      policy: {
        toolGovernance: toolGovernance as unknown as ToolGovernance,
        eventBus: eventBus as unknown as DzupEventBus,
        runId: 'run-approval',
      },
    })

    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'approval:requested',
        runId: 'run-approval',
        plan: expect.objectContaining({ toolName: 'deploy' }),
      }),
    )
  })

  it('short-circuits with TOOL_PERMISSION_DENIED when permission policy denies access', () => {
    const toolMap = makeToolMap('restricted')
    const toolPermissionPolicy = {
      hasPermission: vi.fn(() => false),
    }

    const decision = applyBudgetGate({
      toolCall: { id: 'call_1', name: 'restricted', args: {} },
      toolCallId: 'call_1',
      toolName: 'restricted',
      inputMetadataKeys: [],
      toolMap,
      policy: {
        toolPermissionPolicy: toolPermissionPolicy as unknown as ToolPermissionPolicy,
        agentId: 'agent-1',
      },
    })

    expect(decision.kind).toBe('short-circuit')
    if (decision.kind === 'short-circuit') {
      expect(decision.throwError).toBeDefined()
      expect(decision.throwError?.code).toBe('TOOL_PERMISSION_DENIED')
    }
  })

  it('continues when permission policy allows access', () => {
    const toolMap = makeToolMap('allowed')
    const toolPermissionPolicy = {
      hasPermission: vi.fn(() => true),
    }

    const decision = applyBudgetGate({
      toolCall: { id: 'call_1', name: 'allowed', args: {} },
      toolCallId: 'call_1',
      toolName: 'allowed',
      inputMetadataKeys: [],
      toolMap,
      policy: {
        toolPermissionPolicy: toolPermissionPolicy as unknown as ToolPermissionPolicy,
        agentId: 'agent-1',
      },
    })

    expect(decision.kind).toBe('continue')
  })

  it('continues when governance allows access without approval', () => {
    const toolMap = makeToolMap('search')
    const toolGovernance = {
      checkAccess: vi.fn(() => ({ allowed: true })),
      auditResult: vi.fn(async () => {}),
    }

    const decision = applyBudgetGate({
      toolCall: { id: 'call_1', name: 'search', args: {} },
      toolCallId: 'call_1',
      toolName: 'search',
      inputMetadataKeys: [],
      toolMap,
      policy: { toolGovernance: toolGovernance as unknown as ToolGovernance },
    })

    expect(decision.kind).toBe('continue')
  })
})
