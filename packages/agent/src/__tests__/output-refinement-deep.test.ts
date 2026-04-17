import { describe, it, expect } from 'vitest'
import { OutputRefinementLoop } from '../self-correction/output-refinement.js'
import type { RefinementResult, ScoreFn } from '../self-correction/output-refinement.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage } from '@langchain/core/messages'

/**
 * Create a mock chat model that returns predictable responses.
 */
function mockModel(responses: string[]): BaseChatModel {
  let callIndex = 0
  return {
    invoke: async () => {
      const text = responses[callIndex % responses.length] ?? 'Score: 0.5\nFeedback: ok'
      callIndex++
      return new AIMessage(text)
    },
  } as unknown as BaseChatModel
}

describe('OutputRefinementLoop', () => {
  describe('detectDomain', () => {
    it('detects SQL domain', () => {
      const domain = OutputRefinementLoop.detectDomain(
        'Write a query',
        'SELECT id, name FROM users WHERE age > 18 ORDER BY name',
      )
      expect(domain).toBe('sql')
    })

    it('detects code domain', () => {
      const domain = OutputRefinementLoop.detectDomain(
        'Write a function',
        'export function add(a: number, b: number): number { return a + b }',
      )
      expect(domain).toBe('code')
    })

    it('detects ops domain', () => {
      const domain = OutputRefinementLoop.detectDomain(
        'Deploy the service',
        'Use docker compose to deploy and configure kubernetes health check monitoring',
      )
      expect(domain).toBe('ops')
    })

    it('detects analysis domain', () => {
      const domain = OutputRefinementLoop.detectDomain(
        'Analyze the data',
        'The analysis shows a strong correlation between the variables. The methodology uses standard deviation and regression to determine the trend and findings.',
      )
      expect(domain).toBe('analysis')
    })

    it('returns general for ambiguous content', () => {
      const domain = OutputRefinementLoop.detectDomain('Hello', 'World')
      expect(domain).toBe('general')
    })

    it('returns general when only one keyword matches', () => {
      const domain = OutputRefinementLoop.detectDomain('Test', 'SELECT something')
      expect(domain).toBe('general')
    })
  })

  describe('refine', () => {
    it('returns immediately if initial score exceeds quality threshold', async () => {
      const model = mockModel([
        'Score: 0.95\nFeedback: Excellent work',
      ])

      const loop = new OutputRefinementLoop(model, {
        qualityThreshold: 0.9,
      })

      const result = await loop.refine({
        task: 'Write something',
        output: 'Perfect output',
        domain: 'general',
      })

      expect(result.exitReason).toBe('quality_met')
      expect(result.wasRefined).toBe(false)
      expect(result.iterations).toHaveLength(0)
      expect(result.bestScore).toBeGreaterThanOrEqual(0.9)
    })

    it('performs refinement when initial quality is low', async () => {
      const model = mockModel([
        // Initial score
        'Score: 0.5\nFeedback: Needs improvement',
        // Iteration 1 critique
        'Score: 0.5\nFeedback: Fix the structure',
        // Iteration 1 refinement
        'Improved output here',
        // Iteration 1 refined score
        'Score: 0.95\nFeedback: Great improvement',
      ])

      const loop = new OutputRefinementLoop(model, {
        maxIterations: 2,
        qualityThreshold: 0.9,
        minImprovement: 0.05,
      })

      const result = await loop.refine({
        task: 'Write a report',
        output: 'Bad report',
        domain: 'general',
      })

      expect(result.wasRefined).toBe(true)
      expect(result.exitReason).toBe('quality_met')
      expect(result.iterations.length).toBeGreaterThanOrEqual(1)
    })

    it('stops on no improvement', async () => {
      const model = mockModel([
        // Initial score
        'Score: 0.6\nFeedback: Mediocre',
        // Critique
        'Score: 0.6\nFeedback: Still mediocre',
        // Refinement
        'Slightly different output',
        // Refined score -- same as before
        'Score: 0.6\nFeedback: No better',
      ])

      const loop = new OutputRefinementLoop(model, {
        maxIterations: 3,
        qualityThreshold: 0.9,
        minImprovement: 0.05,
      })

      const result = await loop.refine({
        task: 'Write something',
        output: 'Mediocre output',
        domain: 'general',
      })

      expect(result.exitReason).toBe('no_improvement')
    })

    it('stops on regression', async () => {
      const model = mockModel([
        // Initial score
        'Score: 0.7\nFeedback: Decent',
        // Critique
        'Score: 0.7\nFeedback: Could be better',
        // Refinement
        'Worse output',
        // Refined score -- lower
        'Score: 0.5\nFeedback: Got worse',
      ])

      const loop = new OutputRefinementLoop(model, {
        maxIterations: 3,
        qualityThreshold: 0.9,
        minImprovement: 0.05,
      })

      const result = await loop.refine({
        task: 'Write something',
        output: 'Decent output',
        domain: 'general',
      })

      expect(result.exitReason).toBe('regression_detected')
      expect(result.bestOutput).toBe('Decent output') // Original kept
    })

    it('respects max iterations', async () => {
      let callCount = 0
      const model = {
        invoke: async () => {
          callCount++
          // Always return a score that triggers improvement but never meets threshold
          if (callCount % 3 === 0) {
            // Refined score: always slightly better
            return new AIMessage(`Score: ${0.5 + callCount * 0.01}\nFeedback: Better`)
          }
          if (callCount % 3 === 2) {
            // Refinement output
            return new AIMessage(`Refined output v${callCount}`)
          }
          // Critique
          return new AIMessage(`Score: ${0.5 + (callCount - 1) * 0.01}\nFeedback: Keep improving`)
        },
      } as unknown as BaseChatModel

      const loop = new OutputRefinementLoop(model, {
        maxIterations: 1,
        qualityThreshold: 0.99,
        minImprovement: 0.001,
      })

      const result = await loop.refine({
        task: 'Write something',
        output: 'Initial output',
        domain: 'general',
      })

      expect(result.iterations.length).toBeLessThanOrEqual(1)
    })

    it('handles custom scoreFn', async () => {
      const model = mockModel(['Improved version of the text'])

      const scoreFn: ScoreFn = async (output) => {
        const score = output.includes('Improved') ? 0.95 : 0.4
        return { score, feedback: score > 0.9 ? 'Great' : 'Needs work' }
      }

      const loop = new OutputRefinementLoop(model, {
        maxIterations: 2,
        qualityThreshold: 0.9,
        minImprovement: 0.05,
      })

      const result = await loop.refine({
        task: 'Improve text',
        output: 'Bad text',
        scoreFn,
        domain: 'general',
      })

      expect(result.wasRefined).toBe(true)
    })

    it('stops on budget exhaustion', async () => {
      const model = mockModel([
        'Score: 0.5\nFeedback: Needs work',
        'Score: 0.5\nFeedback: Still needs work',
        'Refined output',
        'Score: 0.6\nFeedback: Better',
      ])

      const loop = new OutputRefinementLoop(model, {
        maxIterations: 10,
        qualityThreshold: 0.99,
        minImprovement: 0.01,
        costBudgetCents: 0.001, // Extremely low budget
      })

      const result = await loop.refine({
        task: 'Write something',
        output: 'Initial',
        domain: 'general',
      })

      expect(result.exitReason).toBe('budget_exhausted')
    })

    it('handles error during initial scoring', async () => {
      const model = {
        invoke: async () => { throw new Error('API error') },
      } as unknown as BaseChatModel

      const loop = new OutputRefinementLoop(model)

      const result = await loop.refine({
        task: 'Write something',
        output: 'Initial',
        domain: 'general',
      })

      expect(result.exitReason).toBe('error')
      expect(result.wasRefined).toBe(false)
    })

    it('handles error during critique in iteration', async () => {
      let callCount = 0
      const model = {
        invoke: async () => {
          callCount++
          if (callCount === 1) return new AIMessage('Score: 0.5\nFeedback: Needs work')
          throw new Error('API error during critique')
        },
      } as unknown as BaseChatModel

      const loop = new OutputRefinementLoop(model, {
        qualityThreshold: 0.99,
      })

      const result = await loop.refine({
        task: 'Write something',
        output: 'Initial',
        domain: 'general',
      })

      expect(result.exitReason).toBe('error')
    })

    it('handles error during refinement application', async () => {
      let callCount = 0
      const model = {
        invoke: async () => {
          callCount++
          if (callCount <= 2) return new AIMessage('Score: 0.5\nFeedback: Needs work')
          throw new Error('API error during refinement')
        },
      } as unknown as BaseChatModel

      const loop = new OutputRefinementLoop(model, {
        qualityThreshold: 0.99,
      })

      const result = await loop.refine({
        task: 'Write something',
        output: 'Initial',
        domain: 'general',
      })

      expect(result.exitReason).toBe('error')
    })

    it('handles error during refined output scoring', async () => {
      let callCount = 0
      const model = {
        invoke: async () => {
          callCount++
          if (callCount <= 2) return new AIMessage('Score: 0.5\nFeedback: Needs work')
          if (callCount === 3) return new AIMessage('Improved output')
          throw new Error('API error during scoring')
        },
      } as unknown as BaseChatModel

      const loop = new OutputRefinementLoop(model, {
        qualityThreshold: 0.99,
      })

      const result = await loop.refine({
        task: 'Write something',
        output: 'Initial',
        domain: 'general',
      })

      expect(result.exitReason).toBe('error')
    })

    it('uses domain override when provided', async () => {
      const model = mockModel(['Score: 0.95\nFeedback: Great SQL'])

      const loop = new OutputRefinementLoop(model)

      const result = await loop.refine({
        task: 'Write something',
        output: 'Some output',
        domain: 'sql',
      })

      expect(result.domain).toBe('sql')
    })

    it('auto-detects domain when not specified', async () => {
      const model = mockModel(['Score: 0.95\nFeedback: Good code'])

      const loop = new OutputRefinementLoop(model)

      const result = await loop.refine({
        task: 'Write a function',
        output: 'export function add(a: number, b: number) { return a + b }',
      })

      expect(result.domain).toBe('code')
    })

    it('passes context to critique and refinement', async () => {
      const invocations: string[] = []
      const model = {
        invoke: async (messages: unknown[]) => {
          const lastMsg = (messages as Array<{ content: string }>).pop()
          invocations.push(lastMsg?.content ?? '')
          return new AIMessage('Score: 0.95\nFeedback: Good')
        },
      } as unknown as BaseChatModel

      const loop = new OutputRefinementLoop(model)

      await loop.refine({
        task: 'Test',
        output: 'Output',
        domain: 'general',
        context: { environment: 'production', team: 'backend' },
      })

      // The context should appear in the invocations
      expect(invocations.some(inv => inv.includes('environment: production'))).toBe(true)
    })

    it('builds result with correct totalImprovement', async () => {
      const model = mockModel([
        'Score: 0.5\nFeedback: Meh',
        'Score: 0.5\nFeedback: Still meh',
        'Better output',
        'Score: 0.8\nFeedback: Much better',
      ])

      const loop = new OutputRefinementLoop(model, {
        maxIterations: 1,
        qualityThreshold: 0.99,
        minImprovement: 0.01,
      })

      const result = await loop.refine({
        task: 'Test',
        output: 'Initial',
        domain: 'general',
      })

      expect(result.totalImprovement).toBeCloseTo(result.bestScore - result.originalScore)
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
      expect(result.estimatedCostCents).toBeGreaterThanOrEqual(0)
    })
  })

  describe('parseCritiqueResponse edge cases', () => {
    it('handles 0-10 scale scores', async () => {
      const model = mockModel(['Score: 8\nFeedback: Pretty good'])

      const loop = new OutputRefinementLoop(model, { qualityThreshold: 0.9 })

      const result = await loop.refine({
        task: 'Test',
        output: 'Test output',
        domain: 'general',
      })

      // Score: 8 should be normalized to 0.8
      expect(result.bestScore).toBeCloseTo(0.8, 1)
    })

    it('handles missing feedback', async () => {
      const model = mockModel(['Score: 0.95'])

      const loop = new OutputRefinementLoop(model, { qualityThreshold: 0.9 })

      const result = await loop.refine({
        task: 'Test',
        output: 'Test output',
        domain: 'general',
      })

      expect(result.exitReason).toBe('quality_met')
    })

    it('handles no score pattern at all', async () => {
      const model = mockModel(['This is good work with no score pattern'])

      const loop = new OutputRefinementLoop(model, { qualityThreshold: 0.9 })

      const result = await loop.refine({
        task: 'Test',
        output: 'Test output',
        domain: 'general',
      })

      // Falls back to 0.5
      expect(result.bestScore).toBeCloseTo(0.5)
    })

    it('handles array content from model', async () => {
      const model = {
        invoke: async () => {
          return {
            content: [{ type: 'text', text: 'Score: 0.95\nFeedback: Great' }],
          }
        },
      } as unknown as BaseChatModel

      const loop = new OutputRefinementLoop(model, { qualityThreshold: 0.9 })

      const result = await loop.refine({
        task: 'Test',
        output: 'Test output',
        domain: 'general',
      })

      // When content is array, extractText returns JSON.stringify
      // which won't match Score pattern, so score will be 0.5
      expect(result).toBeDefined()
    })
  })
})
