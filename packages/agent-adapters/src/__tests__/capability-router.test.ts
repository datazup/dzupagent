import { describe, it, expect, beforeEach } from 'vitest'

import { CapabilityRouter } from '../registry/capability-router.js'
import type { ProviderCapability } from '../registry/capability-router.js'
import type { AdapterProviderId, TaskDescriptor } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_PROVIDERS: AdapterProviderId[] = ['claude', 'codex', 'gemini', 'qwen', 'crush']

function makeTask(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    prompt: 'test prompt',
    tags: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CapabilityRouter', () => {
  let router: CapabilityRouter

  beforeEach(() => {
    router = new CapabilityRouter()
  })

  describe('routing by task type', () => {
    it('routes reasoning tasks to claude', () => {
      const task = makeTask({
        tags: ['review'],
        requiresReasoning: true,
      })

      const decision = router.route(task, ALL_PROVIDERS)

      expect(decision.provider).toBe('claude')
      expect(decision.confidence).toBeGreaterThan(0)
    })

    it('routes execution tasks to codex', () => {
      const task = makeTask({
        tags: ['implement'],
        requiresExecution: true,
      })

      const decision = router.route(task, ALL_PROVIDERS)

      expect(decision.provider).toBe('codex')
    })

    it('routes long-context tasks to gemini', () => {
      const task = makeTask({
        tags: ['large-codebase'],
      })

      const decision = router.route(task, ALL_PROVIDERS)

      // 'large-codebase' maps to 'long-context' which is a required tag.
      // Only gemini has 'long-context' capability.
      expect(decision.provider).toBe('gemini')
    })

    it('routes multilingual tasks to qwen', () => {
      const task = makeTask({
        tags: ['translate'],
      })

      const decision = router.route(task, ALL_PROVIDERS)

      // 'translate' maps to 'multilingual', qwen has it
      expect(decision.provider).toBe('qwen')
    })

    it('routes local/offline tasks to crush', () => {
      const task = makeTask({
        tags: ['offline'],
      })

      const decision = router.route(task, ALL_PROVIDERS)

      // 'offline' maps to 'local' which is a required tag; crush has it
      expect(decision.provider).toBe('crush')
    })

    it('routes budget tasks to cost-effective provider', () => {
      const task = makeTask({
        tags: ['budget'],
        budgetConstraint: 'low',
      })

      const decision = router.route(task, ALL_PROVIDERS)

      // 'budget' maps to 'cost-effective', crush has highest costEfficiency (1.0)
      // and 'cost-effective' tag
      expect(decision.provider).toBe('crush')
    })
  })

  describe('preferredProvider', () => {
    it('respects preferredProvider when available', () => {
      const task = makeTask({
        tags: ['review'],
        requiresReasoning: true,
        preferredProvider: 'gemini',
      })

      const decision = router.route(task, ALL_PROVIDERS)

      expect(decision.provider).toBe('gemini')
      expect(decision.confidence).toBe(0.95)
      expect(decision.reason).toContain('Preferred provider')
    })

    it('falls back when preferred provider is not available', () => {
      const task = makeTask({
        tags: ['review'],
        requiresReasoning: true,
        preferredProvider: 'gemini',
      })

      // gemini not in available list
      const decision = router.route(task, ['claude', 'codex'])

      expect(decision.provider).not.toBe('gemini')
      // Should still pick the best scorer
      expect(decision.provider).toBe('claude')
    })
  })

  describe('empty providers', () => {
    it('returns auto with zero confidence when no providers available', () => {
      const task = makeTask({ tags: ['review'] })

      const decision = router.route(task, [])

      expect(decision.provider).toBe('auto')
      expect(decision.confidence).toBe(0)
      expect(decision.fallbackProviders).toEqual([])
    })
  })

  describe('multi-capability task', () => {
    it('scores correctly when task has multiple matching tags', () => {
      // A task that needs both reasoning AND execution
      const task = makeTask({
        tags: ['review', 'implement'],
        requiresReasoning: true,
        requiresExecution: true,
      })

      const decision = router.route(task, ALL_PROVIDERS)

      // Should still pick a winner (claude or codex depending on weights)
      expect(ALL_PROVIDERS).toContain(decision.provider)
      expect(decision.fallbackProviders).toBeDefined()
      expect(decision.fallbackProviders!.length).toBeGreaterThan(0)
    })
  })

  describe('confidence', () => {
    it('reflects score gap between top providers', () => {
      // A strongly differentiated task should yield higher confidence
      const strongTask = makeTask({
        tags: ['offline', 'local'],
        // Only crush satisfies 'local' requirement
      })

      const decision = router.route(strongTask, ALL_PROVIDERS)

      expect(decision.confidence).toBeGreaterThan(0.4)
    })

    it('returns moderate confidence for single provider', () => {
      const task = makeTask({ tags: [] })

      const decision = router.route(task, ['claude'])

      // Single provider: confidence = 0.7
      expect(decision.confidence).toBe(0.7)
    })
  })

  describe('getCapabilities', () => {
    it('returns default capability profile', () => {
      const cap = router.getCapabilities('claude')

      expect(cap.providerId).toBe('claude')
      expect(cap.maxContextTokens).toBe(200_000)
      expect(cap.reasoningStrength).toBe(0.95)
      expect(cap.capabilities.has('reasoning')).toBe(true)
    })

    it('throws for unknown provider', () => {
      expect(() =>
        router.getCapabilities('unknown' as AdapterProviderId),
      ).toThrow('No capability profile')
    })

    it('returns a copy (not mutable reference)', () => {
      const cap1 = router.getCapabilities('claude')
      cap1.capabilities.add('local')

      const cap2 = router.getCapabilities('claude')

      expect(cap2.capabilities.has('local')).toBe(false)
    })
  })

  describe('updateCapabilities', () => {
    it('modifies an existing provider profile', () => {
      router.updateCapabilities('claude', { reasoningStrength: 0.5 })

      const cap = router.getCapabilities('claude')
      expect(cap.reasoningStrength).toBe(0.5)
    })

    it('throws for unknown provider', () => {
      expect(() =>
        router.updateCapabilities('unknown' as AdapterProviderId, {
          reasoningStrength: 0.5,
        }),
      ).toThrow('No capability profile')
    })
  })

  describe('constructor overrides', () => {
    it('applies capability overrides from config', () => {
      const customRouter = new CapabilityRouter({
        capabilities: {
          claude: { reasoningStrength: 0.5 },
        },
      })

      const cap = customRouter.getCapabilities('claude')
      expect(cap.reasoningStrength).toBe(0.5)
      // Other fields should remain defaults
      expect(cap.maxContextTokens).toBe(200_000)
    })

    it('applies tag mapping overrides from config', () => {
      const customRouter = new CapabilityRouter({
        tagMappings: {
          'my-custom-tag': ['reasoning'],
        },
      })

      const task = makeTask({ tags: ['my-custom-tag'], requiresReasoning: true })
      const decision = customRouter.route(task, ALL_PROVIDERS)

      // Should route to claude (strongest reasoner)
      expect(decision.provider).toBe('claude')
    })
  })

  describe('name property', () => {
    it('returns capability-based', () => {
      expect(router.name).toBe('capability-based')
    })
  })
})
