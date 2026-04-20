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
