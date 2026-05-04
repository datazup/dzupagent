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

  it('is a no-op when no adapters are registered', () => {
    const pipeline = new PolicyEnforcementPipeline(registry)
    const input: AgentInput = { prompt: 'hi' }
    const policy: AdapterPolicy = { sandboxMode: 'workspace-write', maxTurns: 5 }

    pipeline.applyPolicyOverrides(input, undefined, policy)

    expect(input.maxTurns).toBeUndefined()
  })

  it('applies compiled adapter config to the target adapter', () => {
    const adapter = createMockAdapter('codex' as AdapterProviderId)
    registry.register(adapter)
    const pipeline = new PolicyEnforcementPipeline(registry)
    const input: AgentInput = { prompt: 'hi' }
    const policy: AdapterPolicy = { sandboxMode: 'workspace-write' }

    pipeline.applyPolicyOverrides(input, 'codex' as AdapterProviderId, policy)

    expect(adapter.__configured.length).toBeGreaterThan(0)
    expect(adapter.__configured[0]).toEqual(
      expect.objectContaining({ sandboxMode: 'workspace-write' }),
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
})
