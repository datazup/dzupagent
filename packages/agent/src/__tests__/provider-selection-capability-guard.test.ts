/**
 * DZUPAGENT-AGENT-C-06 — capability- and vendor-gated provider failover.
 *
 * Before this fix `getProviderAttempts` called
 * `registry.getModelFallbackCandidates(tier)` with no requirements at all, so a
 * tool-calling run could fail over onto a tier peer that does not support tool
 * calling and silently degrade to prose. `shouldRunFailover` likewise had no
 * vendor/trust gate, so a transcript could be replayed verbatim to a different
 * vendor on a 429.
 *
 * Covers:
 *   - requirements are derived from the bound tool set and threaded into the
 *     registry
 *   - a tool-calling run whose chain has no tool-capable model raises
 *     NO_CAPABLE_FALLBACK instead of returning a degraded chain
 *   - the same failure surfaces out of `DzupAgent.generate()` (end to end)
 *   - un-annotated registries keep working under the default 'declared' guard,
 *     and are rejected under 'strict'
 *   - `capabilityGuard: 'off'` restores the pre-C-06 behaviour
 *   - the cross-vendor allowlist drops unapproved providers and emits an
 *     auditable `provider:fallback_blocked` event
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ModelSpec, LLMProviderConfig, ModelOverrides } from '@dzupagent/core/llm'
import { ModelRegistry } from '@dzupagent/core'
import { ForgeError } from '@dzupagent/core'
import {
  deriveFallbackRequirements,
  getProviderAttempts,
} from '../agent/provider-selection.js'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'
import { makeMockTool, makeMockEventBus } from './test-utils.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubModel(): BaseChatModel {
  return {
    invoke: vi.fn(async () => new AIMessage('ok')),
    bindTools: vi.fn().mockReturnThis(),
  } as unknown as BaseChatModel
}

/**
 * Real ModelRegistry with a stub factory — the point of these tests is the
 * registry's own guard, so the model instances are irrelevant.
 */
function registryWith(
  ...providers: Array<{ name: string; priority: number; chat: ModelSpec }>
): ModelRegistry {
  const registry = new ModelRegistry()
  registry.setFactory(
    (_p: LLMProviderConfig, _s: ModelSpec, _o?: ModelOverrides) => stubModel(),
  )
  for (const p of providers) {
    registry.addProvider({
      provider: p.name,
      apiKey: `key-${p.name}`,
      priority: p.priority,
      models: { chat: p.chat },
    })
  }
  return registry
}

function baseConfig(overrides: Partial<DzupAgentConfig> = {}): DzupAgentConfig {
  return {
    id: 'c06-agent',
    instructions: 'test',
    model: 'chat',
    providerFailover: { enabled: true, maxAttempts: 3 },
    ...overrides,
  }
}

const toolCapable = (name: string): ModelSpec => ({
  name,
  maxTokens: 1024,
  capabilities: ['tool_use', 'streaming'],
})
const textOnly = (name: string): ModelSpec => ({
  name,
  maxTokens: 1024,
  capabilities: ['streaming'],
})

// ---------------------------------------------------------------------------
// Requirement derivation
// ---------------------------------------------------------------------------

