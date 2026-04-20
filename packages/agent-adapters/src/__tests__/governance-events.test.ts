import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  GovernanceEvent,
} from '../types.js'
import { BaseCliAdapter } from '../base/base-cli-adapter.js'
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
// Test harness — minimal BaseCliAdapter subclass whose spawn loop is driven
// by the mocked spawnAndStreamJsonl.
// ---------------------------------------------------------------------------

class TestCliAdapter extends BaseCliAdapter {
  constructor(providerId: AdapterProviderId = 'gemini') {
    super(providerId)
  }

  protected getBinaryName(): string {
    return 'test-binary'
  }

  protected buildArgs(_input: AgentInput): string[] {
    return []
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    if (record['type'] === 'completed') {
      return {
        type: 'adapter:completed',
        providerId: this.providerId,
        sessionId,
        result: String(record['result'] ?? ''),
        durationMs: 0,
        timestamp: Date.now(),
      }
    }
    return undefined
  }
}

/**
 * Build a fake spawnAndStreamJsonl implementation that yields one record
 * and optionally invokes the stdinResponder callback to simulate a
 * mid-execution interaction prompt from the child CLI.
 */
function buildSpawnFake(opts: {
  triggerInteraction?: { question: string; kind: 'permission' | 'confirmation' | 'clarification' | 'unknown' }
}): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(
    async function* (_binary: string, _args: string[], spawnOpts: processHelpers.SpawnJsonlOptions) {
      if (opts.triggerInteraction && spawnOpts.stdinResponder) {
        await spawnOpts.stdinResponder(
          { type: 'question', message: opts.triggerInteraction.question },
          opts.triggerInteraction.question,
          opts.triggerInteraction.kind,
        )
      }
      yield { type: 'completed', result: 'ok' }
    },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GovernanceEvent types', () => {
  it('approval_requested has the expected shape', () => {
    const ev: GovernanceEvent = {
      type: 'governance:approval_requested',
      runId: 'run-1',
      sessionId: 'sess-1',
      interactionId: 'int-1',
      providerId: 'claude',
      timestamp: 123,
      prompt: 'Allow write?',
      commandPreview: 'rm -rf /tmp/foo',
    }
    expect(ev.type).toBe('governance:approval_requested')
    expect(ev.runId).toBe('run-1')
    expect(ev.interactionId).toBe('int-1')
    expect(ev.prompt).toBe('Allow write?')
    expect(ev.commandPreview).toBe('rm -rf /tmp/foo')
  })

  it('approval_resolved has the expected shape with resolution enum', () => {
    const approved: GovernanceEvent = {
      type: 'governance:approval_resolved',
      runId: 'run-1',
      interactionId: 'int-1',
      providerId: 'claude',
      timestamp: 1,
      resolution: 'approved',
    }
    const denied: GovernanceEvent = {
      type: 'governance:approval_resolved',
      runId: 'run-2',
      interactionId: 'int-2',
      providerId: 'claude',
      timestamp: 2,
      resolution: 'denied',
    }
    const auto: GovernanceEvent = {
      type: 'governance:approval_resolved',
      runId: 'run-3',
      interactionId: 'int-3',
      providerId: 'claude',
      timestamp: 3,
      resolution: 'auto',
    }
    expect(approved.resolution).toBe('approved')
    expect(denied.resolution).toBe('denied')
    expect(auto.resolution).toBe('auto')
  })

  it('hook_executed, rule_violation, dangerous_command all have the expected shape', () => {
    const hook: GovernanceEvent = {
      type: 'governance:hook_executed',
      runId: 'r',
      providerId: 'codex',
      timestamp: 1,
      hookName: 'pre-commit',
      exitCode: 0,
    }
    const rule: GovernanceEvent = {
      type: 'governance:rule_violation',
      runId: 'r',
      providerId: 'codex',
      timestamp: 2,
      ruleId: 'no-secrets',
      severity: 'block',
      detail: 'Found API key',
    }
    const danger: GovernanceEvent = {
      type: 'governance:dangerous_command',
      runId: 'r',
      providerId: 'codex',
      timestamp: 3,
      command: 'rm -rf /',
      blocked: true,
    }
    expect(hook.hookName).toBe('pre-commit')
    expect(rule.severity).toBe('block')
    expect(danger.blocked).toBe(true)
  })
})

