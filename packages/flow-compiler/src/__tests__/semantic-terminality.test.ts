/**
 * DSL-03 terminal-continuation validation: a `complete` node must never have
 * a normal continuation. Siblings after it are unreachable — surfaced as a
 * warning under the interactive admission profile and a hard error under
 * unattended.
 */
import { describe, expect, it } from 'vitest'

import type { FlowNode, ResolvedTool, SequenceNode, ToolResolver } from '@dzupagent/flow-ast'

import { semanticResolve } from '../stages/semantic.js'

const CODE = 'FLOW_UNREACHABLE_AFTER_TERMINAL'

const emptyToolResolver = (): ToolResolver => ({
  resolve: (): ResolvedTool | null => null,
  listAvailable: () => [],
})

const clarify = (question: string): FlowNode => ({ type: 'clarification', question })
const complete = (): FlowNode => ({ type: 'complete', result: 'done' })
const sequence = (...nodes: FlowNode[]): SequenceNode => ({ type: 'sequence', nodes })

const byCode = (diags: Array<{ code: string }>): Array<{ code: string }> =>
  diags.filter((d) => d.code === CODE)

describe('DSL-03 — unreachable work after terminal complete', () => {
  it('accepts a trailing complete: the rule does not fire without a later sibling', async () => {
    const result = await semanticResolve(sequence(clarify('first?'), complete()), {
      toolResolver: emptyToolResolver(),
    })

    expect(byCode(result.warnings)).toHaveLength(0)
    expect(byCode(result.errors)).toHaveLength(0)
  })

  it('warns (interactive) on a sibling after complete, anchored at the unreachable node', async () => {
    const result = await semanticResolve(sequence(complete(), clarify('never asked?')), {
      toolResolver: emptyToolResolver(),
    })

    const hits = byCode(result.warnings)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      code: CODE,
      nodeType: 'clarification',
      nodePath: 'root.nodes[1]',
    })
    // Interactive keeps it non-fatal.
    expect(byCode(result.errors)).toHaveLength(0)
  })

  it('rejects (unattended) a sibling after complete as a hard error', async () => {
    const result = await semanticResolve(sequence(complete(), clarify('never asked?')), {
      toolResolver: emptyToolResolver(),
      admissionProfile: 'unattended',
      referencePolicy: 'strict',
    })

    const hits = byCode(result.errors)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ code: CODE, nodePath: 'root.nodes[1]' })
    expect(byCode(result.warnings)).toHaveLength(0)
  })

  it('emits one diagnostic per list, on the FIRST unreachable sibling only', async () => {
    const result = await semanticResolve(
      sequence(complete(), clarify('dead-1?'), clarify('dead-2?')),
      { toolResolver: emptyToolResolver() },
    )

    const hits = byCode(result.warnings)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ nodePath: 'root.nodes[1]' })
  })

  it('detects the pattern inside a branch arm', async () => {
    const ast = sequence({
      type: 'branch',
      condition: 'ok',
      then: [complete(), clarify('dead?')],
      else: [clarify('alive?')],
    })

    const result = await semanticResolve(ast, { toolResolver: emptyToolResolver() })

    const hits = byCode(result.warnings)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ nodePath: 'root.nodes[0].then[1]' })
  })

  it('detects the pattern inside a parallel branch', async () => {
    const ast = sequence({
      type: 'parallel',
      branches: [[complete(), clarify('dead?')], [clarify('alive?')]],
    })

    const result = await semanticResolve(ast, { toolResolver: emptyToolResolver() })

    const hits = byCode(result.warnings)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ nodePath: 'root.nodes[0].branches[0][1]' })
  })

  it('a complete in one approval arm does not flag work in the OTHER arm', async () => {
    const ast = sequence({
      type: 'approval',
      question: 'ship it?',
      onApprove: [complete()],
      onReject: [clarify('why not?')],
    })

    const result = await semanticResolve(ast, { toolResolver: emptyToolResolver() })

    expect(byCode(result.warnings)).toHaveLength(0)
    expect(byCode(result.errors)).toHaveLength(0)
  })
})
