import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SelfCorrectionLoop } from '../correction/self-correction-loop.js'
import { LessonExtractor } from '../correction/lesson-extractor.js'
import { ReflectionNode } from '../correction/reflection-node.js'
import type {
  CodeEvaluator,
  CodeFixer,
  EvaluationResult,
  Reflection,
  CorrectionIterationEvent,
  CorrectionFixedEvent,
  CorrectionExhaustedEvent,
  CorrectionContext,
} from '../correction/correction-types.js'
import type { TokenUsage } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function zeroTokens(): TokenUsage {
  return { model: '', inputTokens: 0, outputTokens: 0 }
}

function makeTokens(total: number): TokenUsage {
  return { model: 'test-model', inputTokens: Math.floor(total * 0.6), outputTokens: Math.floor(total * 0.4) }
}

function passingEvaluation(qualityScore = 85): EvaluationResult {
  return {
    passed: true,
    lintErrors: [],
    qualityScore,
    testResults: { passed: 5, failed: 0, errors: [], failedTests: [] },
  }
}

function failingEvaluation(errors: string[] = ['Type error in src/service.ts']): EvaluationResult {
  return {
    passed: false,
    lintErrors: errors,
    qualityScore: 30,
    testResults: {
      passed: 2,
      failed: 3,
      errors: ['Test suite failed'],
      failedTests: [
        { name: 'should handle input', error: 'Expected 1 but got 2', file: 'src/service.test.ts' },
      ],
    },
  }
}

function makeReflection(overrides?: Partial<Reflection>): Reflection {
  return {
    rootCause: 'Missing import for PrismaClient',
    affectedFiles: ['src/service.ts'],
    suggestedFix: 'Add import { PrismaClient } from "@prisma/client"',
    confidence: 0.85,
    category: 'missing_import',
    ...overrides,
  }
}

const sampleVfs: Record<string, string> = {
  'src/service.ts': 'export class Service { async handle() { return "ok" } }',
  'src/service.test.ts': 'describe("Service", () => { it("works", () => {}) })',
}

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

function createMockEvaluator(results: EvaluationResult[]): CodeEvaluator {
  let callIndex = 0
  return {
    evaluate: vi.fn(async () => {
      const result = results[Math.min(callIndex, results.length - 1)]!
      callIndex++
      return result
    }),
  }
}

function createMockFixer(
  filesModified: string[] = ['src/service.ts'],
  tokens: TokenUsage = makeTokens(500),
): CodeFixer {
  return {
    fix: vi.fn(async (vfs, _reflection, _context) => ({
      vfs: { ...vfs, 'src/service.ts': '// fixed\n' + (vfs['src/service.ts'] ?? '') },
      filesModified,
      tokensUsed: tokens,
    })),
  }
}

// ---------------------------------------------------------------------------
// Tests: SelfCorrectionLoop
// ---------------------------------------------------------------------------

