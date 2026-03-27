import { describe, it, expect, vi } from 'vitest'
import {
  RunReflector,
  type ReflectionInput,
  type ReflectorConfig,
} from '../reflection/run-reflector.js'

describe('RunReflector LLM reflection', () => {
  // ---- Helper to build a minimal ReflectionInput ----
  function makeInput(overrides: Partial<ReflectionInput> = {}): ReflectionInput {
    return {
      input: 'Summarize the quarterly report',
      output:
        'The quarterly report shows revenue growth of 15% year-over-year, driven primarily by expansion in the APAC region. Operating margins improved to 22%, up from 19% last quarter.',
      durationMs: 2500,
      ...overrides,
    }
  }

  /** Build a mock LLM that returns a valid JSON response. */
  function mockLlm(scores: {
    completeness?: number
    coherence?: number
    relevance?: number
    reasoning?: string
  }): (prompt: string) => Promise<string> {
    return vi.fn(async () =>
      JSON.stringify({
        completeness: scores.completeness ?? 0.9,
        coherence: scores.coherence ?? 0.85,
        relevance: scores.relevance ?? 0.95,
        reasoning: scores.reasoning ?? 'Good quality output',
      }),
    )
  }

  // ------------------------------------------------------------------
  // Backward compatibility
  // ------------------------------------------------------------------
  describe('backward compatibility', () => {
    it('returns heuristic-only score with no config', async () => {
      const reflector = new RunReflector()
      const score = await reflector.score(makeInput())

      expect(score.overall).toBeGreaterThanOrEqual(0.9)
      expect(score.dimensions.completeness).toBe(1.0)
      expect(score.dimensions.coherence).toBe(1.0)
      expect(score.flags).not.toContain('llm_enhanced')
      expect(score.flags).not.toContain('llm_reflection_failed')
    })

    it('returns heuristic-only score with empty config', async () => {
      const reflector = new RunReflector({})
      const score = await reflector.score(makeInput())

      expect(score.overall).toBeGreaterThanOrEqual(0.9)
      expect(score.flags).not.toContain('llm_enhanced')
    })
  })

  // ------------------------------------------------------------------
  // Always mode
  // ------------------------------------------------------------------
  describe('always mode', () => {
    it('calls LLM on every score when mode is always', async () => {
      const llm = mockLlm({ completeness: 0.9, coherence: 0.85, relevance: 0.95 })
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      const score = await reflector.score(makeInput())

      expect(llm).toHaveBeenCalledTimes(1)
      expect(score.flags).toContain('llm_enhanced')
    })

    it('calls LLM even when heuristic score is high', async () => {
      const llm = mockLlm({})
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      // Perfect heuristic input
      await reflector.score(
        makeInput({
          toolCalls: [{ name: 'read', success: true }],
          errorCount: 0,
          retryCount: 0,
        }),
      )

      expect(llm).toHaveBeenCalledTimes(1)
    })
  })

  // ------------------------------------------------------------------
  // On-low-score mode (default)
  // ------------------------------------------------------------------
  describe('on-low-score mode', () => {
    it('does not call LLM when heuristic score is above threshold', async () => {
      const llm = mockLlm({})
      const reflector = new RunReflector({ llm }) // default: on-low-score, threshold 0.6

      // Good input => high heuristic score
      const score = await reflector.score(makeInput())

      expect(llm).not.toHaveBeenCalled()
      expect(score.flags).not.toContain('llm_enhanced')
    })

    it('calls LLM when heuristic score is below threshold', async () => {
      const llm = mockLlm({ completeness: 0.5, coherence: 0.4, relevance: 0.3 })
      const reflector = new RunReflector({
        llm,
        llmMode: 'on-low-score',
        llmThreshold: 0.6,
      })

      // Bad input => low heuristic score
      const score = await reflector.score(
        makeInput({
          output: '',
          errorCount: 5,
          toolCalls: [{ name: 'a', success: false }],
        }),
      )

      expect(llm).toHaveBeenCalledTimes(1)
      expect(score.flags).toContain('llm_enhanced')
    })

    it('respects custom threshold', async () => {
      const llm = mockLlm({})
      const reflector = new RunReflector({
        llm,
        llmMode: 'on-low-score',
        llmThreshold: 1.1, // threshold above max score, so everything triggers
      })

      await reflector.score(makeInput())

      expect(llm).toHaveBeenCalledTimes(1)
    })

    it('uses 0.6 as default threshold', async () => {
      const llm = mockLlm({})
      const reflector = new RunReflector({ llm })

      // This produces a heuristic score well above 0.6
      await reflector.score(makeInput())

      expect(llm).not.toHaveBeenCalled()
    })
  })

  // ------------------------------------------------------------------
  // Score blending
  // ------------------------------------------------------------------
  describe('blended score', () => {
    it('merges LLM dimensions for completeness and coherence', async () => {
      const llm = mockLlm({
        completeness: 0.7,
        coherence: 0.6,
        relevance: 0.8,
      })
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      const score = await reflector.score(makeInput())

      // LLM overrides completeness and coherence
      expect(score.dimensions.completeness).toBe(0.7)
      expect(score.dimensions.coherence).toBe(0.6)
    })

    it('preserves heuristic toolSuccess and reliability', async () => {
      const llm = mockLlm({})
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      const input = makeInput({
        toolCalls: [
          { name: 'read', success: true },
          { name: 'write', success: false },
        ],
        errorCount: 1,
      })

      const score = await reflector.score(input)

      // Heuristic values should be preserved
      expect(score.dimensions.toolSuccess).toBe(0.5) // 1/2 success
      expect(score.dimensions.reliability).toBeCloseTo(0.8, 5) // 1 error penalty
    })

    it('blends overall as 0.6*llm + 0.4*heuristic', async () => {
      const llm = mockLlm({
        completeness: 0.8,
        coherence: 0.7,
        relevance: 0.9,
      })
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      const score = await reflector.score(makeInput())

      // LLM overall = (0.8 + 0.7 + 0.9) / 3 = 0.8
      const llmOverall = (0.8 + 0.7 + 0.9) / 3
      // Heuristic overall = 1.0 (all perfect)
      const heuristicOverall = 1.0
      const expectedOverall = 0.6 * llmOverall + 0.4 * heuristicOverall

      expect(score.overall).toBeCloseTo(expectedOverall, 5)
    })
  })

  // ------------------------------------------------------------------
  // Heuristic flags preserved
  // ------------------------------------------------------------------
  describe('flag preservation', () => {
    it('preserves heuristic flags when LLM scoring is active', async () => {
      const llm = mockLlm({})
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      const score = await reflector.score(
        makeInput({
          durationMs: 100, // triggers very_fast flag
        }),
      )

      expect(score.flags).toContain('very_fast')
      expect(score.flags).toContain('llm_enhanced')
    })

    it('preserves all heuristic flags with LLM enhancement', async () => {
      const llm = mockLlm({})
      const reflector = new RunReflector({
        llm,
        llmMode: 'on-low-score',
        llmThreshold: 1.0, // force LLM call
      })

      const score = await reflector.score(
        makeInput({
          durationMs: 100,
          retryCount: 5,
        }),
      )

      expect(score.flags).toContain('very_fast')
      expect(score.flags).toContain('excessive_retries')
      expect(score.flags).toContain('llm_enhanced')
    })
  })

  // ------------------------------------------------------------------
  // LLM failure handling
  // ------------------------------------------------------------------
  describe('LLM failure', () => {
    it('falls back to heuristic on LLM error with flag', async () => {
      const llm = vi.fn(async () => {
        throw new Error('LLM API unavailable')
      })
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      const score = await reflector.score(makeInput())

      expect(llm).toHaveBeenCalledTimes(1)
      expect(score.flags).toContain('llm_reflection_failed')
      expect(score.flags).not.toContain('llm_enhanced')
      // Should still have valid heuristic score
      expect(score.overall).toBeGreaterThanOrEqual(0.9)
      expect(score.dimensions.completeness).toBe(1.0)
    })

    it('falls back on invalid JSON response', async () => {
      const llm = vi.fn(async () => 'This is not JSON at all')
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      const score = await reflector.score(makeInput())

      expect(score.flags).toContain('llm_reflection_failed')
      expect(score.overall).toBeGreaterThanOrEqual(0.9)
    })

    it('falls back on missing dimension fields', async () => {
      const llm = vi.fn(async () =>
        JSON.stringify({ completeness: 0.9 }), // missing coherence, relevance
      )
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      const score = await reflector.score(makeInput())

      expect(score.flags).toContain('llm_reflection_failed')
    })

    it('falls back on non-numeric dimension values', async () => {
      const llm = vi.fn(async () =>
        JSON.stringify({
          completeness: 'high',
          coherence: 0.5,
          relevance: 0.5,
          reasoning: 'test',
        }),
      )
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      const score = await reflector.score(makeInput())

      expect(score.flags).toContain('llm_reflection_failed')
    })
  })

  // ------------------------------------------------------------------
  // LLM prompt content
  // ------------------------------------------------------------------
  describe('LLM prompt', () => {
    it('includes input, output, and tool calls in prompt', async () => {
      const llm = mockLlm({})
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      await reflector.score(
        makeInput({
          input: 'Test input text',
          output: 'Test output text',
          toolCalls: [{ name: 'readFile', success: true, durationMs: 150 }],
        }),
      )

      const prompt = (llm as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(prompt).toContain('Test input text')
      expect(prompt).toContain('Test output text')
      expect(prompt).toContain('readFile')
      expect(prompt).toContain('success')
    })

    it('handles runs with no tool calls in prompt', async () => {
      const llm = mockLlm({})
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      await reflector.score(makeInput({ toolCalls: undefined }))

      const prompt = (llm as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(prompt).toContain('(none)')
    })
  })

  // ------------------------------------------------------------------
  // scoreHeuristic (public sync method)
  // ------------------------------------------------------------------
  describe('scoreHeuristic', () => {
    it('is available as a synchronous method', () => {
      const reflector = new RunReflector()
      const score = reflector.scoreHeuristic(makeInput())

      expect(score.overall).toBeGreaterThanOrEqual(0.9)
      expect(score.dimensions.completeness).toBe(1.0)
    })
  })

  // ------------------------------------------------------------------
  // LLM dimension clamping
  // ------------------------------------------------------------------
  describe('LLM dimension clamping', () => {
    it('clamps LLM dimensions to [0, 1]', async () => {
      const llm = vi.fn(async () =>
        JSON.stringify({
          completeness: 1.5,
          coherence: -0.2,
          relevance: 0.5,
          reasoning: 'extreme values',
        }),
      )
      const reflector = new RunReflector({ llm, llmMode: 'always' })

      const score = await reflector.score(makeInput())

      expect(score.dimensions.completeness).toBe(1.0) // clamped from 1.5
      expect(score.dimensions.coherence).toBe(0.0) // clamped from -0.2
      expect(score.flags).toContain('llm_enhanced')
    })
  })
})
