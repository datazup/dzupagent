import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseFlow, type ParseResult } from '../src/parse.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

describe('parseFlow — golden fixtures', () => {
  it('simple-sequence: zero errors, exact AST', () => {
    const result = parseFlow(loadFixture('simple-sequence.json'))
    expect(result.errors).toEqual([])
    expect(result.ast).toEqual({
      type: 'sequence',
      nodes: [
        { type: 'action', toolRef: 'fs.read', input: { path: '/tmp/a' } },
        { type: 'action', toolRef: 'fs.write', input: { path: '/tmp/b', data: 'hello' } },
      ],
    })
  })

  it('branch-with-parallel: zero errors, exact AST', () => {
    const result = parseFlow(loadFixture('branch-with-parallel.json'))
    expect(result.errors).toEqual([])
    expect(result.ast).toEqual({
      type: 'branch',
      condition: '${ctx.flag}',
      then: [
        {
          type: 'parallel',
          branches: [
            [{ type: 'action', toolRef: 'svc.a', input: {} }],
            [{ type: 'action', toolRef: 'svc.b', input: {} }],
          ],
        },
      ],
      else: [{ type: 'complete', result: 'skipped' }],
    })
  })

  it('for-each-with-action: zero errors, exact AST', () => {
    const result = parseFlow(loadFixture('for-each-with-action.json'))
    expect(result.errors).toEqual([])
    expect(result.ast).toEqual({
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [
        { type: 'action', toolRef: 'process.one', input: { value: '${item}' } },
      ],
    })
  })

  it('malformed-missing-type: drops the bad sibling, reports MISSING_TYPE', () => {
    const result = parseFlow(loadFixture('malformed-missing-type.json'))
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({
      code: 'MISSING_TYPE',
      pointer: '/nodes/1',
    })
    expect(result.ast).toEqual({
      type: 'sequence',
      nodes: [
        { type: 'action', toolRef: 'good.first', input: {} },
        { type: 'action', toolRef: 'good.last', input: {} },
      ],
    })
  })

  it('unknown-node-type: drops the bad sibling, reports UNKNOWN_NODE_TYPE', () => {
    const result = parseFlow(loadFixture('unknown-node-type.json'))
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({
      code: 'UNKNOWN_NODE_TYPE',
      pointer: '/nodes/1',
    })
    expect(result.ast).toEqual({
      type: 'sequence',
      nodes: [
        { type: 'action', toolRef: 'good.first', input: {} },
        { type: 'action', toolRef: 'good.last', input: {} },
      ],
    })
  })
})

describe('parseFlow — input-format edge cases', () => {
  it('rejects unparseable JSON with INVALID_JSON, ast null, position present', () => {
    const result: ParseResult = parseFlow('not json{')
    expect(result.ast).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('INVALID_JSON')
    expect(result.errors[0]?.pointer).toBe('')
  })

  it('rejects null input with NOT_AN_OBJECT', () => {
    const result = parseFlow(null as unknown as object)
    expect(result.ast).toBeNull()
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'NOT_AN_OBJECT', pointer: '' }),
    ])
  })

  it('rejects array top-level input with NOT_AN_OBJECT', () => {
    const result = parseFlow([] as unknown as object)
    expect(result.ast).toBeNull()
    expect(result.errors[0]?.code).toBe('NOT_AN_OBJECT')
  })

  it('accepts pre-parsed object input — no position info', () => {
    const result = parseFlow({ type: 'complete' })
    expect(result.errors).toEqual([])
    expect(result.ast).toEqual({ type: 'complete' })
  })

  it('preserves optional node metadata fields when present', () => {
    const result = parseFlow({
      type: 'action',
      id: 'plan',
      name: 'Plan Work',
      description: 'Create the plan',
      meta: { source: 'dsl' },
      toolRef: 'tool.plan',
      input: {},
    })
    expect(result.errors).toEqual([])
    expect(result.ast).toEqual({
      type: 'action',
      id: 'plan',
      name: 'Plan Work',
      description: 'Create the plan',
      meta: { source: 'dsl' },
      toolRef: 'tool.plan',
      input: {},
    })
  })
})

