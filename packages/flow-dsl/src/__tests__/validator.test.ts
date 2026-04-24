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
    // Document is still produced; unsupported field is a warning
    expect(result.document).not.toBeNull()
    expect(result.diagnostics.some((d) => d.code === 'UNSUPPORTED_FIELD')).toBe(true)
  })

  it('normalizer always sets dsl to dzupflow/v1 regardless of input', () => {
    // The normalizer always coerces dsl to 'dzupflow/v1' (normalize.ts line ~158).
    // So even with 'dzupflow/v2' as input, no INVALID_DSL_VERSION is emitted
    // by the normalizer — validation against the zod schema may emit issues
    // about other fields instead.
    const dsl = MINIMAL_VALID_DSL.replace('dzupflow/v1', 'dzupflow/v2')
    const result = parseDslToDocument(dsl)
    // The document is still produced (normalizer always emits a doc)
    // but version checking happens separately via INVALID_ENUM_VALUE for version≠1
    expect(result.document).not.toBeNull()
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
