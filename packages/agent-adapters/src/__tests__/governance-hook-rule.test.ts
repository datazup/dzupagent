/**
 * Task B — hook_executed and rule_violation governance emitter tests.
 *
 * 1. base-cli-adapter: emits governance:hook_executed when the provider JSONL
 *    stream contains a record with type:'hook_execution' or hookName field.
 * 2. adapter-guardrails: calls onRuleViolation when a blocked_tool or budget
 *    violation is triggered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import type { AdapterProviderId, AgentEvent, AgentInput, GovernanceEvent } from '../types.js'
import { BaseCliAdapter } from '../base/base-cli-adapter.js'
import { AdapterGuardrails } from '../guardrails/adapter-guardrails.js'
import * as processHelpers from '../utils/process-helpers.js'
import { collectEvents } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', async () => {
  const actual = await vi.importActual<typeof processHelpers>('../utils/process-helpers.js')
  return {
    ...actual,
    isBinaryAvailable: vi.fn().mockResolvedValue(true),
    spawnAndStreamJsonl: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// Minimal BaseCliAdapter subclass for tests
// ---------------------------------------------------------------------------

class TestCliAdapter extends BaseCliAdapter {
  constructor(providerId: AdapterProviderId = 'codex') {
    super(providerId)
  }

  protected getBinaryName(): string { return 'test-binary' }

  protected buildArgs(_input: AgentInput): string[] { return [] }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    if (record['type'] === 'completed') {
      return {
        type: 'adapter:completed',
        providerId: this.providerId,
        sessionId,
        result: '',
        durationMs: 0,
        timestamp: Date.now(),
      }
    }
    return undefined
  }
}

function mockSpawn(records: Record<string, unknown>[]): void {
  vi.mocked(processHelpers.spawnAndStreamJsonl).mockImplementation(
    async function* () {
      for (const r of records) { yield r }
    },
  )
}

// ---------------------------------------------------------------------------
// Task B — hook_executed tests
// ---------------------------------------------------------------------------

describe('BaseCliAdapter: governance:hook_executed emission', () => {
  let adapter: TestCliAdapter
  const received: GovernanceEvent[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    received.length = 0
    vi.mocked(processHelpers.isBinaryAvailable).mockResolvedValue(true)
    adapter = new TestCliAdapter('codex')
    adapter.onGovernanceEvent((e) => received.push(e))
  })

  it('emits governance:hook_executed for a record with type:"hook_execution"', async () => {
    mockSpawn([
      { type: 'hook_execution', hookName: 'pre-commit', exitCode: 0 },
      { type: 'completed' },
    ])
    const input: AgentInput = { prompt: 'test' }
    await collectEvents(adapter.execute(input))

    const hookEvents = received.filter((e) => e.type === 'governance:hook_executed')
    expect(hookEvents).toHaveLength(1)
    const ev = hookEvents[0]!
    if (ev.type === 'governance:hook_executed') {
      expect(ev.hookName).toBe('pre-commit')
      expect(ev.exitCode).toBe(0)
      expect(ev.providerId).toBe('codex')
    }
  })

  it('emits governance:hook_executed for a record with a top-level hookName field', async () => {
    mockSpawn([
      { hookName: 'post-tool', exitCode: 1 },
      { type: 'completed' },
    ])
    await collectEvents(adapter.execute({ prompt: 'test' }))

    const hookEvents = received.filter((e) => e.type === 'governance:hook_executed')
    expect(hookEvents).toHaveLength(1)
    const ev = hookEvents[0]!
    if (ev.type === 'governance:hook_executed') {
      expect(ev.hookName).toBe('post-tool')
      expect(ev.exitCode).toBe(1)
    }
  })

  it('does NOT emit governance:hook_executed for ordinary records', async () => {
    mockSpawn([{ type: 'message', content: 'hello' }, { type: 'completed' }])
    await collectEvents(adapter.execute({ prompt: 'test' }))
    const hookEvents = received.filter((e) => e.type === 'governance:hook_executed')
    expect(hookEvents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Task B — rule_violation tests via AdapterGuardrails
// ---------------------------------------------------------------------------

describe('AdapterGuardrails: onRuleViolation callback', () => {
  it('calls onRuleViolation with "block" severity when a blocked tool is used', async () => {
    const onRuleViolation = vi.fn()
    const guardrails = new AdapterGuardrails({
      blockedTools: ['dangerous_tool'],
      onRuleViolation,
    })

    async function* fakeSource(): AsyncGenerator<AgentEvent> {
      yield {
        type: 'adapter:tool_call',
        providerId: 'codex',
        toolName: 'dangerous_tool',
        input: {},
        timestamp: Date.now(),
      }
    }

    await collectEvents(guardrails.wrap(fakeSource()))

    expect(onRuleViolation).toHaveBeenCalledOnce()
    const [ruleId, severity, detail] = onRuleViolation.mock.calls[0]!
    expect(ruleId).toBe('blocked_tool')
    expect(severity).toBe('block')
    expect(typeof detail).toBe('string')
  })

  it('calls onRuleViolation with "block" severity when iteration budget is exceeded', async () => {
    const onRuleViolation = vi.fn()
    const guardrails = new AdapterGuardrails({
      maxIterations: 1,
      onRuleViolation,
    })

    async function* fakeSource(): AsyncGenerator<AgentEvent> {
      // Two tool calls → second one should exceed the limit (1 iteration = 1 tool call)
      yield { type: 'adapter:tool_call', providerId: 'codex', toolName: 'read_file', input: {}, timestamp: Date.now() }
      yield { type: 'adapter:tool_call', providerId: 'codex', toolName: 'read_file', input: {}, timestamp: Date.now() }
    }

    await collectEvents(guardrails.wrap(fakeSource()))

    expect(onRuleViolation).toHaveBeenCalled()
    const violationType = onRuleViolation.mock.calls[0]![0]
    expect(typeof violationType).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Task B — additional hook_executed emission coverage
// ---------------------------------------------------------------------------

describe('BaseCliAdapter: additional governance:hook_executed coverage', () => {
  let adapter: TestCliAdapter
  const received: GovernanceEvent[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    received.length = 0
    vi.mocked(processHelpers.isBinaryAvailable).mockResolvedValue(true)
    adapter = new TestCliAdapter('codex')
    adapter.onGovernanceEvent((e) => received.push(e))
  })

  it('accepts snake_case hook_name + exit_code fields in the JSONL record', async () => {
    mockSpawn([
      { type: 'hook_execution', hook_name: 'pre-tool', exit_code: 2 },
      { type: 'completed' },
    ])
    await collectEvents(adapter.execute({ prompt: 'go' }))
    const hookEvents = received.filter((e) => e.type === 'governance:hook_executed')
    expect(hookEvents).toHaveLength(1)
    const ev = hookEvents[0]!
    if (ev.type === 'governance:hook_executed') {
      expect(ev.hookName).toBe('pre-tool')
      expect(ev.exitCode).toBe(2)
    }
  })

  it('reads hookName + exitCode from a nested `hook` object', async () => {
    mockSpawn([
      { type: 'hook_execution', hook: { name: 'post-bash', exitCode: 0 } },
      { type: 'completed' },
    ])
    await collectEvents(adapter.execute({ prompt: 'go' }))
    const hookEvents = received.filter((e) => e.type === 'governance:hook_executed')
    expect(hookEvents).toHaveLength(1)
    const ev = hookEvents[0]!
    if (ev.type === 'governance:hook_executed') {
      expect(ev.hookName).toBe('post-bash')
      expect(ev.exitCode).toBe(0)
    }
  })

  it('emits one hook_executed event per qualifying record, preserving order', async () => {
    mockSpawn([
      { type: 'hook_execution', hookName: 'h1', exitCode: 0 },
      { type: 'message' },
      { type: 'hook_execution', hookName: 'h2', exitCode: 1 },
      { type: 'completed' },
    ])
    await collectEvents(adapter.execute({ prompt: 'go' }))
    const hookEvents = received.filter((e) => e.type === 'governance:hook_executed')
    expect(hookEvents).toHaveLength(2)
    if (
      hookEvents[0]?.type === 'governance:hook_executed' &&
      hookEvents[1]?.type === 'governance:hook_executed'
    ) {
      expect(hookEvents[0].hookName).toBe('h1')
      expect(hookEvents[1].hookName).toBe('h2')
    }
  })

  it('stamps the correlationId-derived runId when provided', async () => {
    mockSpawn([
      { type: 'hook_execution', hookName: 'pre-commit' },
      { type: 'completed' },
    ])
    await collectEvents(
      adapter.execute({ prompt: 'go', correlationId: 'corr-42' }),
    )
    const hookEvent = received.find((e) => e.type === 'governance:hook_executed')
    expect(hookEvent).toBeDefined()
    if (hookEvent && hookEvent.type === 'governance:hook_executed') {
      expect(hookEvent.runId).toBe('corr-42')
    }
  })
})

// ---------------------------------------------------------------------------
// Task B — governance:rule_violation emission from BaseCliAdapter
// ---------------------------------------------------------------------------

describe('BaseCliAdapter: governance:rule_violation emission', () => {
  let adapter: TestCliAdapter
  const received: GovernanceEvent[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    received.length = 0
    vi.mocked(processHelpers.isBinaryAvailable).mockResolvedValue(true)
    adapter = new TestCliAdapter('codex')
    adapter.onGovernanceEvent((e) => received.push(e))
  })

  it('emitRuleViolation emits a well-formed governance:rule_violation event', () => {
    adapter.emitRuleViolation({
      ruleId: 'no-secrets',
      severity: 'block',
      detail: 'Found API key',
      runId: 'run-1',
      sessionId: 'sess-1',
    })
    expect(received).toHaveLength(1)
    const ev = received[0]!
    if (ev.type === 'governance:rule_violation') {
      expect(ev.ruleId).toBe('no-secrets')
      expect(ev.severity).toBe('block')
      expect(ev.detail).toBe('Found API key')
      expect(ev.runId).toBe('run-1')
      expect(ev.sessionId).toBe('sess-1')
      expect(ev.providerId).toBe('codex')
      expect(typeof ev.timestamp).toBe('number')
    } else {
      throw new Error('expected governance:rule_violation')
    }
  })

  it('attachGuardrailsGovernance routes guardrails.onRuleViolation to the governance plane', async () => {
    const guardrails = new AdapterGuardrails({ blockedTools: ['dangerous'] })
    adapter.attachGuardrailsGovernance(guardrails)

    async function* fakeSource(): AsyncGenerator<AgentEvent> {
      yield {
        type: 'adapter:tool_call',
        providerId: 'codex',
        toolName: 'dangerous',
        input: {},
        timestamp: Date.now(),
      }
    }
    await collectEvents(guardrails.wrap(fakeSource()))

    const violations = received.filter((e) => e.type === 'governance:rule_violation')
    expect(violations).toHaveLength(1)
    const ev = violations[0]!
    if (ev.type === 'governance:rule_violation') {
      expect(ev.ruleId).toBe('blocked_tool')
      expect(ev.severity).toBe('block')
      expect(ev.providerId).toBe('codex')
    }
  })

  it('attachGuardrailsGovernance preserves any pre-existing onRuleViolation callback', async () => {
    const preExisting = vi.fn()
    const guardrails = new AdapterGuardrails({
      blockedTools: ['dangerous'],
      onRuleViolation: preExisting,
    })
    adapter.attachGuardrailsGovernance(guardrails)

    async function* fakeSource(): AsyncGenerator<AgentEvent> {
      yield {
        type: 'adapter:tool_call',
        providerId: 'codex',
        toolName: 'dangerous',
        input: {},
        timestamp: Date.now(),
      }
    }
    await collectEvents(guardrails.wrap(fakeSource()))

    expect(preExisting).toHaveBeenCalledOnce()
    const violations = received.filter((e) => e.type === 'governance:rule_violation')
    expect(violations).toHaveLength(1)
  })

  it('validateAndEmitRules emits one governance:rule_violation per reported violation', () => {
    const fakeRules = [{ id: 'r1' }, { id: 'r2' }]
    const fakeContext = { providerId: 'codex' as const }
    const validator = vi.fn(() => [
      { ruleId: 'r1', severity: 'warn' as const, detail: 'r1 warn' },
      { ruleId: 'r2', severity: 'block' as const, detail: 'r2 block' },
    ])

    const result = adapter.validateAndEmitRules(fakeRules, fakeContext, validator, {
      runId: 'compile-run',
    })

    expect(validator).toHaveBeenCalledOnce()
    expect(result).toHaveLength(2)
    const violations = received.filter((e) => e.type === 'governance:rule_violation')
    expect(violations).toHaveLength(2)
    if (
      violations[0]?.type === 'governance:rule_violation' &&
      violations[1]?.type === 'governance:rule_violation'
    ) {
      expect(violations[0].ruleId).toBe('r1')
      expect(violations[0].severity).toBe('warn')
      expect(violations[0].runId).toBe('compile-run')
      expect(violations[1].ruleId).toBe('r2')
      expect(violations[1].severity).toBe('block')
    }
  })

  it('validateAndEmitRules emits a rule_compile_error event when the validator throws', () => {
    const validator = vi.fn(() => {
      throw new Error('boom')
    })
    const result = adapter.validateAndEmitRules([], {}, validator, {
      runId: 'compile-run',
    })
    expect(result).toHaveLength(0)
    const violations = received.filter((e) => e.type === 'governance:rule_violation')
    expect(violations).toHaveLength(1)
    if (violations[0]?.type === 'governance:rule_violation') {
      expect(violations[0].ruleId).toBe('rule_compile_error')
      expect(violations[0].severity).toBe('block')
    }
  })

  it('emitRuleViolation uses the current run context when called mid-execute', async () => {
    const guardrails = new AdapterGuardrails({ blockedTools: ['dangerous'] })
    adapter.attachGuardrailsGovernance(guardrails)

    mockSpawn([
      { type: 'completed' },
    ])
    // Start the adapter and, during the run, trigger a rule violation via
    // the guardrails path. Here we simulate by calling emitRuleViolation
    // directly once run context is populated.
    const gen = adapter.execute({ prompt: 'go', correlationId: 'run-xyz' })
    // Drain one event to let execute() enter the run context
    await gen.next()
    adapter.emitRuleViolation({
      ruleId: 'inline',
      severity: 'warn',
      detail: 'mid-run',
    })
    // Drain the rest
    await collectEvents(
      (async function* () {
        for await (const e of gen) yield e
      })(),
    )
    const violations = received.filter((e) => e.type === 'governance:rule_violation')
    const inline = violations.find(
      (v) => v.type === 'governance:rule_violation' && v.ruleId === 'inline',
    )
    expect(inline).toBeDefined()
    if (inline && inline.type === 'governance:rule_violation') {
      expect(inline.runId).toBe('run-xyz')
    }
  })
})
