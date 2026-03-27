import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  RootCauseAnalyzer,
  type RootCauseReport,
  type HeuristicClassification,
} from '../self-correction/index.js'

// ---------------------------------------------------------------------------
// Mock model helpers
// ---------------------------------------------------------------------------

function createMockModel(responses: string[]): BaseChatModel {
  let callIndex = 0
  return {
    invoke: vi.fn(async () => {
      const content = responses[callIndex] ?? 'fallback response'
      if (callIndex < responses.length) callIndex++
      return new AIMessage({ content })
    }),
  } as unknown as BaseChatModel
}

function createFailingModel(error: Error): BaseChatModel {
  return {
    invoke: vi.fn(async () => {
      throw error
    }),
  } as unknown as BaseChatModel
}

// ---------------------------------------------------------------------------
// classifyHeuristic
// ---------------------------------------------------------------------------

describe('RootCauseAnalyzer.classifyHeuristic', () => {
  const analyzer = new RootCauseAnalyzer({
    llm: createMockModel([]),
  })

  it('classifies timeout errors', () => {
    const result = analyzer.classifyHeuristic('Request timed out after 30s')
    expect(result.category).toBe('timeout')
    expect(result.severity).toBe('high')
  })

  it('classifies resource exhaustion errors', () => {
    const result = analyzer.classifyHeuristic('JavaScript heap out of memory')
    expect(result.category).toBe('resource_exhaustion')
    expect(result.severity).toBe('critical')
  })

  it('classifies rate limit as resource exhaustion', () => {
    const result = analyzer.classifyHeuristic('Rate limit exceeded, status 429')
    expect(result.category).toBe('resource_exhaustion')
  })

  it('classifies dependency missing errors', () => {
    const result = analyzer.classifyHeuristic('Cannot find module "lodash"')
    expect(result.category).toBe('dependency_missing')
    expect(result.severity).toBe('high')
  })

  it('classifies type mismatch errors', () => {
    const result = analyzer.classifyHeuristic('Type error: string is not assignable to number')
    expect(result.category).toBe('type_mismatch')
    expect(result.severity).toBe('medium')
  })

  it('classifies import errors', () => {
    const result = analyzer.classifyHeuristic('ERR_MODULE_NOT_FOUND: Cannot find package')
    expect(result.category).toBe('import_error')
    expect(result.severity).toBe('high')
  })

  it('classifies auth errors', () => {
    const result = analyzer.classifyHeuristic('Unauthorized: invalid API key')
    expect(result.category).toBe('auth_error')
    expect(result.severity).toBe('critical')
  })

  it('classifies schema errors', () => {
    const result = analyzer.classifyHeuristic('Zod error: required field "name" is missing')
    expect(result.category).toBe('schema_error')
    expect(result.severity).toBe('medium')
  })

  it('classifies build failures', () => {
    const result = analyzer.classifyHeuristic('Build failed with syntax error in main.ts')
    expect(result.category).toBe('build_failure')
    expect(result.severity).toBe('high')
  })

  it('classifies test failures', () => {
    const result = analyzer.classifyHeuristic('Test failed: 3 tests failed in suite')
    expect(result.category).toBe('test_failure')
    expect(result.severity).toBe('medium')
  })

  it('classifies network errors', () => {
    const result = analyzer.classifyHeuristic('ECONNREFUSED: connection refused to localhost:5432')
    expect(result.category).toBe('network_error')
    expect(result.severity).toBe('high')
  })

  it('returns unknown for unrecognized errors', () => {
    const result = analyzer.classifyHeuristic('Something completely unexpected happened')
    expect(result.category).toBe('unknown')
    expect(result.severity).toBe('medium')
    expect(result.suggestedAction).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// analyze — LLM success path
// ---------------------------------------------------------------------------

describe('RootCauseAnalyzer.analyze', () => {
  it('returns a full report from LLM JSON response', async () => {
    const llmResponse = JSON.stringify({
      rootCause: 'Missing lodash dependency in package.json',
      causalChain: [
        'package.json missing lodash',
        'import fails at runtime',
        'gen_backend node throws',
      ],
      affectedNodes: ['gen_backend', 'run_tests'],
      suggestedFixes: [
        'Add lodash to package.json dependencies',
        'Use built-in Array methods instead of lodash',
      ],
      confidence: 0.92,
    })

    const analyzer = new RootCauseAnalyzer({
      llm: createMockModel([llmResponse]),
    })

    const report = await analyzer.analyze({
      error: 'Cannot find module "lodash"',
      nodeId: 'gen_backend',
      nodeType: 'generation',
    })

    expect(report.immediateError).toBe('Cannot find module "lodash"')
    expect(report.rootCause).toBe('Missing lodash dependency in package.json')
    expect(report.causalChain).toHaveLength(3)
    expect(report.affectedNodes).toEqual(['gen_backend', 'run_tests'])
    expect(report.suggestedFixes).toHaveLength(2)
    expect(report.confidence).toBeCloseTo(0.92, 2)
    expect(report.hasPastContext).toBe(false)
  })

  it('parses JSON from code fences', async () => {
    const llmResponse = '```json\n{"rootCause":"bad config","causalChain":["step1"],"affectedNodes":["nodeA"],"suggestedFixes":["fix it"],"confidence":0.7}\n```'

    const analyzer = new RootCauseAnalyzer({
      llm: createMockModel([llmResponse]),
    })

    const report = await analyzer.analyze({
      error: 'Config invalid',
      nodeId: 'nodeA',
    })

    expect(report.rootCause).toBe('bad config')
    expect(report.confidence).toBeCloseTo(0.7, 2)
  })

  it('parses JSON embedded in surrounding text', async () => {
    const llmResponse = 'Here is my analysis:\n{"rootCause":"timeout in DB","causalChain":[],"affectedNodes":["db"],"suggestedFixes":["increase timeout"],"confidence":0.6}\nHope that helps!'

    const analyzer = new RootCauseAnalyzer({
      llm: createMockModel([llmResponse]),
    })

    const report = await analyzer.analyze({
      error: 'Query timed out',
      nodeId: 'db',
    })

    expect(report.rootCause).toBe('timeout in DB')
    expect(report.confidence).toBeCloseTo(0.6, 2)
  })

  it('falls back to heuristic when LLM fails', async () => {
    const analyzer = new RootCauseAnalyzer({
      llm: createFailingModel(new Error('LLM service unavailable')),
    })

    const report = await analyzer.analyze({
      error: 'Cannot find module "express"',
      nodeId: 'gen_backend',
    })

    expect(report.immediateError).toBe('Cannot find module "express"')
    expect(report.rootCause).toContain('dependency_missing')
    expect(report.confidence).toBe(0.3)
    expect(report.affectedNodes).toEqual(['gen_backend'])
    expect(report.suggestedFixes.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to heuristic when LLM returns unparseable text', async () => {
    const analyzer = new RootCauseAnalyzer({
      llm: createMockModel(['I cannot help with this error.']),
    })

    const report = await analyzer.analyze({
      error: 'Build failed with syntax error',
      nodeId: 'build_step',
    })

    expect(report.rootCause).toContain('build_failure')
    expect(report.confidence).toBe(0.3)
  })

  it('includes past context flag when pastErrors provided', async () => {
    const llmResponse = JSON.stringify({
      rootCause: 'Recurring auth issue',
      causalChain: ['expired token'],
      affectedNodes: ['auth_node'],
      suggestedFixes: ['Refresh the token'],
      confidence: 0.85,
    })

    const analyzer = new RootCauseAnalyzer({
      llm: createMockModel([llmResponse]),
      pastErrors: [
        { error: 'Unauthorized: token expired', resolution: 'Refreshed token' },
      ],
    })

    const report = await analyzer.analyze({
      error: 'Unauthorized: invalid token',
      nodeId: 'auth_node',
    })

    expect(report.hasPastContext).toBe(true)
  })

  it('includes execution context in prompt', async () => {
    const llmResponse = JSON.stringify({
      rootCause: 'Previous node produced invalid output',
      causalChain: ['plan_step output malformed', 'gen_backend cannot parse plan'],
      affectedNodes: ['plan_step', 'gen_backend'],
      suggestedFixes: ['Validate plan_step output schema'],
      confidence: 0.78,
    })

    const mockModel = createMockModel([llmResponse])
    const analyzer = new RootCauseAnalyzer({ llm: mockModel })

    const report = await analyzer.analyze({
      error: 'Invalid plan format',
      nodeId: 'gen_backend',
      nodeType: 'generation',
      executionContext: [
        { nodeId: 'plan_step', output: '{"incomplete": true}' },
        { nodeId: 'validate_plan', error: 'Schema validation failed' },
      ],
    })

    expect(report.rootCause).toBe('Previous node produced invalid output')
    expect(report.affectedNodes).toContain('plan_step')

    // Verify the LLM was called with context
    const invokeCall = (mockModel.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(invokeCall).toBeDefined()
    const messages = invokeCall![0] as Array<{ content: string }>
    const humanContent = messages[1]!.content
    expect(humanContent).toContain('plan_step')
    expect(humanContent).toContain('validate_plan')
    expect(humanContent).toContain('Schema validation failed')
  })

  it('clamps confidence to 0-1 range', async () => {
    const llmResponse = JSON.stringify({
      rootCause: 'test',
      causalChain: [],
      affectedNodes: [],
      suggestedFixes: [],
      confidence: 1.5,
    })

    const analyzer = new RootCauseAnalyzer({
      llm: createMockModel([llmResponse]),
    })

    const report = await analyzer.analyze({
      error: 'some error',
      nodeId: 'node1',
    })

    expect(report.confidence).toBe(1.0)
  })

  it('handles negative confidence by clamping to 0', async () => {
    const llmResponse = JSON.stringify({
      rootCause: 'uncertain',
      causalChain: [],
      affectedNodes: [],
      suggestedFixes: [],
      confidence: -0.5,
    })

    const analyzer = new RootCauseAnalyzer({
      llm: createMockModel([llmResponse]),
    })

    const report = await analyzer.analyze({
      error: 'some error',
      nodeId: 'node1',
    })

    expect(report.confidence).toBe(0)
  })

  it('defaults to nodeId when affectedNodes is missing from LLM response', async () => {
    const llmResponse = JSON.stringify({
      rootCause: 'something broke',
      causalChain: ['step1'],
      suggestedFixes: ['fix it'],
      confidence: 0.5,
    })

    const analyzer = new RootCauseAnalyzer({
      llm: createMockModel([llmResponse]),
    })

    const report = await analyzer.analyze({
      error: 'error',
      nodeId: 'my_node',
    })

    expect(report.affectedNodes).toEqual(['my_node'])
  })

  it('respects maxPastErrors limit', async () => {
    const llmResponse = JSON.stringify({
      rootCause: 'repeated failure',
      causalChain: [],
      affectedNodes: ['n1'],
      suggestedFixes: ['fix'],
      confidence: 0.6,
    })

    const mockModel = createMockModel([llmResponse])
    const analyzer = new RootCauseAnalyzer({
      llm: mockModel,
      pastErrors: [
        { error: 'err1', resolution: 'res1' },
        { error: 'err2', resolution: 'res2' },
        { error: 'err3', resolution: 'res3' },
        { error: 'err4', resolution: 'res4' },
        { error: 'err5', resolution: 'res5' },
      ],
      maxPastErrors: 2,
    })

    await analyzer.analyze({
      error: 'new error',
      nodeId: 'n1',
    })

    const invokeCall = (mockModel.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    const messages = invokeCall![0] as Array<{ content: string }>
    const humanContent = messages[1]!.content

    // Only first 2 past errors should appear
    expect(humanContent).toContain('err1')
    expect(humanContent).toContain('err2')
    expect(humanContent).not.toContain('err3')
  })
})