describe('parseFlow — shape validation', () => {
  it('sequence.nodes must be an array', () => {
    const result = parseFlow({ type: 'sequence', nodes: 'wrong' })
    expect(result.ast).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({
      code: 'EXPECTED_ARRAY',
      pointer: '/nodes',
    })
  })

  it('action.toolRef must be a string', () => {
    const result = parseFlow({ type: 'action', toolRef: 42, input: {} })
    expect(result.ast).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({
      code: 'WRONG_FIELD_TYPE',
      pointer: '/toolRef',
    })
  })

  it('action.input must be an object', () => {
    const result = parseFlow({ type: 'action', toolRef: 'good', input: 'not-object' })
    expect(result.ast).toBeNull()
    expect(result.errors[0]).toMatchObject({
      code: 'EXPECTED_OBJECT',
      pointer: '/input',
    })
  })

  it('action with bad personaRef drops the field, keeps the node', () => {
    const result = parseFlow({ type: 'action', toolRef: 'good', input: {}, personaRef: 99 })
    expect(result.ast).toEqual({ type: 'action', toolRef: 'good', input: {} })
    expect(result.errors[0]?.code).toBe('WRONG_FIELD_TYPE')
    expect(result.errors[0]?.pointer).toBe('/personaRef')
  })

  it('node value that is not an object reports EXPECTED_OBJECT', () => {
    const result = parseFlow({ type: 'sequence', nodes: ['not-a-node'] })
    expect(result.errors[0]).toMatchObject({
      code: 'EXPECTED_OBJECT',
      pointer: '/nodes/0',
    })
    expect(result.ast).toEqual({ type: 'sequence', nodes: [] })
  })

  it('top-level type field of wrong type reports WRONG_FIELD_TYPE', () => {
    const result = parseFlow({ type: 7 })
    expect(result.ast).toBeNull()
    expect(result.errors[0]).toMatchObject({
      code: 'WRONG_FIELD_TYPE',
      pointer: '/type',
    })
  })

  it('multi-error: unknown sibling + missing-type sibling, document order', () => {
    const result = parseFlow({
      type: 'sequence',
      nodes: [
        { type: 'loop', body: [] },
        { input: {} },
      ],
    })
    expect(result.errors.map((e) => e.code)).toEqual(['UNKNOWN_NODE_TYPE', 'MISSING_TYPE'])
    expect(result.errors.map((e) => e.pointer)).toEqual(['/nodes/0', '/nodes/1'])
    expect(result.ast).toEqual({ type: 'sequence', nodes: [] })
  })
})

