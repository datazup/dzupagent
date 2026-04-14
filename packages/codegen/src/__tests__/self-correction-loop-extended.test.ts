import { describe, it, expect, vi } from 'vitest'
import { SelfCorrectionLoop } from '../correction/self-correction-loop.js'
import type {
  CodeEvaluator,
  CodeFixer,
  EvaluationResult,
  Reflection,
  CorrectionContext,
  CorrectionIterationEvent,
  CorrectionFixedEvent,
  CorrectionExhaustedEvent,
} from '../correction/correction-types.js'
import type { TokenUsage } from '@dzupagent/core'
import type { ReflectionNode } from '../correction/reflection-node.js'
import type { LessonExtractor } from '../correction/lesson-extractor.js'

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

function failingEvaluation(errors: string[] = ['Type error in src/service.ts'], qualityScore = 30): EvaluationResult {
  return {
    passed: false,
    lintErrors: errors,
    qualityScore,
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

const sampleVfs: Record<string, string> = {
  'src/service.ts': 'export class Service { async handle() { return "ok" } }',
  'src/service.test.ts': 'describe("Service", () => { it("works", () => {}) })',
}

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
// Tests
// ---------------------------------------------------------------------------

describe('SelfCorrectionLoop — extended coverage', () => {
  // -----------------------------------------------------------------------
  // Fallback reflection error classification
  // -----------------------------------------------------------------------

  describe('fallback reflection — error classification', () => {
    it('classifies syntax errors', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(['SyntaxError: Unexpected token "}"']),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.iterations[0]!.reflection!.category).toBe('syntax_error')
    })

    it('classifies test failures', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(['test failed: expected 3 to equal 5']),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.iterations[0]!.reflection!.category).toBe('test_failure')
    })

    it('classifies lint violations', async () => {
      const lintEval: EvaluationResult = {
        passed: false,
        lintErrors: ['eslint: no-unused-vars — variable "x" is declared but never used'],
        qualityScore: 30,
        testResults: { passed: 5, failed: 0, errors: [], failedTests: [] },
      }
      const evaluator = createMockEvaluator([
        lintEval,
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.iterations[0]!.reflection!.category).toBe('lint_violation')
    })

    it('classifies missing imports', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(['Module not found: Cannot find "./missing-module"']),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.iterations[0]!.reflection!.category).toBe('missing_import')
    })

    it('classifies type errors', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(['TypeError: string is not assignable to type number']),
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

    it('defaults to logic_error for unclassifiable errors', async () => {
      const unknownEval: EvaluationResult = {
        passed: false,
        lintErrors: ['An obscure problem occurred in the system'],
        qualityScore: 30,
        testResults: { passed: 5, failed: 0, errors: [], failedTests: [] },
      }
      const evaluator = createMockEvaluator([
        unknownEval,
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.iterations[0]!.reflection!.category).toBe('logic_error')
    })

    it('extracts file paths from error messages', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(['Error in /src/api/handler.ts: unexpected token']),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.iterations[0]!.reflection!.affectedFiles).toContain('/src/api/handler.ts')
    })
  })

  // -----------------------------------------------------------------------
  // Reflection with mock ReflectionNode
  // -----------------------------------------------------------------------

  describe('LLM-based reflection integration', () => {
    it('uses ReflectionNode when enableReflection is true', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const mockReflectionNode: ReflectionNode = {
        reflect: vi.fn(async () => ({
          reflection: {
            rootCause: 'Missing dependency injection',
            affectedFiles: ['src/service.ts'],
            suggestedFix: 'Add DI container',
            confidence: 0.92,
            category: 'logic_error' as const,
          },
          tokensUsed: makeTokens(200),
        })),
      } as unknown as ReflectionNode

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer, reflectionNode: mockReflectionNode },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: true },
      )

      const result = await loop.run(sampleVfs)
      expect(result.wasFixed).toBe(true)
      expect(mockReflectionNode.reflect).toHaveBeenCalledTimes(1)
      expect(result.iterations[0]!.reflection!.rootCause).toBe('Missing dependency injection')
      expect(result.totalTokens.inputTokens).toBeGreaterThan(0)
    })

    it('accumulates tokens from reflection and fix', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        failingEvaluation(),
        passingEvaluation(),
      ])
      const fixer = createMockFixer(['src/service.ts'], makeTokens(300))

      const mockReflectionNode: ReflectionNode = {
        reflect: vi.fn(async () => ({
          reflection: {
            rootCause: 'Bug',
            affectedFiles: ['src/service.ts'],
            suggestedFix: 'Fix it',
            confidence: 0.8,
            category: 'logic_error' as const,
          },
          tokensUsed: makeTokens(150),
        })),
      } as unknown as ReflectionNode

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer, reflectionNode: mockReflectionNode },
        { maxIterations: 5, qualityThreshold: 70, enableReflection: true },
      )

      const result = await loop.run(sampleVfs)
      // 2 iterations of reflection (150 tokens each) + 2 fix calls (300 each)
      // Total: 2*150 + 2*300 = 900 tokens
      const totalUsed = result.totalTokens.inputTokens + result.totalTokens.outputTokens
      expect(totalUsed).toBeGreaterThanOrEqual(900)
    })
  })

  // -----------------------------------------------------------------------
  // Final verification pass
  // -----------------------------------------------------------------------

  describe('final verification', () => {
    it('runs final eval after loop exhausts iterations and fixes were applied', async () => {
      // 2 iterations of failing + fix, then final eval passes
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        failingEvaluation(),
        passingEvaluation(), // final verification
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 2, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      // Should pass via the final verification
      expect(result.wasFixed).toBe(true)
      expect(evaluator.evaluate).toHaveBeenCalledTimes(3) // 2 in loop + 1 final
    })

    it('does not run final verification when no files were modified in last iteration', async () => {
      // Use a fixer that modifies no files
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        failingEvaluation(),
      ])
      const noModFixer: CodeFixer = {
        fix: vi.fn(async (vfs) => ({
          vfs,
          filesModified: [],
          tokensUsed: zeroTokens(),
        })),
      }

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer: noModFixer },
        { maxIterations: 1, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.wasFixed).toBe(false)
      // Only 1 eval in loop, no final verification since no files modified
      expect(evaluator.evaluate).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------
  // Cost guard mid-iteration
  // -----------------------------------------------------------------------

  describe('cost guard — detailed behavior', () => {
    it('stops before fix when reflection cost exceeds limit', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        failingEvaluation(),
      ])
      const fixer = createMockFixer(['src/service.ts'], makeTokens(100))

      // Reflection node that uses enormous tokens
      const mockReflectionNode: ReflectionNode = {
        reflect: vi.fn(async () => ({
          reflection: {
            rootCause: 'Expensive reflection',
            affectedFiles: ['src/service.ts'],
            suggestedFix: 'Fix it',
            confidence: 0.8,
            category: 'logic_error' as const,
          },
          tokensUsed: makeTokens(1_000_000), // Very expensive
        })),
      } as unknown as ReflectionNode

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer, reflectionNode: mockReflectionNode },
        { maxIterations: 10, maxCostCents: 1, qualityThreshold: 70, enableReflection: true },
      )

      const result = await loop.run(sampleVfs)
      expect(result.wasFixed).toBe(false)
      // Should have stopped early
      expect(result.iterationCount).toBeLessThan(10)
    })

    it('stops after fix when cost exceeds limit between iterations', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        failingEvaluation(),
        failingEvaluation(),
      ])
      // Each fix costs a lot of tokens
      const fixer = createMockFixer(['src/service.ts'], makeTokens(500_000))

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 10, maxCostCents: 1, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.wasFixed).toBe(false)
      expect(result.iterationCount).toBeLessThanOrEqual(2)
    })
  })

  // -----------------------------------------------------------------------
  // isAcceptable criteria
  // -----------------------------------------------------------------------

  describe('acceptance criteria', () => {
    it('rejects when passed=true but lint errors remain', async () => {
      const evalWithLintErrors: EvaluationResult = {
        passed: true,
        lintErrors: ['warning: no-console'],
        qualityScore: 90,
        testResults: { passed: 5, failed: 0, errors: [], failedTests: [] },
      }
      const evaluator = createMockEvaluator([
        evalWithLintErrors,
        evalWithLintErrors,
        evalWithLintErrors,
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 2, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.wasFixed).toBe(false) // lint errors present
    })

    it('rejects when passed=false even if quality is high', async () => {
      const highQualityFailing: EvaluationResult = {
        passed: false,
        lintErrors: [],
        qualityScore: 95,
        testResults: { passed: 5, failed: 0, errors: [], failedTests: [] },
      }
      const evaluator = createMockEvaluator([highQualityFailing, highQualityFailing, highQualityFailing])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 2, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.wasFixed).toBe(false)
    })

    it('accepts when all three criteria are met', async () => {
      const evaluator = createMockEvaluator([passingEvaluation(80)])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 80 },
      )

      const result = await loop.run(sampleVfs)
      expect(result.wasFixed).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Event emission — detailed
  // -----------------------------------------------------------------------

  describe('event emission — detailed', () => {
    it('onIteration receives correct iteration index and data', async () => {
      const iterations: CorrectionIterationEvent[] = []
      const evaluator = createMockEvaluator([
        failingEvaluation(['err1']),
        failingEvaluation(['err2']),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        {
          evaluator,
          fixer,
          listeners: { onIteration: (e) => iterations.push(e) },
        },
        { maxIterations: 5, qualityThreshold: 70, enableReflection: false },
      )

      await loop.run(sampleVfs)

      expect(iterations.length).toBeGreaterThanOrEqual(2)
      expect(iterations[0]!.iteration).toBe(0)
      expect(iterations[1]!.iteration).toBe(1)
      expect(iterations[0]!.evaluation.passed).toBe(false)
      expect(iterations[0]!.filesModified.length).toBeGreaterThan(0)
      expect(iterations[0]!.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('onFixed receives lesson data', async () => {
      let fixedEvent: CorrectionFixedEvent | null = null
      const evaluator = createMockEvaluator([passingEvaluation()])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        {
          evaluator,
          fixer,
          listeners: { onFixed: (e) => { fixedEvent = e } },
        },
        { qualityThreshold: 70 },
      )

      await loop.run(sampleVfs)

      expect(fixedEvent).not.toBeNull()
      expect(fixedEvent!.iterationCount).toBe(1)
      expect(fixedEvent!.lessons).toEqual([])
    })

    it('onExhausted includes last errors from final iteration', async () => {
      let exhaustedEvent: CorrectionExhaustedEvent | null = null
      const evaluator = createMockEvaluator([
        failingEvaluation(['specific error A', 'specific error B']),
        failingEvaluation(['specific error A', 'specific error B']),
        failingEvaluation(['specific error A', 'specific error B']),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        {
          evaluator,
          fixer,
          listeners: { onExhausted: (e) => { exhaustedEvent = e } },
        },
        { maxIterations: 2, qualityThreshold: 70, enableReflection: false },
      )

      await loop.run(sampleVfs)

      expect(exhaustedEvent).not.toBeNull()
      expect(exhaustedEvent!.iterationCount).toBe(2)
      expect(exhaustedEvent!.lastErrors).toContain('specific error A')
      expect(exhaustedEvent!.lastErrors).toContain('specific error B')
    })

    it('onExhausted lastErrors is empty when no iterations ran', async () => {
      let exhaustedEvent: CorrectionExhaustedEvent | null = null
      const evaluator = createMockEvaluator([])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        {
          evaluator,
          fixer,
          listeners: { onExhausted: (e) => { exhaustedEvent = e } },
        },
        { maxIterations: 0, qualityThreshold: 70, enableReflection: false },
      )

      await loop.run(sampleVfs)

      expect(exhaustedEvent).not.toBeNull()
      expect(exhaustedEvent!.iterationCount).toBe(0)
      expect(exhaustedEvent!.lastErrors).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // Lesson extraction integration
  // -----------------------------------------------------------------------

  describe('lesson extraction', () => {
    it('invokes lessonExtractor on successful multi-iteration fix', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(['import error']),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()
      const mockExtractor: LessonExtractor = {
        extract: vi.fn(async () => ({
          lessons: [
            { rule: 'Always check imports', category: 'missing_import' as const, context: 'TS project', frequency: 1 },
          ],
          tokensUsed: zeroTokens(),
        })),
      } as unknown as LessonExtractor

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer, lessonExtractor: mockExtractor },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false, enableLessonExtraction: true },
      )

      const result = await loop.run(sampleVfs)
      expect(result.wasFixed).toBe(true)
      expect(result.lessons).toHaveLength(1)
      expect(result.lessons[0]!.rule).toBe('Always check imports')
      expect(mockExtractor.extract).toHaveBeenCalledTimes(1)
    })

    it('does not call lessonExtractor when enableLessonExtraction is false', async () => {
      const evaluator = createMockEvaluator([passingEvaluation()])
      const fixer = createMockFixer()
      const mockExtractor: LessonExtractor = {
        extract: vi.fn(async () => ({
          lessons: [],
          tokensUsed: zeroTokens(),
        })),
      } as unknown as LessonExtractor

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer, lessonExtractor: mockExtractor },
        { qualityThreshold: 70, enableLessonExtraction: false },
      )

      await loop.run(sampleVfs)
      expect(mockExtractor.extract).not.toHaveBeenCalled()
    })

    it('does not call lessonExtractor when no extractor is provided', async () => {
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        passingEvaluation(),
      ])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false, enableLessonExtraction: true },
      )

      const result = await loop.run(sampleVfs)
      expect(result.lessons).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // VFS mutation tracking
  // -----------------------------------------------------------------------

  describe('VFS snapshot evolution', () => {
    it('finalCode reflects accumulated fixes', async () => {
      let fixCount = 0
      const evaluator = createMockEvaluator([
        failingEvaluation(),
        failingEvaluation(),
        passingEvaluation(),
      ])
      const cumulativeFixer: CodeFixer = {
        fix: vi.fn(async (vfs) => {
          fixCount++
          return {
            vfs: { ...vfs, 'src/service.ts': `// fix ${fixCount}\n` + (vfs['src/service.ts'] ?? '') },
            filesModified: ['src/service.ts'],
            tokensUsed: makeTokens(100),
          }
        }),
      }

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer: cumulativeFixer },
        { maxIterations: 5, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      expect(result.wasFixed).toBe(true)
      // Both fixes should be applied
      expect(result.finalCode['src/service.ts']).toContain('// fix 1')
      expect(result.finalCode['src/service.ts']).toContain('// fix 2')
    })

    it('original VFS is not mutated', async () => {
      const evaluator = createMockEvaluator([failingEvaluation(), passingEvaluation()])
      const fixer = createMockFixer()
      const originalContent = sampleVfs['src/service.ts']

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      await loop.run(sampleVfs)
      // Original VFS should not be modified
      expect(sampleVfs['src/service.ts']).toBe(originalContent)
    })
  })

  // -----------------------------------------------------------------------
  // Config defaults
  // -----------------------------------------------------------------------

  describe('config defaults', () => {
    it('uses default config when no overrides provided', async () => {
      const evaluator = createMockEvaluator([passingEvaluation()])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop({ evaluator, fixer })
      const result = await loop.run(sampleVfs)

      // With default qualityThreshold of 70, passing eval at 85 should pass
      expect(result.wasFixed).toBe(true)
    })

    it('partial config merges with defaults', async () => {
      const evaluator = createMockEvaluator([passingEvaluation(60)])
      const fixer = createMockFixer()

      // Only override qualityThreshold, rest should be defaults
      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { qualityThreshold: 50 },
      )
      const result = await loop.run(sampleVfs)
      expect(result.wasFixed).toBe(true) // 60 >= 50
    })
  })

  // -----------------------------------------------------------------------
  // Duration tracking
  // -----------------------------------------------------------------------

  describe('duration tracking', () => {
    it('totalDurationMs is non-negative', async () => {
      const evaluator = createMockEvaluator([passingEvaluation()])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { qualityThreshold: 70 },
      )

      const result = await loop.run(sampleVfs)
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
    })

    it('each iteration records durationMs', async () => {
      const evaluator = createMockEvaluator([failingEvaluation(), passingEvaluation()])
      const fixer = createMockFixer()

      const loop = new SelfCorrectionLoop(
        { evaluator, fixer },
        { maxIterations: 3, qualityThreshold: 70, enableReflection: false },
      )

      const result = await loop.run(sampleVfs)
      for (const iter of result.iterations) {
        expect(iter.durationMs).toBeGreaterThanOrEqual(0)
      }
    })
  })
})
