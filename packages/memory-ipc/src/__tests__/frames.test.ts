import { describe, it, expect } from 'vitest'
import {
  TOOL_RESULT_SCHEMA,
  ToolResultFrameBuilder,
  CODEGEN_FRAME_SCHEMA,
  CodegenFrameBuilder,
  EVAL_FRAME_SCHEMA,
  EvalFrameBuilder,
  ENTITY_GRAPH_SCHEMA,
  EntityGraphFrameBuilder,
} from '../frames/index.js'
import { _fnv1aForTesting as fnv1a } from '../frames/codegen-frame.js'

// ---------------------------------------------------------------------------
// Schema field counts
// ---------------------------------------------------------------------------

describe('Frame schemas have correct field counts', () => {
  it('TOOL_RESULT_SCHEMA has 8 fields', () => {
    expect(TOOL_RESULT_SCHEMA.fields.length).toBe(8)
  })

  it('CODEGEN_FRAME_SCHEMA has 14 fields', () => {
    expect(CODEGEN_FRAME_SCHEMA.fields.length).toBe(14)
  })

  it('EVAL_FRAME_SCHEMA has 13 fields', () => {
    expect(EVAL_FRAME_SCHEMA.fields.length).toBe(13)
  })

  it('ENTITY_GRAPH_SCHEMA has 8 fields', () => {
    expect(ENTITY_GRAPH_SCHEMA.fields.length).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// ToolResultFrameBuilder
// ---------------------------------------------------------------------------

describe('ToolResultFrameBuilder', () => {
  it('builds from 50 results with correct schema', () => {
    const results = Array.from({ length: 50 }, (_, i) => ({
      key: `key-${i}`,
      value: `Result value number ${i} with some content`,
      score: i / 50,
      metadata: { index: i },
    }))

    const table = ToolResultFrameBuilder.fromToolOutput('git_status', results)

    expect(table.numRows).toBe(50)
    expect(table.numCols).toBe(8)

    // Verify tool_name is consistent
    for (let i = 0; i < 50; i++) {
      expect(table.getChild('tool_name')?.get(i)).toBe('git_status')
    }

    // Verify result_index is sequential
    expect(table.getChild('result_index')?.get(0)).toBe(0)
    expect(table.getChild('result_index')?.get(49)).toBe(49)

    // Verify keys
    expect(table.getChild('result_key')?.get(0)).toBe('key-0')
    expect(table.getChild('result_key')?.get(49)).toBe('key-49')

    // Verify values
    expect(table.getChild('result_value')?.get(0)).toBe(
      'Result value number 0 with some content',
    )

    // Verify relevance scores
    expect(table.getChild('relevance_score')?.get(0)).toBeCloseTo(0, 5)
    expect(table.getChild('relevance_score')?.get(25)).toBeCloseTo(0.5, 5)
  })

  it('computes token costs from value length', () => {
    const results = [
      { value: 'abcdefgh' },        // 8 chars -> ceil(8/4) = 2
      { value: 'ab' },              // 2 chars -> ceil(2/4) = 1
      { value: 'a'.repeat(100) },   // 100 chars -> ceil(100/4) = 25
    ]

    const table = ToolResultFrameBuilder.fromToolOutput('test_tool', results)

    expect(table.getChild('token_cost')?.get(0)).toBe(2)
    expect(table.getChild('token_cost')?.get(1)).toBe(1)
    expect(table.getChild('token_cost')?.get(2)).toBe(25)
  })

  it('uses custom charsPerToken', () => {
    const results = [{ value: 'a'.repeat(30) }] // 30 chars / 3 cpt = 10
    const table = ToolResultFrameBuilder.fromToolOutput('t', results, 3)
    expect(table.getChild('token_cost')?.get(0)).toBe(10)
  })

  it('handles null keys and metadata', () => {
    const results = [{ value: 'no key or meta' }]
    const table = ToolResultFrameBuilder.fromToolOutput('t', results)

    expect(table.getChild('result_key')?.get(0)).toBeNull()
    expect(table.getChild('relevance_score')?.get(0)).toBeNull()
    expect(table.getChild('metadata_json')?.get(0)).toBeNull()
  })

  it('serializes metadata as JSON', () => {
    const results = [{ value: 'v', metadata: { foo: 'bar', n: 42 } }]
    const table = ToolResultFrameBuilder.fromToolOutput('t', results)
    const json = table.getChild('metadata_json')?.get(0) as string
    expect(JSON.parse(json)).toEqual({ foo: 'bar', n: 42 })
  })

  it('populates timestamp as bigint', () => {
    const before = BigInt(Date.now())
    const table = ToolResultFrameBuilder.fromToolOutput('t', [{ value: 'v' }])
    const ts = table.getChild('timestamp')?.get(0) as bigint
    const after = BigInt(Date.now())
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('produces valid empty table', () => {
    const table = ToolResultFrameBuilder.fromToolOutput('empty', [])
    expect(table.numRows).toBe(0)
    expect(table.numCols).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// CodegenFrameBuilder
// ---------------------------------------------------------------------------

describe('CodegenFrameBuilder', () => {
  function makeFile(i: number): {
    path: string
    content: string
    language: string
    exports: string[]
    imports: string[]
    generatedBy: string
    hasTests: boolean
    testPass: boolean
    lintErrors: number
    complexityScore: number
  } {
    const lines = Array.from(
      { length: 10 + i },
      (_, l) => `// line ${l}`,
    ).join('\n')
    return {
      path: `src/file-${i}.ts`,
      content: lines,
      language: 'typescript',
      exports: [`Fn${i}`, `Type${i}`],
      imports: [`dep-${i}`],
      generatedBy: 'codegen-agent',
      hasTests: i % 2 === 0,
      testPass: i % 3 !== 0,
      lintErrors: i % 5,
      complexityScore: i * 0.1,
    }
  }

  it('builds from 20 files with correct row count', () => {
    const files = Array.from({ length: 20 }, (_, i) => makeFile(i))
    const table = CodegenFrameBuilder.fromGeneratedFiles(files)

    expect(table.numRows).toBe(20)
    expect(table.numCols).toBe(14)
  })

  it('computes LOC from content line count', () => {
    const table = CodegenFrameBuilder.fromGeneratedFiles([
      { path: 'a.ts', content: 'line1\nline2\nline3', language: 'typescript' },
    ])
    expect(table.getChild('loc')?.get(0)).toBe(3)
  })

  it('computes content hash via FNV-1a', () => {
    const content = 'hello world'
    const table = CodegenFrameBuilder.fromGeneratedFiles([
      { path: 'a.ts', content, language: 'typescript' },
    ])
    const hash = table.getChild('content_hash')?.get(0) as string
    expect(hash).toBe(fnv1a(content))
    // FNV-1a of 'hello world' should be a stable 8-char hex string
    expect(hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('counts imports and exports correctly', () => {
    const table = CodegenFrameBuilder.fromGeneratedFiles([
      {
        path: 'a.ts',
        content: 'x',
        language: 'typescript',
        imports: ['a', 'b', 'c'],
        exports: ['X', 'Y'],
      },
    ])
    expect(table.getChild('import_count')?.get(0)).toBe(3)
    expect(table.getChild('export_count')?.get(0)).toBe(2)
    const symbols = JSON.parse(
      table.getChild('export_symbols')?.get(0) as string,
    )
    expect(symbols).toEqual(['X', 'Y'])
  })

  it('defaults import/export counts to 0 when not provided', () => {
    const table = CodegenFrameBuilder.fromGeneratedFiles([
      { path: 'a.ts', content: 'x', language: 'typescript' },
    ])
    expect(table.getChild('import_count')?.get(0)).toBe(0)
    expect(table.getChild('export_count')?.get(0)).toBe(0)
    expect(table.getChild('export_symbols')?.get(0)).toBeNull()
  })

  it('computes token cost from content length', () => {
    const content = 'a'.repeat(80) // 80 chars / 4 = 20 tokens
    const table = CodegenFrameBuilder.fromGeneratedFiles([
      { path: 'a.ts', content, language: 'typescript' },
    ])
    expect(table.getChild('token_cost')?.get(0)).toBe(20)
  })

  it('handles has_tests and test_pass flags', () => {
    const table = CodegenFrameBuilder.fromGeneratedFiles([
      {
        path: 'a.ts',
        content: 'x',
        language: 'typescript',
        hasTests: true,
        testPass: false,
      },
      {
        path: 'b.ts',
        content: 'x',
        language: 'typescript',
      },
    ])
    expect(table.getChild('has_tests')?.get(0)).toBe(true)
    expect(table.getChild('test_pass')?.get(0)).toBe(false)
    expect(table.getChild('has_tests')?.get(1)).toBe(false)
    expect(table.getChild('test_pass')?.get(1)).toBeNull()
  })

  it('produces valid empty table', () => {
    const table = CodegenFrameBuilder.fromGeneratedFiles([])
    expect(table.numRows).toBe(0)
    expect(table.numCols).toBe(14)
  })
})

// ---------------------------------------------------------------------------
// EvalFrameBuilder
// ---------------------------------------------------------------------------

describe('EvalFrameBuilder', () => {
  function makeEval(i: number): {
    evalId: string
    testCase: string
    expected: string
    actual: string
    score: number
    dimension: string
    model: string
    latencyMs: number
    inputTokens: number
    outputTokens: number
    costUsd: number
    metadata: Record<string, unknown>
  } {
    return {
      evalId: `eval-${i}`,
      testCase: `test-case-${i}`,
      expected: `expected-${i}`,
      actual: `actual-${i}`,
      score: (i % 10) / 10,
      dimension: i % 2 === 0 ? 'accuracy' : 'relevance',
      model: i % 3 === 0 ? 'claude-3-haiku' : 'claude-3-sonnet',
      latencyMs: 100 + i * 10,
      inputTokens: 500 + i * 5,
      outputTokens: 200 + i * 2,
      costUsd: 0.001 * (i + 1),
      metadata: { iteration: i },
    }
  }

  it('builds from 100 eval results', () => {
    const results = Array.from({ length: 100 }, (_, i) => makeEval(i))
    const table = EvalFrameBuilder.fromEvalResults(results)

    expect(table.numRows).toBe(100)
    expect(table.numCols).toBe(13)
  })

  it('preserves eval IDs and test cases', () => {
    const results = [makeEval(0), makeEval(42)]
    const table = EvalFrameBuilder.fromEvalResults(results)

    expect(table.getChild('eval_id')?.get(0)).toBe('eval-0')
    expect(table.getChild('eval_id')?.get(1)).toBe('eval-42')
    expect(table.getChild('test_case')?.get(0)).toBe('test-case-0')
  })

  it('preserves scores and dimensions', () => {
    const results = Array.from({ length: 100 }, (_, i) => makeEval(i))
    const table = EvalFrameBuilder.fromEvalResults(results)

    // Check score for i=5 => 5/10 = 0.5
    expect(table.getChild('score')?.get(5)).toBeCloseTo(0.5, 5)

    // Check dimensions are dictionary-encoded strings
    expect(table.getChild('dimension')?.get(0)).toBe('accuracy')
    expect(table.getChild('dimension')?.get(1)).toBe('relevance')
  })

  it('preserves cost and token metrics', () => {
    const results = [makeEval(9)]
    const table = EvalFrameBuilder.fromEvalResults(results)

    expect(table.getChild('latency_ms')?.get(0)).toBeCloseTo(190, 5)
    expect(table.getChild('input_tokens')?.get(0)).toBe(545)
    expect(table.getChild('output_tokens')?.get(0)).toBe(218)
    expect(table.getChild('cost_usd')?.get(0)).toBeCloseTo(0.01, 5)
  })

  it('handles optional expected and actual', () => {
    const table = EvalFrameBuilder.fromEvalResults([
      {
        evalId: 'e1',
        testCase: 'tc1',
        score: 0.9,
        dimension: 'accuracy',
        model: 'gpt-4',
        latencyMs: 100,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.01,
      },
    ])
    expect(table.getChild('expected')?.get(0)).toBeNull()
    expect(table.getChild('actual')?.get(0)).toBeNull()
  })

  it('serializes metadata as JSON', () => {
    const results = [makeEval(0)]
    const table = EvalFrameBuilder.fromEvalResults(results)
    const json = table.getChild('metadata_json')?.get(0) as string
    expect(JSON.parse(json)).toEqual({ iteration: 0 })
  })

  it('handles null metadata', () => {
    const table = EvalFrameBuilder.fromEvalResults([
      {
        evalId: 'e1',
        testCase: 'tc1',
        score: 0.5,
        dimension: 'd',
        model: 'm',
        latencyMs: 100,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.01,
      },
    ])
    expect(table.getChild('metadata_json')?.get(0)).toBeNull()
  })

  it('produces valid empty table', () => {
    const table = EvalFrameBuilder.fromEvalResults([])
    expect(table.numRows).toBe(0)
    expect(table.numCols).toBe(13)
  })
})

// ---------------------------------------------------------------------------
// EntityGraphFrameBuilder
// ---------------------------------------------------------------------------

describe('EntityGraphFrameBuilder', () => {
  function makeEntity(i: number): {
    name: string
    type: string
    memoryKeys: string[]
    pagerankScore: number
    hubScore: number
    communityId: number
  } {
    return {
      name: `entity-${i}`,
      type: i % 3 === 0 ? 'person' : i % 3 === 1 ? 'concept' : 'tool',
      memoryKeys: Array.from({ length: (i % 5) + 1 }, (_, k) => `key-${i}-${k}`),
      pagerankScore: i * 0.02,
      hubScore: 1.0 - i * 0.01,
      communityId: i % 4,
    }
  }

  it('builds from 50 entities', () => {
    const entities = Array.from({ length: 50 }, (_, i) => makeEntity(i))
    const table = EntityGraphFrameBuilder.fromEntities(entities)

    expect(table.numRows).toBe(50)
    expect(table.numCols).toBe(8)
  })

  it('preserves entity names and types', () => {
    const entities = [makeEntity(0), makeEntity(1), makeEntity(2)]
    const table = EntityGraphFrameBuilder.fromEntities(entities)

    expect(table.getChild('entity_name')?.get(0)).toBe('entity-0')
    expect(table.getChild('entity_type')?.get(0)).toBe('person')
    expect(table.getChild('entity_type')?.get(1)).toBe('concept')
    expect(table.getChild('entity_type')?.get(2)).toBe('tool')
  })

  it('computes memory_key_count from memoryKeys array', () => {
    const entities = [
      { name: 'e1', memoryKeys: ['a', 'b', 'c'] },
      { name: 'e2', memoryKeys: [] },
      { name: 'e3', memoryKeys: ['x'] },
    ]
    const table = EntityGraphFrameBuilder.fromEntities(entities)

    expect(table.getChild('memory_key_count')?.get(0)).toBe(3)
    expect(table.getChild('memory_key_count')?.get(1)).toBe(0)
    expect(table.getChild('memory_key_count')?.get(2)).toBe(1)
  })

  it('serializes memory_keys_json as JSON array', () => {
    const entities = [{ name: 'e1', memoryKeys: ['k1', 'k2'] }]
    const table = EntityGraphFrameBuilder.fromEntities(entities)
    const json = table.getChild('memory_keys_json')?.get(0) as string
    expect(JSON.parse(json)).toEqual(['k1', 'k2'])
  })

  it('sets memory_keys_json to null for empty keys', () => {
    const entities = [{ name: 'e1', memoryKeys: [] as string[] }]
    const table = EntityGraphFrameBuilder.fromEntities(entities)
    expect(table.getChild('memory_keys_json')?.get(0)).toBeNull()
  })

  it('preserves graph metrics', () => {
    const entities = [makeEntity(10)]
    const table = EntityGraphFrameBuilder.fromEntities(entities)

    expect(table.getChild('pagerank_score')?.get(0)).toBeCloseTo(0.2, 5)
    expect(table.getChild('hub_score')?.get(0)).toBeCloseTo(0.9, 5)
    expect(table.getChild('community_id')?.get(0)).toBe(2) // 10 % 4
  })

  it('handles optional type and graph metrics', () => {
    const entities = [{ name: 'bare', memoryKeys: ['k'] }]
    const table = EntityGraphFrameBuilder.fromEntities(entities)

    expect(table.getChild('entity_type')?.get(0)).toBeNull()
    expect(table.getChild('pagerank_score')?.get(0)).toBeNull()
    expect(table.getChild('hub_score')?.get(0)).toBeNull()
    expect(table.getChild('community_id')?.get(0)).toBeNull()
  })

  it('populates updated_at as bigint', () => {
    const before = BigInt(Date.now())
    const table = EntityGraphFrameBuilder.fromEntities([
      { name: 'e', memoryKeys: [] },
    ])
    const ts = table.getChild('updated_at')?.get(0) as bigint
    const after = BigInt(Date.now())
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('produces valid empty table', () => {
    const table = EntityGraphFrameBuilder.fromEntities([])
    expect(table.numRows).toBe(0)
    expect(table.numCols).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// FNV-1a hash stability
// ---------------------------------------------------------------------------

describe('FNV-1a hash', () => {
  it('produces consistent 8-char hex output', () => {
    const h1 = fnv1a('hello')
    const h2 = fnv1a('hello')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{8}$/)
  })

  it('produces different hashes for different inputs', () => {
    expect(fnv1a('hello')).not.toBe(fnv1a('world'))
    expect(fnv1a('')).not.toBe(fnv1a('a'))
  })

  it('handles empty string', () => {
    const h = fnv1a('')
    expect(h).toMatch(/^[0-9a-f]{8}$/)
    // FNV-1a of empty string = offset basis = 0x811c9dc5
    expect(h).toBe('811c9dc5')
  })
})