describe('SelfCorrectionLoop', () => {
  describe('successful fix on first iteration', () => {
    it('should return wasFixed=true when code passes immediately', async () => {
      const evaluator = createMockEvaluator([passingEvaluation()])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { qualityThreshold: 70 },
      )

      const result = await loop.run(sampleVfs)

      expect(result.wasFixed).toBe(true)
      expect(result.iterationCount).toBe(1)
      expect(result.iterations[0]!.evaluation.passed).toBe(true)
      expect(result.iterations[0]!.reflection).toBeNull()
      // Fixer should NOT have been called since code already passes
      expect(fixer.fix).not.toHaveBeenCalled()
    })
  })

  describe('multi-iteration fix', () => {
    it('should iterate until code passes', async () => {
      // First call: failing, second call: failing (after fix), third call: passing (final verify)
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        failingEvaluation(['Remaining lint error']),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 5, qualityThreshold: 70 },
      )

      const result = await loop.run(sampleVfs)

      expect(result.wasFixed).toBe(true)
      // Three iterations: two fail + fix, third (final verify) passes
      expect(result.iterationCount).toBe(3)
      expect(fixer.fix).toHaveBeenCalledTimes(2)
    })

    it('should pass reflection to fixer', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)

      expect(result.wasFixed).toBe(true)
      // The fixer should have been called with a fallback reflection
      expect(fixer.fix).toHaveBeenCalledTimes(1)
      const fixCall = vi.mocked(fixer.fix).mock.calls[0]!
      // Second argument is the reflection
      expect(fixCall[1]).toBeDefined()
      expect(fixCall[1].category).toBeDefined()
    })
  })

  describe('max iterations exhaustion', () => {
    it('should stop after maxIterations and return wasFixed=false', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        failingEvaluation(),
        failingEvaluation(),
        failingEvaluation(), // final verification also fails
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70 },
      )

      const result = await loop.run(sampleVfs)

      expect(result.wasFixed).toBe(false)
      expect(result.iterationCount).toBe(3)
      expect(fixer.fix).toHaveBeenCalledTimes(3)
    })
  })

  describe('cost tracking', () => {
    it('should track cumulative token usage', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        passingEvaluation(),
      ])
      const fixerTokens = makeTokens(1000)
      const fixer = createMockFixer(['src/service.ts'], fixerTokens)

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)

      expect(result.totalTokens.inputTokens + result.totalTokens.outputTokens).toBeGreaterThan(0)
      expect(result.totalCostCents).toBeGreaterThan(0)
    })

    it('should abort when maxCostCents is exceeded', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        failingEvaluation(),
        failingEvaluation(),
      ])
      // Large token usage per fix to exceed cost limit quickly
      const fixer = createMockFixer(['src/service.ts'], makeTokens(500_000))

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 10, maxCostCents: 1, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)

      expect(result.wasFixed).toBe(false)
      // Should have stopped early due to cost
      expect(result.iterationCount).toBeLessThan(10)
    })
  })

  describe('event emission', () => {
    it('should emit onIteration for each iteration', async () => {
      const evaluator = createMockEvaluator([failingEvaluation(), passingEvaluation()])
      const fixer = createMockFixer()
      const onIteration = vi.fn()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer, listeners: { onIteration } },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      await loop.run(sampleVfs)

      expect(onIteration).toHaveBeenCalled()
      const firstCall = onIteration.mock.calls[0]![0] as CorrectionIterationEvent
      expect(firstCall.iteration).toBe(0)
      expect(firstCall.evaluation).toBeDefined()
    })

    it('should emit onFixed when code is successfully fixed', async () => {
      const evaluator = createMockEvaluator([passingEvaluation()])
      const fixer = createMockFixer()
      const onFixed = vi.fn()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer, listeners: { onFixed } },
        { qualityThreshold: 70 },
      )

      await loop.run(sampleVfs)

      expect(onFixed).toHaveBeenCalledTimes(1)
      const event = onFixed.mock.calls[0]![0] as CorrectionFixedEvent
      expect(event.iterationCount).toBe(1)
      expect(event.totalDurationMs).toBeGreaterThanOrEqual(0)
    })

    it('should emit onExhausted when max iterations reached', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(['error1']),
        failingEvaluation(['error2']),
        failingEvaluation(['error3']),
      ])
      const fixer = createMockFixer()
      const onExhausted = vi.fn()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer, listeners: { onExhausted } },
        { maxIterations: 2, qualityThreshold: 70, enableReflection: false },
      )

      await loop.run(sampleVfs)

      expect(onExhausted).toHaveBeenCalledTimes(1)
      const event = onExhausted.mock.calls[0]![0] as CorrectionExhaustedEvent
      expect(event.iterationCount).toBe(2)
      expect(event.lastErrors.length).toBeGreaterThan(0)
    })
  })

  describe('reflection integration', () => {
    it('should build a fallback reflection when no ReflectionNode is provided', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(['Cannot find module "./missing"']),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)

      expect(result.wasFixed).toBe(true)
      // The first iteration should have a fallback reflection
      expect(result.iterations[0]!.reflection).not.toBeNull()
      expect(result.iterations[0]!.reflection!.category).toBe('missing_import')
    })

    it('should detect type errors in fallback reflection', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(['Type error: string is not assignable to number']),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)

      expect(result.iterations[0]!.reflection!.category).toBe('type_error')
    })
  })

  describe('quality threshold', () => {
    it('should reject code with low quality score even if no lint errors', async () => {
      const lowQualityPassing: EvaluationResult = {
        passed: true,
        lintErrors: [],
        qualityScore: 40, // below threshold
        testResults: { passed: 5, failed: 0, errors: [], failedTests: [] },
      }
      const evaluator = createMockEvaluator([
        lowQualityPassing,
        lowQualityPassing,
        lowQualityPassing,
        lowQualityPassing,
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 2, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)

      // Quality too low, so it should not be considered acceptable
      expect(result.wasFixed).toBe(false)
    })
  })

  describe('context forwarding', () => {
    it('should pass context to evaluator and fixer', async () => {
      const evaluator = createMockEvaluator([failingEvaluation(), passingEvaluation()])
      const fixer = createMockFixer()
      const context: CorrectionContext = {
        plan: { feature: 'auth' },
        techStack: { framework: 'vue3' },
      }

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      await loop.run(sampleVfs, context)

      // Evaluator should receive context
      expect(evaluator.evaluate).toHaveBeenCalledWith(expect.any(Object), context)
      // Fixer should receive context
      expect(fixer.fix).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        context,
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: LessonExtractor
// ---------------------------------------------------------------------------

describe('LessonExtractor', () => {
  it('should extract heuristic lessons from correction iterations', async () => {
    const extractor = new LessonExtractor()

    const iterations = [
      {
        index: 0,
        evaluation: failingEvaluation(),
        reflection: makeReflection({ category: 'missing_import' }),
        vfsSnapshot: sampleVfs,
        filesModified: ['src/service.ts'],
        tokensUsed: zeroTokens(),
        durationMs: 100,
      },
    ]

    const result = await extractor.extract(iterations)

    expect(result.lessons.length).toBeGreaterThan(0)
    expect(result.lessons[0]!.category).toBe('missing_import')
    expect(result.lessons[0]!.rule).toContain('import')
    expect(result.lessons[0]!.frequency).toBe(1)
  })

  it('should return empty lessons when no fix iterations exist', async () => {
    const extractor = new LessonExtractor()

    const iterations = [
      {
        index: 0,
        evaluation: passingEvaluation(),
        reflection: null, // no fix needed
        vfsSnapshot: sampleVfs,
        filesModified: [],
        tokensUsed: zeroTokens(),
        durationMs: 50,
      },
    ]

    const result = await extractor.extract(iterations)

    expect(result.lessons).toHaveLength(0)
    expect(result.tokensUsed.inputTokens).toBe(0)
    expect(result.tokensUsed.outputTokens).toBe(0)
  })

  it('should count frequency across multiple iterations with same category', async () => {
    const extractor = new LessonExtractor()

    const iterations = [
      {
        index: 0,
        evaluation: failingEvaluation(),
        reflection: makeReflection({ category: 'type_error' }),
        vfsSnapshot: sampleVfs,
        filesModified: ['src/a.ts'],
        tokensUsed: zeroTokens(),
        durationMs: 100,
      },
      {
        index: 1,
        evaluation: failingEvaluation(),
        reflection: makeReflection({ category: 'type_error' }),
        vfsSnapshot: sampleVfs,
        filesModified: ['src/b.ts'],
        tokensUsed: zeroTokens(),
        durationMs: 100,
      },
    ]

    const result = await extractor.extract(iterations)

    const typeLesson = result.lessons.find(l => l.category === 'type_error')
    expect(typeLesson).toBeDefined()
    expect(typeLesson!.frequency).toBe(2)
  })

  it('should produce lessons for multiple different categories', async () => {
    const extractor = new LessonExtractor()

    const iterations = [
      {
        index: 0,
        evaluation: failingEvaluation(),
        reflection: makeReflection({ category: 'missing_import' }),
        vfsSnapshot: sampleVfs,
        filesModified: ['src/a.ts'],
        tokensUsed: zeroTokens(),
        durationMs: 100,
      },
      {
        index: 1,
        evaluation: failingEvaluation(),
        reflection: makeReflection({ category: 'syntax_error' }),
        vfsSnapshot: sampleVfs,
        filesModified: ['src/b.ts'],
        tokensUsed: zeroTokens(),
        durationMs: 100,
      },
    ]

    const result = await extractor.extract(iterations)

    expect(result.lessons.length).toBe(2)
    const categories = result.lessons.map(l => l.category)
    expect(categories).toContain('missing_import')
    expect(categories).toContain('syntax_error')
  })
})

// ---------------------------------------------------------------------------
// Tests: ReflectionNode
// ---------------------------------------------------------------------------

describe('ReflectionNode', () => {
  it('should produce a structured reflection from LLM response', async () => {
    const mockResponse = {
      content: JSON.stringify({
        rootCause: 'Missing import for PrismaClient',
        affectedFiles: ['src/db.ts'],
        suggestedFix: 'Add import statement',
        confidence: 0.9,
        category: 'missing_import',
      }),
      response_metadata: {},
    }

    const mockModel = {
      invoke: vi.fn().mockResolvedValue(mockResponse),
    }

    const mockRegistry = {
      getModel: vi.fn().mockReturnValue(mockModel),
    }

    const node = new ReflectionNode({
      registry: mockRegistry as never,
    })

    const result = await node.reflect(sampleVfs, failingEvaluation())

    expect(result.reflection.rootCause).toBe('Missing import for PrismaClient')
    expect(result.reflection.affectedFiles).toContain('src/db.ts')
    expect(result.reflection.confidence).toBe(0.9)
    expect(result.reflection.category).toBe('missing_import')
  })

  it('should fall back to text extraction when JSON parsing fails', async () => {
    const mockResponse = {
      content: `The root cause is a missing import statement.
The fix is to add the import for PrismaClient in src/db.ts.
This is a type error due to unresolved reference.`,
      response_metadata: {},
    }

    const mockModel = {
      invoke: vi.fn().mockResolvedValue(mockResponse),
    }

    const mockRegistry = {
      getModel: vi.fn().mockReturnValue(mockModel),
    }

    const node = new ReflectionNode({
      registry: mockRegistry as never,
    })

    const result = await node.reflect(sampleVfs, failingEvaluation())

    // Should still produce a reflection via regex fallback
    expect(result.reflection.rootCause).toBeDefined()
    expect(result.reflection.category).toBeDefined()
    expect(result.reflection.confidence).toBeLessThanOrEqual(1)
  })

  it('should handle wrapped JSON in markdown code blocks', async () => {
    const mockResponse = {
      content: `Here is my analysis:

\`\`\`json
{
  "rootCause": "Incorrect API usage",
  "affectedFiles": ["src/api.ts"],
  "suggestedFix": "Use correct method signature",
  "confidence": 0.75,
  "category": "api_misuse"
}
\`\`\``,
      response_metadata: {},
    }

    const mockModel = {
      invoke: vi.fn().mockResolvedValue(mockResponse),
    }

    const mockRegistry = {
      getModel: vi.fn().mockReturnValue(mockModel),
    }

    const node = new ReflectionNode({
      registry: mockRegistry as never,
    })

    const result = await node.reflect(sampleVfs, failingEvaluation())

    expect(result.reflection.rootCause).toBe('Incorrect API usage')
    expect(result.reflection.category).toBe('api_misuse')
  })
})

// ---------------------------------------------------------------------------
// Tests: Integration — full loop with lesson extraction
// ---------------------------------------------------------------------------

describe('SelfCorrectionLoop with LessonExtractor', () => {
  it('should extract lessons after successful multi-iteration fix', async () => {
    const evaluator = createMockEvaluator([
      failingEvaluation(['Cannot find module "./missing"']),
      passingEvaluation(),
    ])
    const fixer = createMockFixer()
    const lessonExtractor = new LessonExtractor()

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, lessonExtractor },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false, enableLessonExtraction: true },
    )

    const result = await loop.run(sampleVfs)

    expect(result.wasFixed).toBe(true)
    expect(result.lessons.length).toBeGreaterThan(0)
    // Lesson should be about the missing_import category
    expect(result.lessons[0]!.category).toBe('missing_import')
  })

  it('should not extract lessons when disabled', async () => {
    const evaluator = createMockEvaluator([
      failingEvaluation(),
      passingEvaluation(),
    ])
    const fixer = createMockFixer()
    const lessonExtractor = new LessonExtractor()

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, lessonExtractor },
      { maxIterations: 3, qualityThreshold: 70, enableReflection: false, enableLessonExtraction: false },
    )

    const result = await loop.run(sampleVfs)

    expect(result.wasFixed).toBe(true)
    expect(result.lessons).toHaveLength(0)
  })

  it('should not extract lessons when loop is exhausted', async () => {
    const evaluator = createMockEvaluator([
      failingEvaluation(),
      failingEvaluation(),
      failingEvaluation(),
    ])
    const fixer = createMockFixer()
    const lessonExtractor = new LessonExtractor()

    const loop = new SelfCorrectionLoop(
      { evaluator, fixer, lessonExtractor },
      { maxIterations: 2, qualityThreshold: 70, enableReflection: false, enableLessonExtraction: true },
    )

    const result = await loop.run(sampleVfs)

    expect(result.wasFixed).toBe(false)
    expect(result.lessons).toHaveLength(0)
  })
})
