import { describe, it, expect, vi } from 'vitest'
import { LessonExtractor } from '../correction/lesson-extractor.js'
import { ReflectionNode, ReflectionSchema } from '../correction/reflection-node.js'
import type {
  CorrectionIteration,
  EvaluationResult,
  Reflection,
  ErrorCategory,
  CorrectionContext,
} from '../correction/correction-types.js'
import type { TokenUsage } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function zeroTokens(): TokenUsage {
  return { model: '', inputTokens: 0, outputTokens: 0 }
}

function makeIteration(overrides: Partial<CorrectionIteration> = {}): CorrectionIteration {
  return {
    index: 0,
    evaluation: {
      passed: false,
      lintErrors: ['Type error in src/service.ts'],
      qualityScore: 40,
      testResults: {
        passed: 1,
        failed: 2,
        errors: ['Test suite failed'],
        failedTests: [{ name: 'should work', error: 'Expected 1 got 2', file: 'src/service.test.ts' }],
      },
    },
    reflection: {
      rootCause: 'Missing type annotation',
      affectedFiles: ['src/service.ts'],
      suggestedFix: 'Add explicit type annotation',
      confidence: 0.8,
      category: 'type_error',
    },
    vfsSnapshot: { 'src/service.ts': 'const x = 1' },
    filesModified: ['src/service.ts'],
    tokensUsed: zeroTokens(),
    durationMs: 100,
    ...overrides,
  }
}

function makeMockModel(responseContent: string) {
  return {
    invoke: vi.fn().mockResolvedValue({
      content: responseContent,
      usage_metadata: { input_tokens: 100, output_tokens: 50 },
    }),
    model: 'test-model',
  }
}

function makeMockRegistry(model: ReturnType<typeof makeMockModel>) {
  return {
    getModel: vi.fn().mockReturnValue(model),
  }
}