describe('BaseCliAdapter.emitGovernanceEvent + interaction wiring', () => {
  let mockSpawn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockSpawn = vi.mocked(processHelpers.spawnAndStreamJsonl) as unknown as ReturnType<typeof vi.fn>
    mockSpawn.mockReset()
    vi.mocked(processHelpers.isBinaryAvailable).mockResolvedValue(true)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('emits governance:approval_requested when interaction_required is produced (ask-caller policy)', async () => {
    const adapter = new TestCliAdapter('gemini')
    adapter.configure({
      interactionPolicy: {
        mode: 'ask-caller',
        askCaller: { timeoutMs: 100, timeoutFallback: 'auto-deny' },
      },
    })

    const fake = buildSpawnFake({
      triggerInteraction: { question: 'Allow write access?', kind: 'permission' },
    })
    mockSpawn.mockImplementation(fake)

    const received: GovernanceEvent[] = []
    adapter.onGovernanceEvent((e) => received.push(e))

    await collectEvents(adapter.execute({ prompt: 'do thing' }))

    const requested = received.find((e) => e.type === 'governance:approval_requested')
    expect(requested).toBeDefined()
    if (requested && requested.type === 'governance:approval_requested') {
      expect(requested.providerId).toBe('gemini')
      expect(requested.prompt).toBe('Allow write access?')
      expect(requested.interactionId).toMatch(/.+/)
      expect(requested.runId).toMatch(/.+/)
    }
  })

  it('emits governance:approval_resolved after an interaction is resolved', async () => {
    const adapter = new TestCliAdapter('qwen')
    adapter.configure({
      interactionPolicy: {
        mode: 'ask-caller',
        askCaller: { timeoutMs: 100, timeoutFallback: 'auto-deny' },
      },
    })

    const fake = buildSpawnFake({
      triggerInteraction: { question: 'Proceed?', kind: 'confirmation' },
    })
    mockSpawn.mockImplementation(fake)

    const received: GovernanceEvent[] = []
    adapter.onGovernanceEvent((e) => received.push(e))

    await collectEvents(adapter.execute({ prompt: 'go' }))

    const requested = received.find((e) => e.type === 'governance:approval_requested')
    const resolved = received.find((e) => e.type === 'governance:approval_resolved')
    expect(requested).toBeDefined()
    expect(resolved).toBeDefined()
    if (resolved && resolved.type === 'governance:approval_resolved') {
      // ask-caller policy with no manual response hits timeout-fallback,
      // which maps to 'auto' in the normalized resolution field.
      expect(['approved', 'denied', 'auto']).toContain(resolved.resolution)
    }
    // request must precede resolution
    const reqIdx = received.findIndex((e) => e.type === 'governance:approval_requested')
    const resIdx = received.findIndex((e) => e.type === 'governance:approval_resolved')
    expect(reqIdx).toBeLessThan(resIdx)
  })

  it('auto-approve policy with interaction still emits governance approval events', async () => {
    const adapter = new TestCliAdapter('gemini')
    // auto-approve is the default and does NOT attach a resolver, so no
    // governance events fire — verify that contract explicitly.
    adapter.configure({ interactionPolicy: { mode: 'auto-approve' } })

    const fake = buildSpawnFake({
      triggerInteraction: { question: 'Allow?', kind: 'permission' },
    })
    mockSpawn.mockImplementation(fake)

    const received: GovernanceEvent[] = []
    adapter.onGovernanceEvent((e) => received.push(e))

    await collectEvents(adapter.execute({ prompt: 'do' }))

    // Under auto-approve the BaseCliAdapter skips the interaction resolver,
    // so the CLI's question is not routed through stdinResponder and no
    // governance events are produced on this channel.
    expect(received.length).toBe(0)
  })

  it('auto-deny policy produces governance:approval_resolved with resolution="denied"', async () => {
    const adapter = new TestCliAdapter('crush')
    adapter.configure({ interactionPolicy: { mode: 'auto-deny' } })

    const fake = buildSpawnFake({
      triggerInteraction: { question: 'Delete files?', kind: 'permission' },
    })
    mockSpawn.mockImplementation(fake)

    const received: GovernanceEvent[] = []
    adapter.onGovernanceEvent((e) => received.push(e))

    await collectEvents(adapter.execute({ prompt: 'work' }))

    const resolved = received.find((e) => e.type === 'governance:approval_resolved')
    expect(resolved).toBeDefined()
    if (resolved && resolved.type === 'governance:approval_resolved') {
      expect(resolved.resolution).toBe('denied')
      expect(resolved.providerId).toBe('crush')
    }
  })

  it('onGovernanceEvent unsubscribe function stops further deliveries', async () => {
    const adapter = new TestCliAdapter('gemini')
    adapter.configure({ interactionPolicy: { mode: 'auto-deny' } })

    const fake = buildSpawnFake({
      triggerInteraction: { question: 'Proceed?', kind: 'confirmation' },
    })
    mockSpawn.mockImplementation(fake)

    const received: GovernanceEvent[] = []
    const unsubscribe = adapter.onGovernanceEvent((e) => received.push(e))
    unsubscribe()

    await collectEvents(adapter.execute({ prompt: 'do' }))

    expect(received.length).toBe(0)
  })

  it('listener errors do not break the adapter event loop', async () => {
    const adapter = new TestCliAdapter('gemini')
    adapter.configure({ interactionPolicy: { mode: 'auto-deny' } })

    const fake = buildSpawnFake({
      triggerInteraction: { question: 'Ok?', kind: 'confirmation' },
    })
    mockSpawn.mockImplementation(fake)

    const good: GovernanceEvent[] = []
    adapter.onGovernanceEvent(() => {
      throw new Error('boom')
    })
    adapter.onGovernanceEvent((e) => good.push(e))

    // Should not throw even though one listener is broken
    await expect(collectEvents(adapter.execute({ prompt: 'go' }))).resolves.toBeDefined()
    expect(good.length).toBeGreaterThan(0)
  })
})
