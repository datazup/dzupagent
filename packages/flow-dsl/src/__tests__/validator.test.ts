import { describe, it, expect } from 'vitest'

import type { FlowDocumentV1, FlowNode } from '@dzupagent/flow-ast'
import { validateDocument } from '../document-validate.js'
import { parseDslToDocument } from '../parse-dsl.js'
import { canonicalizeDsl } from '../canonicalize-dsl.js'

// ---------------------------------------------------------------------------
// validateDocument
// ---------------------------------------------------------------------------

function makeValidDoc(overrides: Partial<FlowDocumentV1> = {}): FlowDocumentV1 {
  return {
    dsl: 'dzupflow/v1',
    id: 'test',
    version: 1,
    root: {
      type: 'sequence',
      id: 'root',
      nodes: [
        // canonical docs require non-empty id on every node
        { type: 'action', id: 'action-1', toolRef: 'skill:a', input: {} },
      ],
    },
    ...overrides,
  }
}

describe('validateDocument', () => {
  it('returns valid=true for a well-formed document', () => {
    const result = validateDocument(makeValidDoc())
    expect(result.valid).toBe(true)
    expect(result.diagnostics).toHaveLength(0)
  })

  it('returns valid=false for null', () => {
    const result = validateDocument(null)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })

  it('returns valid=false for a plain string', () => {
    const result = validateDocument('not a document')
    expect(result.valid).toBe(false)
  })

  it('returns valid=false when dsl field is wrong', () => {
    const doc = makeValidDoc({ dsl: 'bad-dsl' as FlowDocumentV1['dsl'] })
    const result = validateDocument(doc)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })

  it('returns valid=false when id is missing', () => {
    const doc = makeValidDoc()
    const malformed: unknown = { ...doc, id: undefined }
    const result = validateDocument(malformed)
    expect(result.valid).toBe(false)
  })

  it('returns valid=false when version is missing', () => {
    const doc: unknown = { ...makeValidDoc(), version: undefined }
    const result = validateDocument(doc)
    expect(result.valid).toBe(false)
  })

  it('returns valid=false when root is missing', () => {
    const doc: unknown = { ...makeValidDoc(), root: undefined }
    const result = validateDocument(doc)
    expect(result.valid).toBe(false)
  })

  it('returns valid=false when root.nodes is empty array', () => {
    const doc = makeValidDoc({
      root: { type: 'sequence', id: 'root', nodes: [] },
    })
    const result = validateDocument(doc)
    // schema validation error for empty nodes (EMPTY_BODY)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })

  it('returns valid=false when an action node is missing toolRef', () => {
    // Empty toolRef fails schema validation
    const badNode: FlowNode = { type: 'action', id: 'bad-action', toolRef: '', input: {} }
    const doc = makeValidDoc({
      root: { type: 'sequence', id: 'root', nodes: [badNode] },
    })
    const result = validateDocument(doc)
    expect(result.valid).toBe(false)
  })

  it('returns valid=false for same-path output collisions', () => {
    const doc = makeValidDoc({
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          { type: 'prompt', id: 'first', userPrompt: 'first', outputKey: 'result' },
          { type: 'prompt', id: 'second', userPrompt: 'second', outputKey: 'result' },
        ],
      },
    })

    const result = validateDocument(doc)

    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        phase: 'validate',
        code: 'output_key_collision',
        path: 'root.nodes[1]',
      }),
    ])
  })

  it('returns valid=false for a sibling after terminal complete', () => {
    const doc = makeValidDoc({
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          { type: 'complete', id: 'done' },
          { type: 'action', id: 'never-runs', toolRef: 'skill:dead', input: {} },
        ],
      },
    })

    const result = validateDocument(doc)

    expect(result).toEqual({
      valid: false,
      diagnostics: [
        expect.objectContaining({
          phase: 'validate',
          code: 'unreachable_after_complete',
          path: 'root.nodes[1]',
        }),
      ],
    })
  })

  it('preserves output-key errors before unreachable-after-complete errors', () => {
    const doc = makeValidDoc({
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          { type: 'prompt', id: 'first', userPrompt: 'first', outputKey: 'result' },
          { type: 'complete', id: 'done' },
          { type: 'prompt', id: 'dead', userPrompt: 'dead', outputKey: 'result' },
        ],
      },
    })

    expect(validateDocument(doc).diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'output_key_collision',
      'unreachable_after_complete',
    ])
  })
})

