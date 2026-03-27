import { describe, it, expect } from 'vitest'
import { RunReflector, type ReflectionInput } from '../reflection/run-reflector.js'

describe('RunReflector', () => {
  const reflector = new RunReflector()

  // ---- Helper to build a minimal ReflectionInput ----
  function makeInput(overrides: Partial<ReflectionInput> = {}): ReflectionInput {
    return {
      input: 'Summarize the quarterly report',
      output: 'The quarterly report shows revenue growth of 15% year-over-year, driven primarily by expansion in the APAC region. Operating margins improved to 22%, up from 19% last quarter.',
      durationMs: 2500,
      ...overrides,
    }
  }

  // ------------------------------------------------------------------
  // Perfect run
  // ------------------------------------------------------------------
  describe('perfect run', () => {
    it('scores near 1.0 with successful tools and no errors', async () => {
      const score = await reflector.score(makeInput({
        toolCalls: [
          { name: 'readFile', success: true, durationMs: 100 },
          { name: 'search', success: true, durationMs: 200 },
        ],
        errorCount: 0,
        retryCount: 0,
      }))

      expect(score.overall).toBeGreaterThanOrEqual(0.9)
      expect(score.dimensions.completeness).toBe(1.0)
      expect(score.dimensions.coherence).toBe(1.0)
      expect(score.dimensions.toolSuccess).toBe(1.0)
      expect(score.dimensions.conciseness).toBe(1.0)
      expect(score.dimensions.reliability).toBe(1.0)
      expect(score.flags).toEqual([])
    })
  })

  // ------------------------------------------------------------------
  // Completeness
  // ------------------------------------------------------------------
  describe('completeness', () => {
    it('scores 0 for empty output', async () => {
      const score = await reflector.score(makeInput({ output: '' }))
      expect(score.dimensions.completeness).toBe(0)
      expect(score.flags).toContain('empty_output')
    })

    it('scores 0 for null output', async () => {
      const score = await reflector.score(makeInput({ output: null }))
      expect(score.dimensions.completeness).toBe(0)
      expect(score.flags).toContain('empty_output')
    })

    it('scores 0 for undefined output', async () => {
      const score = await reflector.score(makeInput({ output: undefined }))
      expect(score.dimensions.completeness).toBe(0)
      expect(score.flags).toContain('empty_output')
    })

    it('scores low for very short output with non-trivial input', async () => {
      const score = await reflector.score(makeInput({ output: 'OK' }))
      expect(score.dimensions.completeness).toBeLessThan(0.5)
      expect(score.flags).toContain('very_short_output')
    })

    it('scores 1.0 for reasonable output', async () => {
      const score = await reflector.score(makeInput())
      expect(score.dimensions.completeness).toBe(1.0)
    })
  })

  // ------------------------------------------------------------------
  // Coherence
  // ------------------------------------------------------------------
  describe('coherence', () => {
    it('scores 1.0 for normal text output', async () => {
      const score = await reflector.score(makeInput())
      expect(score.dimensions.coherence).toBe(1.0)
    })

    it('penalizes truncated output', async () => {
      const score = await reflector.score(makeInput({
        output: 'This is a response that was cut short...',
      }))
      expect(score.dimensions.coherence).toBeLessThan(1.0)
      expect(score.flags).toContain('truncated_output')
    })

    it('penalizes output containing error patterns', async () => {
      const score = await reflector.score(makeInput({
        output: 'Something went wrong. Internal Server Error occurred while processing.',
      }))
      expect(score.dimensions.coherence).toBeLessThan(1.0)
      expect(score.flags).toContain('error_in_output')
    })

    it('scores 0 for empty output', async () => {
      const score = await reflector.score(makeInput({ output: '' }))
      expect(score.dimensions.coherence).toBe(0)
    })

    it('handles valid JSON output well', async () => {
      const score = await reflector.score(makeInput({
        output: JSON.stringify({ summary: 'Revenue grew 15%', confidence: 0.95 }),
      }))
      expect(score.dimensions.coherence).toBe(1.0)
    })
  })

  // ------------------------------------------------------------------
  // Tool success
  // ------------------------------------------------------------------
  describe('toolSuccess', () => {
    it('scores 1.0 when no tools are used', async () => {
      const score = await reflector.score(makeInput({ toolCalls: undefined }))
      expect(score.dimensions.toolSuccess).toBe(1.0)
    })

    it('scores 1.0 when empty tool array is provided', async () => {
      const score = await reflector.score(makeInput({ toolCalls: [] }))
      expect(score.dimensions.toolSuccess).toBe(1.0)
    })

    it('scores 1.0 when all tools succeed', async () => {
      const score = await reflector.score(makeInput({
        toolCalls: [
          { name: 'read', success: true },
          { name: 'write', success: true },
        ],
      }))
      expect(score.dimensions.toolSuccess).toBe(1.0)
    })

    it('scores 0.5 when half of tools fail', async () => {
      const score = await reflector.score(makeInput({
        toolCalls: [
          { name: 'read', success: true },
          { name: 'write', success: false },
        ],
      }))
      expect(score.dimensions.toolSuccess).toBe(0.5)
    })

    it('scores 0 when all tools fail and sets flag', async () => {
      const score = await reflector.score(makeInput({
        toolCalls: [
          { name: 'read', success: false },
          { name: 'write', success: false },
          { name: 'search', success: false },
        ],
      }))
      expect(score.dimensions.toolSuccess).toBe(0)
      expect(score.flags).toContain('all_tools_failed')
    })
  })

  // ------------------------------------------------------------------
  // Conciseness
  // ------------------------------------------------------------------
  describe('conciseness', () => {
    it('scores 1.0 for moderate length output', async () => {
      const score = await reflector.score(makeInput())
      expect(score.dimensions.conciseness).toBe(1.0)
    })

    it('penalizes very long output (>10K chars)', async () => {
      const longOutput = 'x'.repeat(15_000)
      const score = await reflector.score(makeInput({ output: longOutput }))
      expect(score.dimensions.conciseness).toBeLessThan(1.0)
      expect(score.flags).toContain('very_long_output')
    })

    it('penalizes extremely long output more severely', async () => {
      const veryLong = 'x'.repeat(50_000)
      const score = await reflector.score(makeInput({ output: veryLong }))
      expect(score.dimensions.conciseness).toBeLessThan(0.5)
      expect(score.flags).toContain('very_long_output')
    })

    it('penalizes high output/input ratio', async () => {
      const shortInput = 'List colors'
      // 25x ratio with non-trivial input
      const longOutput = 'a'.repeat(shortInput.length * 25)
      const score = await reflector.score(makeInput({
        input: shortInput,
        output: longOutput,
      }))
      expect(score.dimensions.conciseness).toBeLessThan(1.0)
    })

    it('does not penalize empty output (handled by completeness)', async () => {
      const score = await reflector.score(makeInput({ output: '' }))
      expect(score.dimensions.conciseness).toBe(1.0)
    })
  })

  // ------------------------------------------------------------------
  // Reliability
  // ------------------------------------------------------------------
  describe('reliability', () => {
    it('scores 1.0 with zero errors and zero retries', async () => {
      const score = await reflector.score(makeInput({ errorCount: 0, retryCount: 0 }))
      expect(score.dimensions.reliability).toBe(1.0)
    })

    it('penalizes errors (0.2 each)', async () => {
      const score = await reflector.score(makeInput({ errorCount: 2, retryCount: 0 }))
      expect(score.dimensions.reliability).toBeCloseTo(0.6, 5)
    })

    it('penalizes retries (0.1 each)', async () => {
      const score = await reflector.score(makeInput({ errorCount: 0, retryCount: 3 }))
      expect(score.dimensions.reliability).toBeCloseTo(0.7, 5)
      expect(score.flags).toContain('excessive_retries')
    })

    it('combines error and retry penalties', async () => {
      const score = await reflector.score(makeInput({ errorCount: 1, retryCount: 2 }))
      // 1.0 - 0.2 - 0.2 = 0.6
      expect(score.dimensions.reliability).toBeCloseTo(0.6, 5)
    })

    it('clamps at 0 for many errors', async () => {
      const score = await reflector.score(makeInput({ errorCount: 10, retryCount: 5 }))
      expect(score.dimensions.reliability).toBe(0)
    })

    it('flags excessive retries at 3+', async () => {
      const score = await reflector.score(makeInput({ retryCount: 3 }))
      expect(score.flags).toContain('excessive_retries')
    })

    it('does not flag retries below 3', async () => {
      const score = await reflector.score(makeInput({ retryCount: 2 }))
      expect(score.flags).not.toContain('excessive_retries')
    })
  })

  // ------------------------------------------------------------------
  // Flags
  // ------------------------------------------------------------------
  describe('flags', () => {
    it('sets very_fast flag for runs under 500ms', async () => {
      const score = await reflector.score(makeInput({ durationMs: 200 }))
      expect(score.flags).toContain('very_fast')
    })

    it('does not set very_fast flag for normal duration', async () => {
      const score = await reflector.score(makeInput({ durationMs: 2000 }))
      expect(score.flags).not.toContain('very_fast')
    })

    it('can accumulate multiple flags', async () => {
      const score = await reflector.score(makeInput({
        output: '',
        durationMs: 100,
        errorCount: 5,
        retryCount: 5,
        toolCalls: [
          { name: 'a', success: false },
          { name: 'b', success: false },
        ],
      }))
      expect(score.flags).toContain('empty_output')
      expect(score.flags).toContain('very_fast')
      expect(score.flags).toContain('excessive_retries')
      expect(score.flags).toContain('all_tools_failed')
    })
  })

  // ------------------------------------------------------------------
  // Overall weighted score
  // ------------------------------------------------------------------
  describe('overall score', () => {
    it('is the weighted average of dimensions', async () => {
      const score = await reflector.score(makeInput({
        toolCalls: [{ name: 'a', success: true }],
        errorCount: 0,
        retryCount: 0,
      }))
      // All dimensions are 1.0 so overall should be 1.0
      const expected =
        0.3 * score.dimensions.completeness +
        0.2 * score.dimensions.coherence +
        0.2 * score.dimensions.toolSuccess +
        0.1 * score.dimensions.conciseness +
        0.2 * score.dimensions.reliability
      expect(score.overall).toBeCloseTo(expected, 5)
    })

    it('is low when multiple dimensions fail', async () => {
      const score = await reflector.score(makeInput({
        output: '',
        errorCount: 5,
        toolCalls: [
          { name: 'a', success: false },
        ],
      }))
      expect(score.overall).toBeLessThan(0.5)
    })

    it('is clamped between 0 and 1', async () => {
      const score = await reflector.score(makeInput({
        output: '',
        errorCount: 100,
        retryCount: 100,
        toolCalls: [{ name: 'a', success: false }],
      }))
      expect(score.overall).toBeGreaterThanOrEqual(0)
      expect(score.overall).toBeLessThanOrEqual(1)
    })
  })

  // ------------------------------------------------------------------
  // Edge cases
  // ------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles object input and output', async () => {
      const score = await reflector.score(makeInput({
        input: { query: 'What is 2+2?' },
        output: { answer: 4, confidence: 1.0 },
      }))
      expect(score.overall).toBeGreaterThan(0)
      expect(score.dimensions.completeness).toBe(1.0)
    })

    it('handles no token usage', async () => {
      const score = await reflector.score(makeInput({ tokenUsage: undefined }))
      expect(score.overall).toBeGreaterThan(0)
    })

    it('handles no tool calls', async () => {
      const score = await reflector.score(makeInput({ toolCalls: undefined }))
      expect(score.dimensions.toolSuccess).toBe(1.0)
    })

    it('handles no error/retry counts (defaults to 0)', async () => {
      const score = await reflector.score(makeInput({
        errorCount: undefined,
        retryCount: undefined,
      }))
      expect(score.dimensions.reliability).toBe(1.0)
    })

    it('handles numeric output', async () => {
      const score = await reflector.score(makeInput({ output: 42 }))
      expect(score.dimensions.completeness).toBeLessThan(1.0) // "42" is very short
    })

    it('handles zero duration', async () => {
      const score = await reflector.score(makeInput({ durationMs: 0 }))
      expect(score.flags).toContain('very_fast')
      expect(score.overall).toBeGreaterThan(0)
    })
  })
})
