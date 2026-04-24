import { describe, it, expect } from 'vitest'

import { normalizeDslDocument, normalizeSteps } from '../normalize.js'

// ---------------------------------------------------------------------------
// Minimal valid raw documents / helpers
// ---------------------------------------------------------------------------

function makeMinimalRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dsl: 'dzupflow/v1',
    id: 'test-flow',
    version: 1,
    steps: [
      {
        action: {
          id: 'step1',
          ref: 'skill:doSomething',
          input: {},
        },
      },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// normalizeDslDocument
// ---------------------------------------------------------------------------

describe('normalizeDslDocument', () => {
  describe('top-level shape validation', () => {
    it('returns error when raw is not an object', () => {
      const { document, diagnostics } = normalizeDslDocument('not an object')
      expect(document).toBeNull()
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.code).toBe('INVALID_TOP_LEVEL_SHAPE')
      expect(diagnostics[0]?.phase).toBe('normalize')
    })

    it('returns error when raw is an array', () => {
      const { document, diagnostics } = normalizeDslDocument([{ action: {} }])
      expect(document).toBeNull()
      expect(diagnostics[0]?.code).toBe('INVALID_TOP_LEVEL_SHAPE')
    })

    it('returns error when raw is null', () => {
      const { document, diagnostics } = normalizeDslDocument(null)
      expect(document).toBeNull()
      expect(diagnostics.length).toBeGreaterThan(0)
    })

    it('warns about unsupported top-level field', () => {
      const raw = makeMinimalRaw({ unknownField: 'x' })
      const { diagnostics } = normalizeDslDocument(raw)
      const unsupported = diagnostics.filter((d) => d.code === 'UNSUPPORTED_FIELD')
      expect(unsupported.length).toBeGreaterThan(0)
      expect(unsupported[0]?.path).toBe('root.unknownField')
    })

    it('warns about graph-style "nodes" field with specific suggestion', () => {
      const raw = makeMinimalRaw({ nodes: [] })
      const { diagnostics } = normalizeDslDocument(raw)
      const d = diagnostics.find((x) => x.path === 'root.nodes')
      expect(d).toBeDefined()
      expect(d?.code).toBe('UNSUPPORTED_FIELD')
      expect(d?.suggestion).toBeDefined()
    })

    it('warns about graph-style "edges" field', () => {
      const raw = makeMinimalRaw({ edges: [] })
      const { diagnostics } = normalizeDslDocument(raw)
      const d = diagnostics.find((x) => x.path === 'root.edges')
      expect(d).toBeDefined()
      expect(d?.code).toBe('UNSUPPORTED_FIELD')
    })

    it('warns when version is not 1', () => {
      const raw = makeMinimalRaw({ version: 2 })
      const { diagnostics } = normalizeDslDocument(raw)
      const versionError = diagnostics.find((d) => d.path === 'root.version')
      expect(versionError).toBeDefined()
      expect(versionError?.code).toBe('INVALID_ENUM_VALUE')
    })
  })

  describe('valid minimal flow', () => {
    it('normalizes a minimal flow document', () => {
      const raw = makeMinimalRaw()
      const { document, diagnostics } = normalizeDslDocument(raw)
      expect(document).not.toBeNull()
      expect(diagnostics).toHaveLength(0)
      expect(document?.id).toBe('test-flow')
      expect(document?.dsl).toBe('dzupflow/v1')
      expect(document?.version).toBe(1)
    })

    it('preserves title and description', () => {
      const raw = makeMinimalRaw({ title: 'My Flow', description: 'A description' })
      const { document } = normalizeDslDocument(raw)
      expect(document?.title).toBe('My Flow')
      expect(document?.description).toBe('A description')
    })

    it('preserves tags array', () => {
      const raw = makeMinimalRaw({ tags: ['alpha', 'beta'] })
      const { document } = normalizeDslDocument(raw)
      expect(document?.tags).toEqual(['alpha', 'beta'])
    })

    it('preserves meta object', () => {
      const raw = makeMinimalRaw({ meta: { owner: 'team-a' } })
      const { document } = normalizeDslDocument(raw)
      expect(document?.meta?.['owner']).toBe('team-a')
    })

    it('produces a sequence root node', () => {
      const raw = makeMinimalRaw()
      const { document } = normalizeDslDocument(raw)
      expect(document?.root.type).toBe('sequence')
      expect(document?.root.id).toBe('root')
    })

    it('normalizes id to empty string when missing', () => {
      const raw = makeMinimalRaw()
      delete raw['id']
      const { document } = normalizeDslDocument(raw)
      expect(document?.id).toBe('')
    })
  })

  describe('steps array', () => {
    it('errors when steps is missing', () => {
      const raw = makeMinimalRaw()
      delete raw['steps']
      const { diagnostics } = normalizeDslDocument(raw)
      expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path === 'root.steps')).toBe(true)
    })

    it('errors when steps is not an array', () => {
      const raw = makeMinimalRaw({ steps: 'bad' })
      const { diagnostics } = normalizeDslDocument(raw)
      expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path === 'root.steps')).toBe(true)
    })
  })

  describe('inputs', () => {
    it('normalizes shorthand string type input', () => {
      const raw = makeMinimalRaw({ inputs: { name: 'string' } })
      const { document, diagnostics } = normalizeDslDocument(raw)
      expect(diagnostics.filter((d) => d.path?.startsWith('root.inputs')).length).toBe(0)
      expect(document?.inputs?.['name']).toEqual({ type: 'string', required: true })
    })

    it('normalizes full input spec object', () => {
      const raw = makeMinimalRaw({
        inputs: {
          count: {
            type: 'number',
            required: false,
            description: 'The count',
            default: 5,
          },
        },
      })
      const { document, diagnostics } = normalizeDslDocument(raw)
      expect(diagnostics.filter((d) => d.path?.startsWith('root.inputs')).length).toBe(0)
      expect(document?.inputs?.['count']).toEqual({
        type: 'number',
        required: false,
        description: 'The count',
        default: 5,
      })
    })

    it('errors on unsupported input type', () => {
      const raw = makeMinimalRaw({ inputs: { x: 'invalid-type' } })
      const { diagnostics } = normalizeDslDocument(raw)
      expect(diagnostics.some((d) => d.code === 'INVALID_INPUT_SPEC')).toBe(true)
    })

    it('errors on non-object inputs value', () => {
      const raw = makeMinimalRaw({ inputs: 'bad' })
      const { diagnostics } = normalizeDslDocument(raw)
      expect(diagnostics.some((d) => d.code === 'INVALID_INPUT_SPEC' && d.path === 'root.inputs')).toBe(true)
    })

    it('errors on invalid default value (function)', () => {
      const raw = makeMinimalRaw({ inputs: { x: { type: 'string', default: () => {} } } })
      const { diagnostics } = normalizeDslDocument(raw)
      expect(diagnostics.some((d) => d.code === 'INVALID_INPUT_SPEC')).toBe(true)
    })

    it('accepts all valid input types', () => {
      const types = ['string', 'number', 'boolean', 'object', 'array', 'any']
      for (const t of types) {
        const raw = makeMinimalRaw({ inputs: { x: t } })
        const { diagnostics } = normalizeDslDocument(raw)
        const inputErrors = diagnostics.filter((d) => d.path === `root.inputs.x`)
        expect(inputErrors).toHaveLength(0)
      }
    })
  })

  describe('defaults', () => {
    it('normalizes persona default (camelCase)', () => {
      const raw = makeMinimalRaw({ defaults: { personaRef: 'assistant' } })
      const { document } = normalizeDslDocument(raw)
      expect(document?.defaults?.personaRef).toBe('assistant')
    })

    it('normalizes persona default (snake_case alias)', () => {
      const raw = makeMinimalRaw({ defaults: { persona: 'coach' } })
      const { document } = normalizeDslDocument(raw)
      expect(document?.defaults?.personaRef).toBe('coach')
    })

    it('normalizes timeout_ms', () => {
      const raw = makeMinimalRaw({ defaults: { timeout_ms: 5000 } })
      const { document } = normalizeDslDocument(raw)
      expect(document?.defaults?.timeoutMs).toBe(5000)
    })

    it('normalizes retry config', () => {
      const raw = makeMinimalRaw({ defaults: { retry: { attempts: 3, delayMs: 100 } } })
      const { document } = normalizeDslDocument(raw)
      expect(document?.defaults?.retry).toEqual({ attempts: 3, delayMs: 100 })
    })

    it('errors when defaults is not an object', () => {
      const raw = makeMinimalRaw({ defaults: 'bad' })
      const { diagnostics } = normalizeDslDocument(raw)
      expect(diagnostics.some((d) => d.code === 'INVALID_TOP_LEVEL_SHAPE' && d.path === 'root.defaults')).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// normalizeSteps — action node
// ---------------------------------------------------------------------------

describe('normalizeSteps — action', () => {
  it('normalizes a valid action node with ref', () => {
    const raw = [{ action: { id: 'a1', ref: 'skill:foo', input: { x: 1 } } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type).toBe('action')
    expect((nodes[0] as { toolRef?: string }).toolRef).toBe('skill:foo')
    expect(diagnostics).toHaveLength(0)
  })

  it('normalizes action with toolRef alias', () => {
    const raw = [{ action: { toolRef: 'skill:bar', input: {} } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect((nodes[0] as { toolRef?: string }).toolRef).toBe('skill:bar')
  })

  it('errors when action.ref is missing', () => {
    const raw = [{ action: { input: {} } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('normalizes persona field from action', () => {
    const raw = [{ action: { ref: 'skill:x', input: {}, persona: 'coach' } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect((nodes[0] as { personaRef?: string }).personaRef).toBe('coach')
  })

  it('errors on unsupported field in action', () => {
    const raw = [{ action: { ref: 'skill:x', input: {}, on_error: 'handle' } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'UNSUPPORTED_FIELD')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeSteps — if / branch node
// ---------------------------------------------------------------------------

describe('normalizeSteps — if (branch)', () => {
  function makeActionStep(ref: string) {
    return { action: { ref, input: {} } }
  }

  it('normalizes a valid if node', () => {
    const raw = [{
      if: {
        condition: 'x > 0',
        then: [makeActionStep('skill:a')],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes[0]?.type).toBe('branch')
    expect(diagnostics).toHaveLength(0)
  })

  it('errors when if.condition is missing', () => {
    const raw = [{
      if: {
        then: [makeActionStep('skill:a')],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('errors when if.then is empty', () => {
    const raw = [{
      if: {
        condition: 'x > 0',
        then: [],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'EMPTY_BRANCH_BODY')).toBe(true)
  })

  it('normalizes else branch', () => {
    const raw = [{
      if: {
        condition: 'x > 0',
        then: [makeActionStep('skill:a')],
        else: [makeActionStep('skill:b')],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    const branch = nodes[0] as { else?: unknown[] }
    expect(branch.else).toHaveLength(1)
    expect(diagnostics).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// normalizeSteps — parallel node
// ---------------------------------------------------------------------------

describe('normalizeSteps — parallel', () => {
  it('normalizes a valid parallel with two branches', () => {
    const raw = [{
      parallel: {
        branches: {
          branchA: [{ action: { ref: 'skill:a', input: {} } }],
          branchB: [{ action: { ref: 'skill:b', input: {} } }],
        },
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes[0]?.type).toBe('parallel')
    expect(diagnostics.filter((d) => d.code !== 'INVALID_NODE_SHAPE')).toHaveLength(0)
  })

  it('errors when parallel.branches has only one branch', () => {
    const raw = [{
      parallel: {
        branches: {
          only: [{ action: { ref: 'skill:a', input: {} } }],
        },
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'INVALID_NODE_SHAPE')).toBe(true)
  })

  it('errors when parallel.branches is not an object', () => {
    const raw = [{ parallel: { branches: 'bad' } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('errors when a branch body is empty', () => {
    const raw = [{
      parallel: {
        branches: {
          branchA: [],
          branchB: [{ action: { ref: 'skill:b', input: {} } }],
        },
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'EMPTY_BRANCH_BODY')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeSteps — for_each node
// ---------------------------------------------------------------------------

describe('normalizeSteps — for_each', () => {
  it('normalizes a valid for_each node', () => {
    const raw = [{
      for_each: {
        source: 'items',
        as: 'item',
        body: [{ action: { ref: 'skill:process', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes[0]?.type).toBe('for_each')
    expect(diagnostics).toHaveLength(0)
  })

  it('errors when for_each.source is missing', () => {
    const raw = [{
      for_each: {
        as: 'item',
        body: [{ action: { ref: 'skill:x', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path.includes('source'))).toBe(true)
  })

  it('errors when for_each.as is missing', () => {
    const raw = [{
      for_each: {
        source: 'items',
        body: [{ action: { ref: 'skill:x', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD' && d.path.includes('.as'))).toBe(true)
  })

  it('errors when for_each.body is empty', () => {
    const raw = [{
      for_each: {
        source: 'items',
        as: 'item',
        body: [],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'EMPTY_BRANCH_BODY')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeSteps — approval node
// ---------------------------------------------------------------------------

describe('normalizeSteps — approval', () => {
  it('normalizes a valid approval node', () => {
    const raw = [{
      approval: {
        question: 'Proceed?',
        on_approve: [{ action: { ref: 'skill:proceed', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes[0]?.type).toBe('approval')
    expect(diagnostics).toHaveLength(0)
  })

  it('errors when approval.question is missing', () => {
    const raw = [{
      approval: {
        on_approve: [{ action: { ref: 'skill:proceed', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })

  it('errors when on_approve is empty', () => {
    const raw = [{
      approval: {
        question: 'Proceed?',
        on_approve: [],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'EMPTY_BRANCH_BODY')).toBe(true)
  })

  it('normalizes options array', () => {
    const raw = [{
      approval: {
        question: 'Proceed?',
        options: ['yes', 'no'],
        on_approve: [{ action: { ref: 'skill:proceed', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    const approval = nodes[0] as { options?: string[] }
    expect(approval.options).toEqual(['yes', 'no'])
  })

  it('normalizes onApprove camelCase alias', () => {
    const raw = [{
      approval: {
        question: 'Proceed?',
        onApprove: [{ action: { ref: 'skill:x', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes[0]?.type).toBe('approval')
    expect(diagnostics).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// normalizeSteps — clarify node
// ---------------------------------------------------------------------------

describe('normalizeSteps — clarify', () => {
  it('normalizes a valid clarify node', () => {
    const raw = [{ clarify: { question: 'What is your name?' } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes[0]?.type).toBe('clarification')
    expect(diagnostics).toHaveLength(0)
  })

  it('normalizes expected=text', () => {
    const raw = [{ clarify: { question: 'What?', expected: 'text' } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect((nodes[0] as { expected?: string }).expected).toBe('text')
  })

  it('errors on invalid expected value', () => {
    const raw = [{ clarify: { question: 'What?', expected: 'image' } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'INVALID_ENUM_VALUE')).toBe(true)
  })

  it('normalizes choices array', () => {
    const raw = [{ clarify: { question: 'Which?', expected: 'choice', choices: ['A', 'B'] } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    const clarify = nodes[0] as { choices?: string[] }
    expect(clarify.choices).toEqual(['A', 'B'])
  })
})

// ---------------------------------------------------------------------------
// normalizeSteps — persona node
// ---------------------------------------------------------------------------

describe('normalizeSteps — persona', () => {
  it('normalizes a valid persona node', () => {
    const raw = [{
      persona: {
        ref: 'expert',
        body: [{ action: { ref: 'skill:explain', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes[0]?.type).toBe('persona')
    expect((nodes[0] as { personaId?: string }).personaId).toBe('expert')
    expect(diagnostics).toHaveLength(0)
  })

  it('errors when persona.ref is missing', () => {
    const raw = [{
      persona: {
        body: [{ action: { ref: 'skill:explain', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'MISSING_REQUIRED_FIELD')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeSteps — route node
// ---------------------------------------------------------------------------

describe('normalizeSteps — route', () => {
  it('normalizes a valid route node with capability strategy', () => {
    const raw = [{
      route: {
        strategy: 'capability',
        tags: ['fast'],
        body: [{ action: { ref: 'skill:run', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes[0]?.type).toBe('route')
    expect(diagnostics).toHaveLength(0)
  })

  it('normalizes a valid route node with fixed-provider strategy', () => {
    const raw = [{
      route: {
        strategy: 'fixed-provider',
        provider: 'openai',
        body: [{ action: { ref: 'skill:run', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics).toHaveLength(0)
  })

  it('errors when strategy is invalid', () => {
    const raw = [{
      route: {
        strategy: 'bad-strategy',
        body: [{ action: { ref: 'skill:run', input: {} } }],
      },
    }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'INVALID_ENUM_VALUE')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeSteps — complete node
// ---------------------------------------------------------------------------

describe('normalizeSteps — complete', () => {
  it('normalizes a valid complete node', () => {
    const raw = [{ complete: {} }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes[0]?.type).toBe('complete')
    expect(diagnostics).toHaveLength(0)
  })

  it('normalizes complete with string result', () => {
    const raw = [{ complete: { result: 'done' } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect((nodes[0] as { result?: string }).result).toBe('done')
    expect(diagnostics).toHaveLength(0)
  })

  it('errors when result is not a string', () => {
    const raw = [{ complete: { result: 42 } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'INVALID_NODE_SHAPE')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeSteps — unknown node type
// ---------------------------------------------------------------------------

describe('normalizeSteps — unknown node type', () => {
  it('emits UNKNOWN_NODE_TYPE for unrecognized wrapper key', () => {
    const raw = [{ widget: { something: true } }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    const nodes = normalizeSteps(raw, 'root.steps', diagnostics)
    expect(nodes).toHaveLength(0)
    expect(diagnostics.some((d) => d.code === 'UNKNOWN_NODE_TYPE')).toBe(true)
  })

  it('errors when step item is not an object', () => {
    const raw = ['string-step']
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'INVALID_NODE_SHAPE')).toBe(true)
  })

  it('errors when step item has multiple keys', () => {
    const raw = [{ action: {}, if: {} }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'INVALID_NODE_SHAPE')).toBe(true)
  })

  it('errors when node wrapper value is not an object', () => {
    const raw = [{ action: 'bad' }]
    const diagnostics: Parameters<typeof normalizeSteps>[2] = []
    normalizeSteps(raw, 'root.steps', diagnostics)
    expect(diagnostics.some((d) => d.code === 'INVALID_NODE_SHAPE')).toBe(true)
  })
})
