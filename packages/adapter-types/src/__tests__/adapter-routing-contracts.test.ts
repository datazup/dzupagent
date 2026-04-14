import { describe, expect, it } from 'vitest'
import type {
  AdapterProviderId,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '../index.js'

class PreferredFirstRouter implements TaskRoutingStrategy {
  readonly name = 'preferred-first'

  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision {
    if (task.preferredProvider && availableProviders.includes(task.preferredProvider)) {
      return {
        provider: task.preferredProvider,
        reason: 'Preferred provider is available',
        confidence: 0.95,
      }
    }

    return {
      provider: 'auto',
      reason: 'Preferred provider unavailable, deferring to auto selection',
      confidence: 0.7,
      fallbackProviders: availableProviders,
    }
  }
}

describe('routing contracts', () => {
  it('honors preferred provider when available', () => {
    const strategy = new PreferredFirstRouter()
    const task: TaskDescriptor = {
      prompt: 'Review this pull request',
      tags: ['review', 'code'],
      preferredProvider: 'codex',
      requiresReasoning: true,
      budgetConstraint: 'medium',
    }

    const decision = strategy.route(task, ['claude', 'codex'])

    expect(decision.provider).toBe('codex')
    expect(decision.reason).toContain('Preferred provider')
    expect(decision.confidence).toBeGreaterThan(0.9)
    expect(decision.fallbackProviders).toBeUndefined()
  })

  it('returns auto with fallback providers when preference cannot be honored', () => {
    const strategy = new PreferredFirstRouter()
    const task: TaskDescriptor = {
      prompt: 'Summarize these logs',
      tags: ['summary'],
      preferredProvider: 'openrouter',
      requiresExecution: false,
      budgetConstraint: 'low',
    }

    const decision = strategy.route(task, ['claude', 'qwen', 'goose'])

    expect(decision.provider).toBe('auto')
    expect(decision.fallbackProviders).toEqual(['claude', 'qwen', 'goose'])
    expect(decision.confidence).toBeLessThan(0.8)
  })
})