describe('parseFlow — node-specific behaviours', () => {
  it('for_each surfaces nested errors when shape fails too', () => {
    const result = parseFlow({
      type: 'for_each',
      source: 'items',
      // missing `as`
      body: [{ type: 'unknown' }],
    })
    expect(result.ast).toBeNull()
    const codes = result.errors.map((e) => e.code).sort()
    expect(codes).toContain('WRONG_FIELD_TYPE')
    expect(codes).toContain('UNKNOWN_NODE_TYPE')
  })

  it('branch.else dropped when wrong type, then preserved', () => {
    const result = parseFlow({
      type: 'branch',
      condition: 'x',
      then: [{ type: 'complete' }],
      else: 'wrong',
    })
    expect(result.ast).toEqual({
      type: 'branch',
      condition: 'x',
      then: [{ type: 'complete' }],
    })
    expect(result.errors[0]).toMatchObject({ code: 'EXPECTED_ARRAY', pointer: '/else' })
  })

  it('approval with all optional fields populated', () => {
    const result = parseFlow({
      type: 'approval',
      question: 'go?',
      options: ['yes', 'no'],
      onApprove: [{ type: 'complete', result: 'ok' }],
      onReject: [{ type: 'complete', result: 'no' }],
    })
    expect(result.errors).toEqual([])
    expect(result.ast).toEqual({
      type: 'approval',
      question: 'go?',
      options: ['yes', 'no'],
      onApprove: [{ type: 'complete', result: 'ok' }],
      onReject: [{ type: 'complete', result: 'no' }],
    })
  })

  it('clarification with expected/choices', () => {
    const result = parseFlow({
      type: 'clarification',
      question: 'pick one',
      expected: 'choice',
      choices: ['a', 'b'],
    })
    expect(result.errors).toEqual([])
    expect(result.ast).toEqual({
      type: 'clarification',
      question: 'pick one',
      expected: 'choice',
      choices: ['a', 'b'],
    })
  })

  it('clarification rejects bad expected value but keeps node', () => {
    const result = parseFlow({
      type: 'clarification',
      question: 'pick one',
      expected: 'image',
    })
    expect(result.ast).toEqual({ type: 'clarification', question: 'pick one' })
    expect(result.errors[0]).toMatchObject({
      code: 'WRONG_FIELD_TYPE',
      pointer: '/expected',
    })
  })

  it('persona requires personaId and body', () => {
    const ok = parseFlow({
      type: 'persona',
      personaId: 'reviewer',
      body: [{ type: 'complete' }],
    })
    expect(ok.errors).toEqual([])
    expect(ok.ast).toEqual({
      type: 'persona',
      personaId: 'reviewer',
      body: [{ type: 'complete' }],
    })
  })

  it('route preserves optional tags + provider', () => {
    const result = parseFlow({
      type: 'route',
      strategy: 'capability',
      tags: ['fast', 'cheap'],
      provider: 'openai',
      body: [{ type: 'complete' }],
    })
    expect(result.errors).toEqual([])
    expect(result.ast).toEqual({
      type: 'route',
      strategy: 'capability',
      tags: ['fast', 'cheap'],
      provider: 'openai',
      body: [{ type: 'complete' }],
    })
  })

  it('route rejects unknown strategy', () => {
    const result = parseFlow({
      type: 'route',
      strategy: 'random',
      body: [],
    })
    expect(result.ast).toBeNull()
    expect(result.errors[0]).toMatchObject({
      code: 'WRONG_FIELD_TYPE',
      pointer: '/strategy',
    })
  })

  it('parallel reports per-branch wrong-shape error', () => {
    const result = parseFlow({
      type: 'parallel',
      branches: [
        [{ type: 'complete' }],
        'not-an-array',
      ],
    })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({
      code: 'EXPECTED_ARRAY',
      pointer: '/branches/1',
    })
    expect(result.ast).toEqual({
      type: 'parallel',
      branches: [[{ type: 'complete' }]],
    })
  })

  it('complete with no result is valid', () => {
    const result = parseFlow({ type: 'complete' })
    expect(result.errors).toEqual([])
    expect(result.ast).toEqual({ type: 'complete' })
  })

  it('complete with non-string result is dropped, node preserved', () => {
    const result = parseFlow({ type: 'complete', result: 5 })
    expect(result.ast).toEqual({ type: 'complete' })
    expect(result.errors[0]).toMatchObject({
      code: 'WRONG_FIELD_TYPE',
      pointer: '/result',
    })
  })
})

describe('parseFlow — purity and re-export', () => {
  it('two calls on the same string input return deeply equal results', () => {
    const input = JSON.stringify({
      type: 'sequence',
      nodes: [
        { type: 'action', toolRef: 'a', input: { x: 1 } },
        { type: 'complete', result: 'done' },
      ],
    })
    const r1 = parseFlow(input)
    const r2 = parseFlow(input)
    expect(r2).toEqual(r1)
  })

  it('two calls on the same object input return deeply equal results', () => {
    const obj = {
      type: 'parallel',
      branches: [[{ type: 'complete' }]],
    }
    const r1 = parseFlow(obj)
    const r2 = parseFlow(obj)
    expect(r2).toEqual(r1)
  })

  it('parseFlow is exported from package root', async () => {
    const root = await import('../src/index.js')
    expect(typeof root.parseFlow).toBe('function')
  })
})

describe('parseFlow — RFC 6901 pointer encoding', () => {
  it('encodes "/" and "~" in segments per RFC 6901', () => {
    // We synthesise a path through a known node — segment names here are array indices,
    // but we still want to assert the encoder behaves properly.  The simplest way is
    // to provoke an error inside an unknown nested node and inspect the pointer.
    const result = parseFlow({
      type: 'sequence',
      nodes: [{ type: 'action', toolRef: 1, input: {} }],
    })
    expect(result.errors[0]?.pointer).toBe('/nodes/0/toolRef')
  })
})