// ============================================================================
// LessonExtractor — heuristic mode
// ============================================================================
describe('LessonExtractor', () => {
  describe('heuristic mode (no registry)', () => {
    it('returns empty lessons when no fix iterations', async () => {
      const extractor = new LessonExtractor()
      const iterations = [makeIteration({ reflection: null })]
      const result = await extractor.extract(iterations)
      expect(result.lessons).toHaveLength(0)
      expect(result.tokensUsed.inputTokens).toBe(0)
    })

    it('extracts lessons from type_error iterations', async () => {
      const extractor = new LessonExtractor()
      const iterations = [makeIteration({ reflection: { ...makeIteration().reflection!, category: 'type_error' } })]
      const result = await extractor.extract(iterations)
      expect(result.lessons.length).toBeGreaterThan(0)
      expect(result.lessons[0]!.category).toBe('type_error')
      expect(result.lessons[0]!.frequency).toBe(1)
    })

    it('extracts lessons from syntax_error iterations', async () => {
      const extractor = new LessonExtractor()
      const iterations = [makeIteration({
        reflection: { ...makeIteration().reflection!, category: 'syntax_error' },
      })]
      const result = await extractor.extract(iterations)
      expect(result.lessons[0]!.category).toBe('syntax_error')
      expect(result.lessons[0]!.rule).toContain('syntax')
    })

    it('extracts lessons from missing_import iterations', async () => {
      const extractor = new LessonExtractor()
      const iterations = [makeIteration({
        reflection: { ...makeIteration().reflection!, category: 'missing_import' },
      })]
      const result = await extractor.extract(iterations)
      expect(result.lessons[0]!.category).toBe('missing_import')
    })

    it('extracts lessons from logic_error iterations', async () => {
      const extractor = new LessonExtractor()
      const iterations = [makeIteration({
        reflection: { ...makeIteration().reflection!, category: 'logic_error' },
      })]
      const result = await extractor.extract(iterations)
      expect(result.lessons[0]!.category).toBe('logic_error')
    })

    it('extracts lessons from api_misuse iterations', async () => {
      const extractor = new LessonExtractor()
      const iterations = [makeIteration({
        reflection: { ...makeIteration().reflection!, category: 'api_misuse' },
      })]
      const result = await extractor.extract(iterations)
      expect(result.lessons[0]!.category).toBe('api_misuse')
    })

    it('extracts lessons from test_failure iterations', async () => {
      const extractor = new LessonExtractor()
      const iterations = [makeIteration({
        reflection: { ...makeIteration().reflection!, category: 'test_failure' },
      })]
      const result = await extractor.extract(iterations)
      expect(result.lessons[0]!.category).toBe('test_failure')
    })

    it('extracts lessons from lint_violation iterations', async () => {
      const extractor = new LessonExtractor()
      const iterations = [makeIteration({
        reflection: { ...makeIteration().reflection!, category: 'lint_violation' },
      })]
      const result = await extractor.extract(iterations)
      expect(result.lessons[0]!.category).toBe('lint_violation')
    })

    it('extracts lessons from runtime_error iterations', async () => {
      const extractor = new LessonExtractor()
      const iterations = [makeIteration({
        reflection: { ...makeIteration().reflection!, category: 'runtime_error' },
      })]
      const result = await extractor.extract(iterations)
      expect(result.lessons[0]!.category).toBe('runtime_error')
    })

    it('aggregates frequency for repeated categories', async () => {
      const extractor = new LessonExtractor()
      const iterations = [
        makeIteration({ index: 0, reflection: { ...makeIteration().reflection!, category: 'type_error' } }),
        makeIteration({ index: 1, reflection: { ...makeIteration().reflection!, category: 'type_error' } }),
      ]
      const result = await extractor.extract(iterations)
      const typeLesson = result.lessons.find(l => l.category === 'type_error')
      expect(typeLesson!.frequency).toBe(2)
      expect(typeLesson!.context).toContain('2 time')
    })

    it('produces lessons for multiple categories', async () => {
      const extractor = new LessonExtractor()
      const iterations = [
        makeIteration({ index: 0, reflection: { ...makeIteration().reflection!, category: 'type_error' } }),
        makeIteration({ index: 1, reflection: { ...makeIteration().reflection!, category: 'syntax_error' } }),
      ]
      const result = await extractor.extract(iterations)
      expect(result.lessons.length).toBe(2)
      const cats = result.lessons.map(l => l.category)
      expect(cats).toContain('type_error')
      expect(cats).toContain('syntax_error')
    })

    it('returns zero tokens in heuristic mode', async () => {
      const extractor = new LessonExtractor()
      const iterations = [makeIteration()]
      const result = await extractor.extract(iterations)
      expect(result.tokensUsed.inputTokens).toBe(0)
      expect(result.tokensUsed.outputTokens).toBe(0)
    })

    it('accepts optional context parameter', async () => {
      const extractor = new LessonExtractor()
      const ctx: CorrectionContext = { techStack: { lang: 'typescript' } }
      const result = await extractor.extract([makeIteration()], ctx)
      expect(result.lessons.length).toBeGreaterThan(0)
    })
  })

  describe('LLM mode', () => {
    it('calls LLM when registry is provided', async () => {
      const model = makeMockModel(JSON.stringify([
        { rule: 'Always type parameters', category: 'type_error', context: 'TS projects' },
      ]))
      const registry = makeMockRegistry(model)
      const extractor = new LessonExtractor({ registry: registry as never })
      const result = await extractor.extract([makeIteration()])
      expect(registry.getModel).toHaveBeenCalled()
      expect(model.invoke).toHaveBeenCalled()
      expect(result.lessons.length).toBe(1)
      expect(result.lessons[0]!.rule).toBe('Always type parameters')
    })

    it('falls back to heuristics on invalid LLM JSON', async () => {
      const model = makeMockModel('This is not JSON at all')
      const registry = makeMockRegistry(model)
      const extractor = new LessonExtractor({ registry: registry as never })
      const result = await extractor.extract([makeIteration()])
      // Should fall back to heuristic extraction
      expect(result.lessons.length).toBeGreaterThan(0)
    })

    it('handles LLM returning array with missing rule field', async () => {
      const model = makeMockModel(JSON.stringify([
        { category: 'type_error', context: 'no rule field' },
      ]))
      const registry = makeMockRegistry(model)
      const extractor = new LessonExtractor({ registry: registry as never })
      const result = await extractor.extract([makeIteration()])
      // Items without 'rule' are filtered, resulting in empty lessons
      expect(result.lessons).toHaveLength(0)
    })

    it('normalizes unknown category to logic_error', async () => {
      const model = makeMockModel(JSON.stringify([
        { rule: 'Some rule', category: 'UNKNOWN_THING', context: 'test' },
      ]))
      const registry = makeMockRegistry(model)
      const extractor = new LessonExtractor({ registry: registry as never })
      const result = await extractor.extract([makeIteration()])
      expect(result.lessons[0]!.category).toBe('logic_error')
    })

    it('uses specified model tier', async () => {
      const model = makeMockModel(JSON.stringify([
        { rule: 'Test rule', category: 'type_error', context: 'test' },
      ]))
      const registry = makeMockRegistry(model)
      const extractor = new LessonExtractor({ registry: registry as never, modelTier: 'codegen' })
      await extractor.extract([makeIteration()])
      expect(registry.getModel).toHaveBeenCalledWith('codegen')
    })

    it('defaults to chat model tier', async () => {
      const model = makeMockModel(JSON.stringify([
        { rule: 'Test rule', category: 'type_error', context: 'test' },
      ]))
      const registry = makeMockRegistry(model)
      const extractor = new LessonExtractor({ registry: registry as never })
      await extractor.extract([makeIteration()])
      expect(registry.getModel).toHaveBeenCalledWith('chat')
    })

    it('handles non-string content from model', async () => {
      // When content is not a string, it gets JSON.stringified.
      // The stringified array of {type,text} objects is valid JSON but
      // items lack 'rule' field, so no lessons are extracted from the LLM path.
      const model = {
        invoke: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'some text without JSON' }],
          usage_metadata: { input_tokens: 10, output_tokens: 5 },
        }),
        model: 'test-model',
      }
      const registry = makeMockRegistry(model)
      const extractor = new LessonExtractor({ registry: registry as never })
      const result = await extractor.extract([makeIteration()])
      // The parsed array has no items with 'rule', yielding empty lessons
      expect(result.lessons).toHaveLength(0)
    })

    it('filters out lessons with empty rules', async () => {
      const model = makeMockModel(JSON.stringify([
        { rule: '', category: 'type_error', context: 'empty rule' },
        { rule: 'Valid rule', category: 'type_error', context: 'test' },
      ]))
      const registry = makeMockRegistry(model)
      const extractor = new LessonExtractor({ registry: registry as never })
      const result = await extractor.extract([makeIteration()])
      expect(result.lessons.every(l => l.rule.length > 0)).toBe(true)
    })
  })
})