describe('deriveFallbackRequirements (C-06)', () => {
  it('requires tool_use when the run has bound tools', () => {
    const reqs = deriveFallbackRequirements(baseConfig(), [makeMockTool('t')])
    expect(reqs?.requiredCapabilities).toContain('tool_use')
    // Default guard is 'declared': un-annotated specs are not punished.
    expect(reqs?.undeclaredCapabilityPolicy).toBe('allow')
  })

  it('requires nothing when the run has no tools and no budget', () => {
    expect(deriveFallbackRequirements(baseConfig(), [])).toBeUndefined()
  })

  it('derives minContextWindow from the message budget', () => {
    const reqs = deriveFallbackRequirements(
      baseConfig({ messageConfig: { maxMessageTokens: 120_000 } }),
      [],
    )
    expect(reqs?.minContextWindow).toBe(120_000)
  })

  it('merges the host-supplied requirements (the only way to express vision)', () => {
    const reqs = deriveFallbackRequirements(
      baseConfig({
        providerFailover: {
          enabled: true,
          capabilityRequirements: { requiredCapabilities: ['vision'] },
        },
      }),
      [makeMockTool('t')],
    )
    expect(reqs?.requiredCapabilities).toEqual(
      expect.arrayContaining(['vision', 'tool_use']),
    )
  })

  it("guard 'strict' makes an undeclared capability set disqualifying", () => {
    const reqs = deriveFallbackRequirements(
      baseConfig({ providerFailover: { enabled: true, capabilityGuard: 'strict' } }),
      [makeMockTool('t')],
    )
    expect(reqs?.undeclaredCapabilityPolicy).toBe('skip')
  })

  it("guard 'off' disables the guard entirely (pre-C-06 behaviour)", () => {
    const reqs = deriveFallbackRequirements(
      baseConfig({ providerFailover: { enabled: true, capabilityGuard: 'off' } }),
      [makeMockTool('t')],
    )
    expect(reqs).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Chain construction
// ---------------------------------------------------------------------------

describe('getProviderAttempts — capability guard (C-06)', () => {
  it('drops a non-tool-calling peer from a tool-calling run chain', () => {
    const registry = registryWith(
      { name: 'anthropic', priority: 1, chat: toolCapable('claude') },
      { name: 'openai', priority: 2, chat: textOnly('text-only') },
      { name: 'openrouter', priority: 3, chat: toolCapable('gpt-4o-mini') },
    )

    const attempts = getProviderAttempts({
      config: baseConfig({ registry }),
      resolvedTier: 'chat',
      resolvedProvider: 'anthropic',
      tools: [makeMockTool('git_status')],
    })

    expect(attempts.map((a) => a.provider)).toEqual(['anthropic', 'openrouter'])
  })

  it('refuses to build a chain when no candidate supports tool calling', () => {
    const registry = registryWith(
      { name: 'openai', priority: 1, chat: textOnly('text-a') },
      { name: 'openrouter', priority: 2, chat: textOnly('text-b') },
    )

    let caught: unknown
    try {
      getProviderAttempts({
        config: baseConfig({ registry }),
        resolvedTier: 'chat',
        tools: [makeMockTool('git_status')],
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ForgeError)
    expect((caught as ForgeError).code).toBe('NO_CAPABLE_FALLBACK')
  })

  it('leaves un-annotated registries alone under the default guard', () => {
    const registry = registryWith(
      { name: 'anthropic', priority: 1, chat: { name: 'a', maxTokens: 1024 } },
      { name: 'openai', priority: 2, chat: { name: 'b', maxTokens: 1024 } },
    )

    const attempts = getProviderAttempts({
      config: baseConfig({ registry }),
      resolvedTier: 'chat',
      tools: [makeMockTool('git_status')],
    })
    expect(attempts).toHaveLength(2)
  })

  it("rejects the same un-annotated registry under guard 'strict'", () => {
    const registry = registryWith(
      { name: 'anthropic', priority: 1, chat: { name: 'a', maxTokens: 1024 } },
    )

    expect(() =>
      getProviderAttempts({
        config: baseConfig({
          registry,
          providerFailover: { enabled: true, capabilityGuard: 'strict' },
        }),
        resolvedTier: 'chat',
        tools: [makeMockTool('git_status')],
      }),
    ).toThrow(expect.objectContaining({ code: 'NO_CAPABLE_FALLBACK' }))
  })

  it("guard 'off' still yields the degraded chain (opt-out escape hatch)", () => {
    const registry = registryWith(
      { name: 'anthropic', priority: 1, chat: toolCapable('claude') },
      { name: 'openai', priority: 2, chat: textOnly('text-only') },
    )

    const attempts = getProviderAttempts({
      config: baseConfig({
        registry,
        providerFailover: { enabled: true, capabilityGuard: 'off' },
      }),
      resolvedTier: 'chat',
      tools: [makeMockTool('git_status')],
    })
    expect(attempts.map((a) => a.provider)).toEqual(['anthropic', 'openai'])
  })
})

// ---------------------------------------------------------------------------
// Cross-vendor allowlist
// ---------------------------------------------------------------------------

describe('getProviderAttempts — cross-vendor allowlist (C-06)', () => {
  it('blocks a hop to a vendor outside the allowlist and emits an audit event', () => {
    const registry = registryWith(
      { name: 'anthropic', priority: 1, chat: toolCapable('claude') },
      { name: 'openai', priority: 2, chat: toolCapable('gpt-4o') },
      { name: 'openrouter', priority: 3, chat: toolCapable('mixtral') },
    )
    const eventBus = makeMockEventBus()

    const attempts = getProviderAttempts({
      config: baseConfig({
        registry,
        eventBus,
        providerFailover: {
          enabled: true,
          maxAttempts: 3,
          approvedFallbackProviders: ['openai'],
        },
      }),
      resolvedTier: 'chat',
      resolvedProvider: 'anthropic',
      tenantId: 'tenant-42',
      tools: [makeMockTool('git_status')],
    })

    // Home provider + explicitly approved vendor only.
    expect(attempts.map((a) => a.provider)).toEqual(['anthropic', 'openai'])

    const blocked = eventBus.emit.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e['type'] === 'provider:fallback_blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]).toMatchObject({
      provider: 'openrouter',
      reason: 'vendor-not-approved',
      tenantId: 'tenant-42',
      agentId: 'c06-agent',
    })
  })

  it('leaves the chain untouched when no allowlist is configured', () => {
    const registry = registryWith(
      { name: 'anthropic', priority: 1, chat: toolCapable('claude') },
      { name: 'openai', priority: 2, chat: toolCapable('gpt-4o') },
    )
    const eventBus = makeMockEventBus()

    const attempts = getProviderAttempts({
      config: baseConfig({ registry, eventBus }),
      resolvedTier: 'chat',
      resolvedProvider: 'anthropic',
      tools: [makeMockTool('git_status')],
    })

    expect(attempts.map((a) => a.provider)).toEqual(['anthropic', 'openai'])
    expect(
      eventBus.emit.mock.calls.filter(
        (c) => (c[0] as { type?: string }).type === 'provider:fallback_blocked',
      ),
    ).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// End to end through the agent
// ---------------------------------------------------------------------------

describe('DzupAgent — tool-calling run refuses an incapable failover (C-06)', () => {
  it('surfaces NO_CAPABLE_FALLBACK from generate() instead of degrading', async () => {
    // Both providers can be *selected* (construction-time selection is
    // unchanged), but neither declares tool_use — so the same-run failover
    // chain for a tool-bearing run cannot be built.
    const registry = registryWith(
      { name: 'openai', priority: 1, chat: textOnly('text-a') },
      { name: 'openrouter', priority: 2, chat: textOnly('text-b') },
    )

    const agent = new DzupAgent(
      baseConfig({
        registry,
        tools: [makeMockTool('git_status')],
      }),
    )

    await expect(agent.generate([new HumanMessage('hi')])).rejects.toThrow(
      /NO_CAPABLE_FALLBACK|satisfies the required capabilities/,
    )
  })
})
