import { describe, it, expect } from 'vitest'

import { normalizeSteps } from '../normalize.js'
import type { DslDiagnostic } from '../types.js'

function diag(): DslDiagnostic[] {
  return []
}

// ── try_catch ─────────────────────────────────────────────────────────────────

describe('normalizeSteps — try_catch', () => {
  it('parses a minimal valid try_catch node', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{
        try_catch: {
          id: 'safe_op',
          body: [{ action: { id: 'a1', ref: 'tool.run', input: {} } }],
          catch: [{ complete: { result: 'recovered' } }],
        },
      }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    expect(nodes).toHaveLength(1)
    const node = nodes[0]!
    expect(node.type).toBe('try_catch')
    if (node.type === 'try_catch') {
      expect(node.body).toHaveLength(1)
      expect(node.catch).toHaveLength(1)
      expect(node.errorVar).toBeUndefined()
      expect(node.id).toBe('safe_op')
    }
  })

  it('accepts error_var alias for errorVar', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{
        try_catch: {
          error_var: 'myErr',
          body: [{ complete: {} }],
          catch: [{ complete: {} }],
        },
      }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'try_catch') {
      expect(node.errorVar).toBe('myErr')
    }
  })

  it('reports error when body is missing', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ try_catch: { catch: [{ complete: {} }] } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.message.includes('try_catch.body'))).toBe(true)
  })

  it('reports error when catch is missing', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ try_catch: { body: [{ complete: {} }] } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.message.includes('try_catch.catch'))).toBe(true)
  })
})

// ── loop ──────────────────────────────────────────────────────────────────────

describe('normalizeSteps — loop', () => {
  it('parses a minimal valid loop node', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{
        loop: {
          id: 'poll',
          condition: '{{ state.running }}',
          body: [{ complete: { result: 'iteration' } }],
        },
      }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    expect(node.type).toBe('loop')
    if (node.type === 'loop') {
      expect(node.condition).toBe('{{ state.running }}')
      expect(node.body).toHaveLength(1)
      expect(node.maxIterations).toBeUndefined()
    }
  })

  it('accepts maxIterations', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{
        loop: {
          condition: 'x',
          body: [{ complete: {} }],
          maxIterations: 50,
        },
      }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'loop') {
      expect(node.maxIterations).toBe(50)
    }
  })

  it('accepts max_iterations as alias', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{
        loop: {
          condition: 'x',
          body: [{ complete: {} }],
          max_iterations: 25,
        },
      }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'loop') expect(node.maxIterations).toBe(25)
  })

  it('reports error when condition is missing', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ loop: { body: [{ complete: {} }] } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.message.includes('loop.condition'))).toBe(true)
  })

  it('reports error when body is missing', () => {
    const diagnostics = diag()
    normalizeSteps(
      [{ loop: { condition: 'x' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics.some((d) => d.message.includes('loop.body'))).toBe(true)
  })
})

// ── http ──────────────────────────────────────────────────────────────────────

describe('normalizeSteps — http', () => {
  it('parses a minimal valid http node', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ http: { id: 'fetch_data', url: 'https://api.example.com/data' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    expect(node.type).toBe('http')
    if (node.type === 'http') {
      expect(node.url).toBe('https://api.example.com/data')
      expect(node.method).toBeUndefined()
    }
  })

  it('accepts all optional fields', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{
        http: {
          url: 'https://api.example.com/post',
          method: 'POST',
          headers: { Authorization: 'Bearer tok' },
          body: { key: 'val' },
          outputVar: 'apiResult',
        },
      }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'http') {
      expect(node.method).toBe('POST')
      expect(node.outputVar).toBe('apiResult')
    }
  })

  it('reports error when url is missing', () => {
    const diagnostics = diag()
    normalizeSteps([{ http: {} }], 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.message.includes('http.url'))).toBe(true)
  })

  it('reports error for invalid method', () => {
    const diagnostics = diag()
    normalizeSteps([{ http: { url: 'https://x.com', method: 'INVALID' } }], 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.message.includes('http.method'))).toBe(true)
  })
})

// ── wait ──────────────────────────────────────────────────────────────────────

describe('normalizeSteps — wait', () => {
  it('parses a valid wait node', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ wait: { id: 'pause', durationMs: 2000 } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    expect(node.type).toBe('wait')
    if (node.type === 'wait') {
      expect(node.durationMs).toBe(2000)
    }
  })

  it('accepts duration_ms alias', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ wait: { duration_ms: 500 } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'wait') expect(node.durationMs).toBe(500)
  })

  it('reports error when durationMs is missing', () => {
    const diagnostics = diag()
    normalizeSteps([{ wait: {} }], 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.message.includes('wait.durationMs'))).toBe(true)
  })
})

// ── subflow ───────────────────────────────────────────────────────────────────

describe('normalizeSteps — subflow', () => {
  it('parses a minimal valid subflow node', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ subflow: { id: 'inline_auth', flowRef: 'auth-flow-id' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    expect(node.type).toBe('subflow')
    if (node.type === 'subflow') {
      expect(node.flowRef).toBe('auth-flow-id')
      expect(node.input).toBeUndefined()
      expect(node.outputVar).toBeUndefined()
    }
  })

  it('accepts flow_ref alias', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ subflow: { flow_ref: 'other-flow' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'subflow') expect(node.flowRef).toBe('other-flow')
  })

  it('accepts optional input and outputVar', () => {
    const diagnostics = diag()
    const nodes = normalizeSteps(
      [{ subflow: { flowRef: 'flow-x', input: { param: 'val' }, outputVar: 'result' } }],
      'root.steps',
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const node = nodes[0]!
    if (node.type === 'subflow') {
      expect(node.input).toEqual({ param: 'val' })
      expect(node.outputVar).toBe('result')
    }
  })

  it('reports error when flowRef is missing', () => {
    const diagnostics = diag()
    normalizeSteps([{ subflow: {} }], 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.message.includes('subflow.flowRef'))).toBe(true)
  })
})
