/**
 * Tests for CostAwareRouter with 3-tier complexity scoring.
 */
import { describe, it, expect, vi } from 'vitest'
import { CostAwareRouter, isSimpleTurn, scoreComplexity } from '../router/cost-aware-router.js'
import type { IntentRouter } from '../router/intent-router.js'

function createMockIntentRouter(intent = 'chat'): IntentRouter {
  return {
    classify: vi.fn(async () => ({ intent, confidence: 'keyword' as const })),
  } as unknown as IntentRouter
}

describe('isSimpleTurn', () => {
  it('returns true for short, simple messages', () => {
    expect(isSimpleTurn('Hello')).toBe(true)
    expect(isSimpleTurn('What is this?')).toBe(true)
    expect(isSimpleTurn('How are you?')).toBe(true)
  })

  it('returns false for long messages', () => {
    expect(isSimpleTurn('a'.repeat(201))).toBe(false)
  })

  it('returns false for messages with code blocks', () => {
    expect(isSimpleTurn('Use ```code``` here')).toBe(false)
  })

  it('returns false for messages with URLs', () => {
    expect(isSimpleTurn('Check https://example.com')).toBe(false)
  })

  it('returns false for messages with complexity keywords', () => {
    expect(isSimpleTurn('implement a feature')).toBe(false)
    expect(isSimpleTurn('debug this issue')).toBe(false)
  })

  it('returns false for multiline messages', () => {
    expect(isSimpleTurn('line 1\nline 2')).toBe(false)
  })
})

describe('scoreComplexity', () => {
  it('returns simple for short messages', () => {
    expect(scoreComplexity('Hello')).toBe('simple')
    expect(scoreComplexity('What time is it?')).toBe('simple')
  })

  it('returns moderate for code-related messages', () => {
    expect(scoreComplexity('implement a new login feature')).toBe('moderate')
    expect(scoreComplexity('fix the bug in the API endpoint')).toBe('moderate')
  })

  it('returns complex for architecture/analysis messages', () => {
    expect(scoreComplexity('architect a new system design for the distributed cache with trade-off analysis')).toBe('complex')
  })

  it('returns complex for long multi-line messages with reasoning keywords', () => {
    const longMessage = [
      'We need to evaluate the scaling strategy for our service.',
      'Consider the current architecture:',
      '- Service A talks to Service B',
      '- Service B uses Redis',
      '- Service C is the gateway',
      'What are the trade-offs?',
    ].join('\n')
    expect(scoreComplexity(longMessage)).toBe('complex')
  })

  it('returns complex for very long multi-line messages', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: ${'content '.repeat(20)}`)
    expect(scoreComplexity(lines.join('\n'))).toBe('complex')
  })

  it('returns moderate for short message with complexity keyword', () => {
    expect(scoreComplexity('implement the evaluate function')).toBe('moderate')
  })
})

describe('CostAwareRouter', () => {
  it('routes simple messages to chat tier', async () => {
    const router = new CostAwareRouter({
      intentRouter: createMockIntentRouter(),
    })
    const result = await router.classify('Hello')
    expect(result.modelTier).toBe('chat')
    expect(result.routingReason).toBe('simple_turn')
    expect(result.complexity).toBe('simple')
  })

  it('routes code messages to codegen tier', async () => {
    const router = new CostAwareRouter({
      intentRouter: createMockIntentRouter(),
    })
    const result = await router.classify('implement user authentication with JWT')
    expect(result.modelTier).toBe('codegen')
    expect(result.routingReason).toBe('complex_turn')
    expect(result.complexity).toBe('moderate')
  })

  it('routes reasoning messages to reasoning tier', async () => {
    const router = new CostAwareRouter({
      intentRouter: createMockIntentRouter(),
    })
    const result = await router.classify(
      'architect a new system design and evaluate the trade-off between consistency and availability',
    )
    expect(result.modelTier).toBe('reasoning')
    expect(result.routingReason).toBe('reasoning_turn')
    expect(result.complexity).toBe('complex')
  })

  it('respects forceExpensiveIntents', async () => {
    const router = new CostAwareRouter({
      intentRouter: createMockIntentRouter('generate_feature'),
      forceExpensiveIntents: ['generate_feature'],
    })
    const result = await router.classify('Hello')
    expect(result.modelTier).toBe('codegen')
    expect(result.routingReason).toBe('forced')
  })

  it('respects forceReasoningIntents', async () => {
    const router = new CostAwareRouter({
      intentRouter: createMockIntentRouter('review_architecture'),
      forceReasoningIntents: ['review_architecture'],
    })
    const result = await router.classify('Hello')
    expect(result.modelTier).toBe('reasoning')
    expect(result.routingReason).toBe('forced')
    expect(result.complexity).toBe('complex')
  })

  it('forceReasoningIntents takes precedence over forceExpensiveIntents', async () => {
    const router = new CostAwareRouter({
      intentRouter: createMockIntentRouter('analyze'),
      forceExpensiveIntents: ['analyze'],
      forceReasoningIntents: ['analyze'],
    })
    const result = await router.classify('Hello')
    expect(result.modelTier).toBe('reasoning')
  })

  it('uses custom tier names', async () => {
    const router = new CostAwareRouter({
      intentRouter: createMockIntentRouter(),
      cheapTier: 'embedding',
      expensiveTier: 'chat',
      reasoningTier: 'codegen',
    })
    const result = await router.classify('Hello')
    expect(result.modelTier).toBe('embedding')
  })
})
