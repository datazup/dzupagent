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

  it('returns valid=true for top-level policy and template-backed agent authoring', () => {
    const result = validateDocument(makeValidDoc({
      policy: {
        budgetCents: 250,
        timeoutMs: 10_000,
        workingDirectory: 'packages/flow-dsl',
      },
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [{
          type: 'agent',
          id: 'agent-1',
          agentId: 'reviewer',
          instructions: '',
          template: { ref: 'templates.review' },
          output: { key: 'review', schema: { type: 'object' } },
        }],
      },
    }))
    expect(result.valid).toBe(true)
  })

  it('returns valid=false for malformed top-level policy and malformed template fallback', () => {
    const result = validateDocument(makeValidDoc({
      policy: {
        budgetCents: 0,
      },
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [{
          type: 'agent',
          id: 'agent-1',
          agentId: 'reviewer',
          instructions: '',
          template: { ref: '' },
          output: { key: 'review', schema: { type: 'object' } },
        }],
      },
    }))
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some((d) => String(d.path).includes('policy'))).toBe(true)
    expect(result.diagnostics.some((d) => String(d.path).includes('template'))).toBe(true)
    expect(result.diagnostics.some((d) => String(d.path).includes('instructions'))).toBe(true)
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
    const dsl = MINIMAL_VALID_DSL.replace('dzupflow/v1', 'dzupflow/v2')
    const result = parseDslToDocument(dsl)
    expect(result.ok).toBe(false)
    expect(result.document).toBeNull()
    expect(result.partialDocument).not.toBeNull()
    expect(result.diagnostics.some((d) => d.code === 'INVALID_DSL_VERSION')).toBe(true)
  })

  it('preserves policy, template-only agents, and inline agent validate from UTF-8 DSL text', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: agent-flow
version: 1
policy:
  budgetCents: 500
  timeoutMs: 30000
  workingDirectory: packages/flow-dsl
steps:
  - agent:
      id: agent-step
      agentId: reviewer
      template:
        ref: templates.review
        inputDefaults:
          severity: high
      output:
        key: review
        schema:
          type: object
      validate:
        schema:
          type: object
        failBehavior: retry
        maxRetries: 1
`.trim())

    expect(result.ok).toBe(true)
    expect(result.document?.policy).toEqual({
      budgetCents: 500,
      timeoutMs: 30000,
      workingDirectory: 'packages/flow-dsl',
    })
    const node = result.document?.root.nodes[0]
    expect(node).toMatchObject({
      type: 'agent',
      template: {
        ref: 'templates.review',
        inputDefaults: { severity: 'high' },
      },
      validate: {
        schema: { type: 'object' },
        failBehavior: 'retry',
        maxRetries: 1,
      },
    })
  })

  it('rejects malformed policy and inline agent validate from DSL text', () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: agent-flow
version: 1
policy:
  timeoutMs: 0
steps:
  - agent:
      id: agent-step
      agentId: reviewer
      output:
        key: review
        schema:
          type: object
      validate:
        failBehavior: explode
`.trim())

    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((d) => d.path === 'root.policy.timeoutMs')).toBe(true)
    expect(result.diagnostics.some((d) => d.path === 'root.steps[0].instructions')).toBe(true)
    expect(result.diagnostics.some((d) => d.path === 'root.steps[0].validate.schema')).toBe(true)
    expect(result.diagnostics.some((d) => d.path === 'root.steps[0].validate.failBehavior')).toBe(true)
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
