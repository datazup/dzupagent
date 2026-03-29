import { describe, it, expect, beforeEach } from 'vitest'

import {
  ContextAwareRouter,
  ContextInjectionMiddleware,
} from '../context/context-aware-router.js'
import type {
  ContextInjection,
} from '../context/context-aware-router.js'
import type { AgentInput, TaskDescriptor } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(prompt: string, overrides?: Partial<TaskDescriptor>): TaskDescriptor {
  return {
    prompt,
    tags: [],
    ...overrides,
  }
}

function makeInput(prompt: string, overrides?: Partial<AgentInput>): AgentInput {
  return {
    prompt,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ContextAwareRouter tests
// ---------------------------------------------------------------------------

describe('ContextAwareRouter', () => {
  let router: ContextAwareRouter

  beforeEach(() => {
    router = new ContextAwareRouter()
  })

  describe('estimateContext', () => {
    it('returns a token estimate for a prompt', () => {
      // Default estimator: ~4 chars/token
      const input = makeInput('a'.repeat(400)) // ~100 tokens
      const estimate = router.estimateContext(input)

      expect(estimate.inputTokens).toBe(100)
      expect(estimate.outputTokens).toBe(4000) // default
      expect(estimate.totalTokens).toBe(4100)
      expect(estimate.fitsInContext).toBe(true)
    })

    it('includes system prompt in estimate', () => {
      const input = makeInput('a'.repeat(400), {
        systemPrompt: 'b'.repeat(400),
      })
      const estimate = router.estimateContext(input)

      expect(estimate.inputTokens).toBe(200) // 100 + 100
    })

    it('includes injections in estimate', () => {
      const input = makeInput('a'.repeat(400))
      const injections: ContextInjection[] = [
        { label: 'ctx', content: 'c'.repeat(400), priority: 1 },
      ]
      const estimate = router.estimateContext(input, injections)

      // 100 (prompt) + 100 (injection content) + label overhead + separator overhead
      expect(estimate.inputTokens).toBeGreaterThan(200)
    })
  })

  describe('route', () => {
    it('routes to provider with sufficient context window', () => {
      const task = makeTask('Simple question')
      const decision = router.route(task, ['claude', 'codex'])

      expect(decision.provider).toBe('claude') // claude is first in priority
      expect(decision.confidence).toBeGreaterThan(0)
    })

    it('routes to gemini for very large context', () => {
      // Create a prompt that exceeds claude's effective window (200k * 0.8 = 160k tokens)
      // At 4 chars/token, need >640k chars + 4000 output tokens
      const bigPrompt = 'x'.repeat(700_000) // ~175k tokens
      const task = makeTask(bigPrompt)

      const decision = router.route(task, ['claude', 'gemini'])

      // Total ~175k + 4k = 179k, claude effective = 160k -- doesn't fit
      // gemini effective = 800k -- fits
      expect(decision.provider).toBe('gemini')
    })

    it('filters out providers with insufficient context window', () => {
      // crush has 32k context, effective = 25.6k
      // Need a prompt > 25.6k - 4k = 21.6k tokens = 86.4k chars
      const mediumPrompt = 'x'.repeat(100_000) // ~25k tokens + 4k output = 29k
      const task = makeTask(mediumPrompt)

      const decision = router.route(task, ['crush', 'codex'])

      // crush can't handle it, codex (128k * 0.8 = 102.4k) can
      expect(decision.provider).toBe('codex')
    })

    it('applies safety margin', () => {
      const customRouter = new ContextAwareRouter({ safetyMargin: 0.5 })
      // claude: 200k * 0.5 = 100k effective
      const prompt = 'x'.repeat(400_000) // ~100k tokens + 4k output = 104k
      const task = makeTask(prompt)

      const decision = customRouter.route(task, ['claude', 'gemini'])

      // claude effective = 100k, total needed = 104k -- doesn't fit
      expect(decision.provider).toBe('gemini')
    })

    it('respects preferred provider when it fits', () => {
      const task = makeTask('Short question', {
        preferredProvider: 'codex',
      })

      const decision = router.route(task, ['claude', 'codex', 'gemini'])

      expect(decision.provider).toBe('codex')
      expect(decision.confidence).toBe(0.95)
    })

    it('returns auto when no providers available', () => {
      const task = makeTask('Question')
      const decision = router.route(task, [])

      expect(decision.provider).toBe('auto')
      expect(decision.confidence).toBe(0)
    })

    it('falls back to first available when nothing fits and gemini is unavailable', () => {
      // Huge prompt that nothing can handle
      const hugePrompt = 'x'.repeat(5_000_000) // ~1.25M tokens
      const task = makeTask(hugePrompt)

      const decision = router.route(task, ['claude', 'codex'])

      // No gemini available, falls back to first: claude
      expect(decision.provider).toBe('claude')
      expect(decision.confidence).toBeLessThan(0.4)
    })
  })

  describe('canHandle', () => {
    it('returns true when estimate fits', () => {
      const fits = router.canHandle('claude', {
        inputTokens: 1000,
        outputTokens: 4000,
        totalTokens: 5000,
        fitsInContext: true,
      })

      expect(fits).toBe(true)
    })

    it('returns false when estimate exceeds effective window', () => {
      const fits = router.canHandle('crush', {
        inputTokens: 30_000,
        outputTokens: 4000,
        totalTokens: 34_000,
        fitsInContext: true,
      })

      // crush effective = 32k * 0.8 = 25.6k
      expect(fits).toBe(false)
    })
  })

  describe('custom token estimator', () => {
    it('uses the custom estimator', () => {
      const custom = new ContextAwareRouter({
        tokenEstimator: (text) => text.length, // 1 char = 1 token
      })

      const input = makeInput('hello') // 5 chars = 5 tokens
      const estimate = custom.estimateContext(input)

      expect(estimate.inputTokens).toBe(5)
    })
  })
})

// ---------------------------------------------------------------------------
// ContextInjectionMiddleware tests
// ---------------------------------------------------------------------------

describe('ContextInjectionMiddleware', () => {
  describe('addInjection / clearInjections', () => {
    it('adds and clears injections', () => {
      const middleware = new ContextInjectionMiddleware()

      middleware.addInjection({ label: 'A', content: 'aaa', priority: 1 })
      middleware.addInjection({ label: 'B', content: 'bbb', priority: 2 })

      expect(middleware.getInjections()).toHaveLength(2)

      middleware.clearInjections()
      expect(middleware.getInjections()).toHaveLength(0)
    })

    it('sorts by priority descending', () => {
      const middleware = new ContextInjectionMiddleware()

      middleware.addInjection({ label: 'Low', content: 'l', priority: 1 })
      middleware.addInjection({ label: 'High', content: 'h', priority: 10 })
      middleware.addInjection({ label: 'Mid', content: 'm', priority: 5 })

      const sorted = middleware.getInjections()
      expect(sorted[0]!.label).toBe('High')
      expect(sorted[1]!.label).toBe('Mid')
      expect(sorted[2]!.label).toBe('Low')
    })
  })

  describe('apply', () => {
    it('prepends injected context to prompt by default', () => {
      const middleware = new ContextInjectionMiddleware()
      middleware.addInjection({ label: 'Context', content: 'Some context', priority: 1 })

      const input = makeInput('What is this?')
      const result = middleware.apply(input)

      expect(result.prompt).toContain('[Context]')
      expect(result.prompt).toContain('Some context')
      expect(result.prompt).toContain('What is this?')
      // Context should come before the prompt
      const contextIdx = result.prompt.indexOf('[Context]')
      const promptIdx = result.prompt.indexOf('What is this?')
      expect(contextIdx).toBeLessThan(promptIdx)
    })

    it('injects into system prompt when position is system', () => {
      const middleware = new ContextInjectionMiddleware({ position: 'system' })
      middleware.addInjection({ label: 'Sys', content: 'System info', priority: 1 })

      const input = makeInput('Question', { systemPrompt: 'Existing system' })
      const result = middleware.apply(input)

      expect(result.systemPrompt).toContain('Existing system')
      expect(result.systemPrompt).toContain('[Sys]')
      expect(result.systemPrompt).toContain('System info')
      // Prompt should be unchanged
      expect(result.prompt).toBe('Question')
    })

    it('respects token budget and drops optional injections', () => {
      // 1 char = 1 token with our custom estimator
      const middleware = new ContextInjectionMiddleware(
        { maxContextTokens: 50 },
        (text) => text.length,
      )

      middleware.addInjection({
        label: 'Big',
        content: 'x'.repeat(100),
        priority: 1,
        required: false,
      })
      middleware.addInjection({
        label: 'Small',
        content: 'y'.repeat(10),
        priority: 2,
        required: false,
      })

      const input = makeInput('Hello')
      const result = middleware.apply(input)

      // Only Small should fit within 50 tokens
      expect(result.prompt).toContain('[Small]')
      expect(result.prompt).not.toContain('[Big]')
    })

    it('always includes required injections even over budget', () => {
      const middleware = new ContextInjectionMiddleware(
        { maxContextTokens: 10 },
        (text) => text.length,
      )

      middleware.addInjection({
        label: 'Required',
        content: 'x'.repeat(100),
        priority: 1,
        required: true,
      })

      const input = makeInput('Hello')
      const result = middleware.apply(input)

      expect(result.prompt).toContain('[Required]')
    })

    it('returns input unchanged when no injections', () => {
      const middleware = new ContextInjectionMiddleware()
      const input = makeInput('Hello')
      const result = middleware.apply(input)

      expect(result).toBe(input) // Same reference
    })

    it('injects system prompt when no existing system prompt', () => {
      const middleware = new ContextInjectionMiddleware({ position: 'system' })
      middleware.addInjection({ label: 'Info', content: 'data', priority: 1 })

      const input = makeInput('Question')
      const result = middleware.apply(input)

      expect(result.systemPrompt).toContain('[Info]')
      expect(result.systemPrompt).toContain('data')
    })
  })

  describe('enrichInput', () => {
    it('computes available budget from provider context window', () => {
      const router = new ContextAwareRouter()
      const middleware = new ContextInjectionMiddleware()

      middleware.addInjection({ label: 'Ctx', content: 'Extra context', priority: 1 })

      const input = makeInput('Simple prompt')
      const enriched = middleware.enrichInput(input, 'claude', router)

      expect(enriched.prompt).toContain('[Ctx]')
      expect(enriched.prompt).toContain('Simple prompt')
    })
  })
})