// ---------------------------------------------------------------------------
// parseDslToDocument
// ---------------------------------------------------------------------------

const MINIMAL_VALID_DSL = `
dsl: dzupflow/v1
id: my-flow
version: 1
steps:
  - action:
      id: step1
      ref: skill:doSomething
      input:
`.trim()

describe('parseDslToDocument', () => {
  it('parses a minimal valid DSL string', () => {
    const result = parseDslToDocument(MINIMAL_VALID_DSL)
    expect(result.document).not.toBeNull()
    expect(result.document?.id).toBe('my-flow')
    expect(result.document?.dsl).toBe('dzupflow/v1')
  })

  it('returns diagnostics (no document) for invalid YAML (tabs)', () => {
    const result = parseDslToDocument('key: value\n\tchild: bad')
    expect(result.document).toBeNull()
    expect(result.diagnostics[0]?.phase).toBe('parse')
  })

  it('returns normalize diagnostics for unsupported top-level field', () => {
    const dsl = MINIMAL_VALID_DSL + '\nunknownField: value'
    const result = parseDslToDocument(dsl)
    expect(result.ok).toBe(false)
    expect(result.document).toBeNull()
    expect(result.partialDocument).not.toBeNull()
    expect(result.diagnostics.some((d) => d.code === 'UNSUPPORTED_FIELD')).toBe(true)
  })

  it('emits INVALID_DSL_VERSION diagnostic for unknown dsl discriminator', () => {
    const dsl = MINIMAL_VALID_DSL.replace('dzupflow/v1', 'dzupflow/v999')
    const result = parseDslToDocument(dsl)
    expect(result.ok).toBe(false)
    expect(result.document).toBeNull()
    expect(result.partialDocument).not.toBeNull()
    expect(result.diagnostics.some((d) => d.code === 'INVALID_DSL_VERSION')).toBe(true)
  })

  it('rejects parsed DSL with a sibling after terminal complete', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: unreachable
version: 1
steps:
  - complete:
      id: done
  - action:
      id: never-runs
      ref: skill:dead
      input: {}
`)

    expect(result.ok).toBe(false)
    expect(result.document).toBeNull()
    expect(result.partialDocument).not.toBeNull()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        phase: 'validate',
        code: 'unreachable_after_complete',
        path: 'root.nodes[1]',
      }),
    ])
  })
})

// ---------------------------------------------------------------------------
// canonicalizeDsl
// ---------------------------------------------------------------------------

describe('canonicalizeDsl', () => {
  it('returns ok=true for a valid DSL string', () => {
    const result = canonicalizeDsl(MINIMAL_VALID_DSL)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.document).not.toBeNull()
      expect(result.flowInput).not.toBeNull()
      expect(result.derivedGraph).not.toBeNull()
    }
  })

  it('returns ok=false for DSL with YAML syntax error', () => {
    const result = canonicalizeDsl('key: value\n\tchild: bad')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics.length).toBeGreaterThan(0)
      expect(result.document).toBeNull()
    }
  })

  it('returns ok=false when normalize diagnostics are present', () => {
    // Steps that fail normalization (no action.ref)
    const badDsl = `
dsl: dzupflow/v1
id: fail-flow
version: 1
steps:
  - action:
      input:
`.trim()
    const result = canonicalizeDsl(badDsl)
    // Normalize errors cause ok=false
    expect(result.ok).toBe(false)
  })

  it('produces a derivedGraph with nodes and edges', () => {
    const dsl = `
dsl: dzupflow/v1
id: graph-flow
version: 1
steps:
  - action:
      id: step1
      ref: skill:a
      input:
  - action:
      id: step2
      ref: skill:b
      input:
`.trim()
    const result = canonicalizeDsl(dsl)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.derivedGraph.nodes.length).toBeGreaterThanOrEqual(2)
    }
  })
})