// ============================================================================
// ReflectionNode
// ============================================================================
describe('ReflectionNode', () => {
  describe('ReflectionSchema', () => {
    it('validates correct reflection data', () => {
      const data = {
        rootCause: 'Missing import',
        affectedFiles: ['src/a.ts'],
        suggestedFix: 'Add import statement',
        confidence: 0.9,
        category: 'missing_import',
      }
      const result = ReflectionSchema.safeParse(data)
      expect(result.success).toBe(true)
    })

    it('rejects invalid confidence range', () => {
      const data = {
        rootCause: 'test',
        affectedFiles: [],
        suggestedFix: 'test',
        confidence: 1.5,
        category: 'type_error',
      }
      const result = ReflectionSchema.safeParse(data)
      expect(result.success).toBe(false)
    })

    it('rejects invalid category', () => {
      const data = {
        rootCause: 'test',
        affectedFiles: [],
        suggestedFix: 'test',
        confidence: 0.5,
        category: 'invalid_category',
      }
      const result = ReflectionSchema.safeParse(data)
      expect(result.success).toBe(false)
    })

    it('accepts optional additionalContext', () => {
      const data = {
        rootCause: 'test',
        affectedFiles: [],
        suggestedFix: 'test',
        confidence: 0.5,
        category: 'type_error',
        additionalContext: 'extra info',
      }
      const result = ReflectionSchema.safeParse(data)
      expect(result.success).toBe(true)
    })
  })

  describe('reflect()', () => {
    it('produces reflection from valid JSON LLM response', async () => {
      const responseJson = JSON.stringify({
        rootCause: 'Missing import for UserService',
        affectedFiles: ['src/service.ts'],
        suggestedFix: 'Add import { UserService } from ./user.service',
        confidence: 0.85,
        category: 'missing_import',
      })
      const model = makeMockModel(responseJson)
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      const result = await node.reflect(
        { 'src/service.ts': 'const x = 1' },
        {
          passed: false,
          lintErrors: ['Cannot find name UserService'],
          qualityScore: 30,
        },
      )
      expect(result.reflection.rootCause).toContain('UserService')
      expect(result.reflection.category).toBe('missing_import')
      expect(result.reflection.confidence).toBe(0.85)
    })

    it('falls back to text extraction on invalid JSON', async () => {
      const model = makeMockModel(
        'The root cause: missing import statement\nFix: add the import\nFile `src/service.ts` needs updating',
      )
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      const result = await node.reflect(
        { 'src/service.ts': 'const x = 1' },
        { passed: false, lintErrors: ['import error'], qualityScore: 20 },
      )
      expect(result.reflection.rootCause).toContain('missing import')
      expect(result.reflection.confidence).toBe(0.3)
      expect(result.reflection.category).toBe('missing_import')
    })

    it('extracts file paths from backticks in fallback', async () => {
      const model = makeMockModel(
        'The issue is in `src/utils/helper.ts` where the type is wrong',
      )
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      const result = await node.reflect(
        { 'src/utils/helper.ts': '' },
        { passed: false, lintErrors: ['type error'], qualityScore: 25 },
      )
      expect(result.reflection.affectedFiles).toContain('src/utils/helper.ts')
    })

    it('classifies type errors in fallback', async () => {
      const model = makeMockModel('Type error: string is not assignable to number')
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      const result = await node.reflect(
        { 'a.ts': '' },
        { passed: false, lintErrors: [], qualityScore: 20 },
      )
      expect(result.reflection.category).toBe('type_error')
    })

    it('classifies syntax errors in fallback', async () => {
      const model = makeMockModel('Syntax error: unexpected token at line 5')
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      const result = await node.reflect(
        { 'a.ts': '' },
        { passed: false, lintErrors: [], qualityScore: 20 },
      )
      expect(result.reflection.category).toBe('syntax_error')
    })

    it('classifies test failures in fallback', async () => {
      const model = makeMockModel('Test failed: expect(result).toBe(5) but got 3')
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      const result = await node.reflect(
        { 'a.ts': '' },
        { passed: false, lintErrors: [], qualityScore: 20 },
      )
      expect(result.reflection.category).toBe('test_failure')
    })

    it('classifies lint violations in fallback', async () => {
      const model = makeMockModel('ESLint rule violation: no-unused-vars')
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      const result = await node.reflect(
        { 'a.ts': '' },
        { passed: false, lintErrors: [], qualityScore: 20 },
      )
      expect(result.reflection.category).toBe('lint_violation')
    })

    it('defaults to logic_error when category cannot be determined', async () => {
      const model = makeMockModel('Something is wrong with the output')
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      const result = await node.reflect(
        { 'a.ts': '' },
        { passed: false, lintErrors: [], qualityScore: 20 },
      )
      expect(result.reflection.category).toBe('logic_error')
    })

    it('uses custom system prompt', async () => {
      const model = makeMockModel(JSON.stringify({
        rootCause: 'test',
        affectedFiles: [],
        suggestedFix: 'test',
        confidence: 0.5,
        category: 'logic_error',
      }))
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({
        registry: registry as never,
        systemPrompt: 'Custom system prompt',
      })
      await node.reflect({ 'a.ts': '' }, { passed: false, lintErrors: [], qualityScore: 20 })
      const invokeArgs = model.invoke.mock.calls[0]![0] as Array<{ content: string }>
      expect(invokeArgs[0]!.content).toBe('Custom system prompt')
    })

    it('uses codegen model tier by default', async () => {
      const model = makeMockModel(JSON.stringify({
        rootCause: 'test',
        affectedFiles: [],
        suggestedFix: 'test',
        confidence: 0.5,
        category: 'logic_error',
      }))
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      await node.reflect({ 'a.ts': '' }, { passed: false, lintErrors: [], qualityScore: 20 })
      expect(registry.getModel).toHaveBeenCalledWith('codegen')
    })

    it('includes test results in user message', async () => {
      const model = makeMockModel(JSON.stringify({
        rootCause: 'test',
        affectedFiles: [],
        suggestedFix: 'test',
        confidence: 0.5,
        category: 'logic_error',
      }))
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      await node.reflect(
        { 'a.ts': 'code' },
        {
          passed: false,
          lintErrors: ['Error A'],
          qualityScore: 30,
          testResults: {
            passed: 3,
            failed: 2,
            errors: ['Test error 1'],
            failedTests: [{ name: 'test1', error: 'failed', file: 'a.test.ts' }],
          },
        },
      )
      const invokeArgs = model.invoke.mock.calls[0]![0] as Array<{ content: string }>
      const userMsg = invokeArgs[1]!.content
      expect(userMsg).toContain('3 passed')
      expect(userMsg).toContain('2 failed')
      expect(userMsg).toContain('Error A')
    })

    it('includes raw output when present', async () => {
      const model = makeMockModel(JSON.stringify({
        rootCause: 'test',
        affectedFiles: [],
        suggestedFix: 'test',
        confidence: 0.5,
        category: 'logic_error',
      }))
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      await node.reflect(
        { 'a.ts': 'code' },
        {
          passed: false,
          lintErrors: [],
          qualityScore: 30,
          rawOutput: 'stderr output here',
        },
      )
      const invokeArgs = model.invoke.mock.calls[0]![0] as Array<{ content: string }>
      const userMsg = invokeArgs[1]!.content
      expect(userMsg).toContain('stderr output here')
    })

    it('handles additionalContext in validated response', async () => {
      const model = makeMockModel(JSON.stringify({
        rootCause: 'Missing dep',
        affectedFiles: ['src/a.ts'],
        suggestedFix: 'Install dep',
        confidence: 0.7,
        category: 'missing_import',
        additionalContext: 'The package is not in node_modules',
      }))
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      const result = await node.reflect(
        { 'src/a.ts': '' },
        { passed: false, lintErrors: [], qualityScore: 20 },
      )
      expect(result.reflection.additionalContext).toBe('The package is not in node_modules')
    })

    it('truncates large VFS files in user message', async () => {
      const model = makeMockModel(JSON.stringify({
        rootCause: 'test',
        affectedFiles: [],
        suggestedFix: 'test',
        confidence: 0.5,
        category: 'logic_error',
      }))
      const registry = makeMockRegistry(model)
      const node = new ReflectionNode({ registry: registry as never })
      const bigContent = 'x'.repeat(5000)
      await node.reflect(
        { 'a.ts': bigContent },
        { passed: false, lintErrors: [], qualityScore: 20 },
      )
      const invokeArgs = model.invoke.mock.calls[0]![0] as Array<{ content: string }>
      const userMsg = invokeArgs[1]!.content
      expect(userMsg).toContain('truncated')
    })
  })
})
