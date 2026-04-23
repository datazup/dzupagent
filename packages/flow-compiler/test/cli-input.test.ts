import { describe, expect, it } from 'vitest'
import { InMemoryDomainToolRegistry } from '@dzupagent/app-tools'

import { compileTextInput, createFlowCompiler } from '../src/index.js'

function makeResolver(skillNames: string[]) {
  const registry = new InMemoryDomainToolRegistry()
  for (const name of skillNames) {
    const namespace = name.split('.')[0] ?? name
    registry.register({
      name,
      description: `test skill ${name}`,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      permissionLevel: 'read',
      sideEffects: [],
      namespace,
    })
  }
  return {
    resolve(ref: string) {
      const def = registry.get(ref)
      if (!def) return null
      return { ref, kind: 'skill' as const, inputSchema: def.inputSchema, handle: def }
    },
    listAvailable: () => registry.list().map((t) => t.name),
  }
}

describe('compileTextInput', () => {
  it('accepts canonical FlowDocument JSON text', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tasks.run']) })

    const result = await compileTextInput(
      compiler,
      JSON.stringify({
        dsl: 'dzupflow/v1',
        id: 'doc_flow',
        version: 1,
        root: {
          type: 'sequence',
          id: 'root',
          nodes: [{ type: 'action', id: 'run', toolRef: 'tasks.run', input: {} }],
        },
      }),
    )

    expect('errors' in result).toBe(false)
    const success = result as { target: string; artifact: { steps?: unknown[] } }
    expect(success.target).toBe('skill-chain')
    expect((success.artifact.steps ?? []).length).toBe(1)
  })

  it('accepts raw dzupflow DSL text when input is not JSON', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tasks.run']) })

    const result = await compileTextInput(
      compiler,
      `
dsl: dzupflow/v1
id: dsl_flow
version: 1
steps:
  - action:
      id: run
      ref: tasks.run
      input:
        mode: run
`,
    )

    expect('errors' in result).toBe(false)
    const success = result as { target: string; artifact: { steps?: unknown[] } }
    expect(success.target).toBe('skill-chain')
    expect((success.artifact.steps ?? []).length).toBe(1)
  })
})
