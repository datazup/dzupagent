import { describe, it, expect, beforeEach } from 'vitest'
import { ForgeError } from '@dzupagent/core'

import { ProviderAdapterRegistry } from '../../registry/adapter-registry.js'
import { PolicyEnforcementPipeline } from '../policy-enforcement-pipeline.js'
import type { AdapterPolicy } from '../../policy/policy-compiler.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../../types.js'

function createMockAdapter(providerId: AdapterProviderId): AgentCLIAdapter & {
  __configured: Array<Record<string, unknown>>
} {
  const captured: Array<Record<string, unknown>> = []
  const adapter: AgentCLIAdapter = {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: 'sess',
        timestamp: Date.now(),
      }
    },
    async *resumeSession(
      _id: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      // empty
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure(opts: Record<string, unknown>) {
      captured.push(opts)
    },
  }
  return Object.assign(adapter, { __configured: captured })
}

describe('PolicyEnforcementPipeline', () => {
  let registry: ProviderAdapterRegistry

  beforeEach(() => {
    registry = new ProviderAdapterRegistry()
  })

  it('is a no-op when no policy is supplied', () => {
    const adapter = createMockAdapter('codex' as AdapterProviderId)
    registry.register(adapter)
    const pipeline = new PolicyEnforcementPipeline(registry)
    const input: AgentInput = { prompt: 'hi' }

    pipeline.applyPolicyOverrides(input, undefined, undefined)

    expect(adapter.__configured).toHaveLength(0)
    expect(input.maxTurns).toBeUndefined()
  })

  it('fails closed when policy is supplied without an explicit provider', () => {
    const pipeline = new PolicyEnforcementPipeline(registry)
    const input: AgentInput = { prompt: 'hi' }
    const policy: AdapterPolicy = { sandboxMode: 'workspace-write', maxTurns: 5 }

    expect(() => pipeline.applyPolicyOverrides(input, undefined, policy)).toThrow(ForgeError)
  })

  it('applies compiled adapter config as per-run input options (no adapter mutation)', () => {
    const adapter = createMockAdapter('codex' as AdapterProviderId)
    registry.register(adapter)
    const pipeline = new PolicyEnforcementPipeline(registry)
    const input: AgentInput = { prompt: 'hi' }
    const policy: AdapterPolicy = { sandboxMode: 'workspace-write' }

    pipeline.applyPolicyOverrides(input, 'codex' as AdapterProviderId, policy)

    expect(adapter.__configured).toHaveLength(0)
    expect(input.options).toEqual(
      expect.objectContaining({
        sandboxMode: 'workspace-write',
      }),
    )
  })

  it('merges compiled inputOptions into AgentInput.options', () => {
    const adapter = createMockAdapter('codex' as AdapterProviderId)
    registry.register(adapter)
    const pipeline = new PolicyEnforcementPipeline(registry)
    const input: AgentInput = { prompt: 'hi', options: { existing: true } }
    const policy: AdapterPolicy = { sandboxMode: 'workspace-write', approvalRequired: true }

    pipeline.applyPolicyOverrides(input, 'codex' as AdapterProviderId, policy)

    expect(input.options).toEqual(
      expect.objectContaining({
        existing: true,
      }),
    )
  })

  it('seeds maxTurns from compiled guardrails when not already set', () => {
    const adapter = createMockAdapter('codex' as AdapterProviderId)
    registry.register(adapter)
    const pipeline = new PolicyEnforcementPipeline(registry)
    const input: AgentInput = { prompt: 'hi' }
    const policy: AdapterPolicy = { maxTurns: 7 }

    pipeline.applyPolicyOverrides(input, 'codex' as AdapterProviderId, policy)

    expect(input.maxTurns).toBe(7)
  })

  it('preserves caller-supplied maxTurns over policy guardrails', () => {
    const adapter = createMockAdapter('codex' as AdapterProviderId)
    registry.register(adapter)
    const pipeline = new PolicyEnforcementPipeline(registry)
    const input: AgentInput = { prompt: 'hi', maxTurns: 99 }
    const policy: AdapterPolicy = { maxTurns: 7 }

    pipeline.applyPolicyOverrides(input, 'codex' as AdapterProviderId, policy)

    expect(input.maxTurns).toBe(99)
  })

  it('compileWithConformance throws on error-severity violations', () => {
    const adapter = createMockAdapter('codex' as AdapterProviderId)
    registry.register(adapter)
    const pipeline = new PolicyEnforcementPipeline(registry)
    // Conflicting allowed/blocked tools is flagged as an error by the
    // conformance checker, which should bubble up as a ForgeError.
    const policy: AdapterPolicy = {
      allowedTools: ['bash'],
      blockedTools: ['bash'],
    }

    expect(() => pipeline.compileWithConformance('codex' as AdapterProviderId, policy))
      .toThrow(ForgeError)
  })

  it('strict mode treats warning violations as blocking', () => {
    const adapter = createMockAdapter('gemini' as AdapterProviderId)
    registry.register(adapter)
    const pipeline = new PolicyEnforcementPipeline(registry)
    const policy: AdapterPolicy = { blockedTools: ['bash'] }

    expect(() => pipeline.compileWithConformance('gemini' as AdapterProviderId, policy))
      .toThrow(ForgeError)
  })

  it('warn-only mode allows warning-only violations', () => {
    const adapter = createMockAdapter('gemini' as AdapterProviderId)
    registry.register(adapter)
    const pipeline = new PolicyEnforcementPipeline(registry, undefined, 'warn-only')
    const input: AgentInput = { prompt: 'hi' }
    const policy: AdapterPolicy = { blockedTools: ['bash'], maxTurns: 3 }

    expect(() => pipeline.applyPolicyOverrides(input, 'gemini' as AdapterProviderId, policy))
      .not.toThrow()
    expect(input.maxTurns).toBe(3)
  })
})
