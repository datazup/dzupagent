import type {
  FlowDocumentV1,
  ResolvedTool,
  SequenceNode,
  ToolResolver,
} from '@dzupagent/flow-ast'
import { describe, expect, it } from 'vitest'

import {
  createFlowCompiler,
  prepareFlowInputFromDocument,
} from '../index.js'

const toolResolver: ToolResolver = {
  resolve: (): ResolvedTool | null => null,
  listAvailable: () => [],
}

const unreachableRoot = (): SequenceNode => ({
  type: 'sequence',
  id: 'root',
  nodes: [
    { type: 'complete', id: 'done' },
    {
      type: 'action',
      id: 'never-runs',
      toolRef: 'tool.dead',
      input: {},
    },
  ],
})

const unreachableDocument = (): FlowDocumentV1 => ({
  dsl: 'dzupflow/v1',
  id: 'unreachable',
  version: 1,
  root: unreachableRoot(),
})

const unreachableDsl = `
dsl: dzupflow/v1
id: unreachable
version: 1
steps:
  - complete:
      id: done
  - action:
      id: never-runs
      ref: tool.dead
      input: {}
`

const orderedErrorRoot = (): FlowDocumentV1['root'] => ({
  type: 'sequence',
  id: 'root',
  nodes: [
    { type: 'prompt', id: 'first', userPrompt: 'first', outputKey: 'result' },
    { type: 'complete', id: 'done' },
    { type: 'prompt', id: 'dead', userPrompt: 'dead', outputKey: 'result' },
  ],
})

describe('canonical unreachable-after-complete compiler admission', () => {
  it('rejects the direct compile path under the default interactive profile', async () => {
    const result = await createFlowCompiler({ toolResolver }).compile(unreachableRoot())

    expect('errors' in result).toBe(true)
    if (!('errors' in result)) throw new Error('expected compile failure')
    expect(result.errors).toEqual([
      expect.objectContaining({
        stage: 2,
        code: 'unreachable_after_complete',
        nodePath: 'root.nodes[1]',
      }),
    ])
  })

  it('rejects the canonical document compile path before lowering', async () => {
    const result = await createFlowCompiler({ toolResolver }).compileDocument(
      unreachableDocument(),
    )

    expect('errors' in result).toBe(true)
    if (!('errors' in result)) throw new Error('expected compile failure')
    expect(result.errors).toEqual([
      expect.objectContaining({
        stage: 2,
        code: 'unreachable_after_complete',
        nodePath: 'root.nodes[1]',
      }),
    ])
  })

  it('rejects the textual DSL compile path before lowering', async () => {
    const result = await createFlowCompiler({ toolResolver }).compileDsl(unreachableDsl)

    expect('errors' in result).toBe(true)
    if (!('errors' in result)) throw new Error('expected compile failure')
    expect(result.errors).toEqual([
      expect.objectContaining({
        stage: 2,
        code: 'unreachable_after_complete',
        nodePath: 'root.nodes[1]',
      }),
    ])
  })

  it('keeps output-key collisions before reachability errors in document preparation', () => {
    const document: FlowDocumentV1 = {
      dsl: 'dzupflow/v1',
      id: 'ordered-errors',
      version: 1,
      root: orderedErrorRoot(),
    }

    const prepared = prepareFlowInputFromDocument(document)

    expect(prepared.ok).toBe(false)
    if (prepared.ok) throw new Error('expected document preparation failure')
    expect(prepared.errors.map((error) => [error.code, error.nodePath])).toEqual([
      ['output_key_collision', 'root.nodes[2]'],
      ['unreachable_after_complete', 'root.nodes[2]'],
    ])
  })

  it('keeps the same error order in the direct compiler path', async () => {
    const result = await createFlowCompiler({ toolResolver }).compile(orderedErrorRoot())

    expect('errors' in result).toBe(true)
    if (!('errors' in result)) throw new Error('expected compile failure')
    expect(result.errors.map((error) => [error.code, error.nodePath])).toEqual([
      ['output_key_collision', 'root.nodes[2]'],
      ['unreachable_after_complete', 'root.nodes[2]'],
    ])
  })
})
