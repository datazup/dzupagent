/**
 * SC-12 — Zod-compatible schema pre-pass in the semantic stage.
 *
 * Confirms that a malformed AST reaching semanticResolve() (bypassing stage
 * 2 shape-validate) surfaces as typed ValidationError[] rather than a raw
 * throw.
 */

import type { FlowNode, ResolvedTool, ToolResolver } from '@dzupagent/flow-ast'
import { describe, expect, it } from 'vitest'

import { semanticResolve } from '../src/stages/semantic.js'

function emptyResolver(): ToolResolver {
  return {
    resolve: (): ResolvedTool | null => null,
    listAvailable: () => [],
  }
}

describe('semanticResolve — SC-12 schema pre-pass', () => {
  it('emits typed errors (not throws) when a downstream caller passes a malformed AST', async () => {
    // Directly constructed action node missing `input` — stage 2 would have
    // caught this, but SC-12's pre-pass in stage 3 is a defence-in-depth net.
    const ast = {
      type: 'action',
      toolRef: 't1',
      // input: {},  <-- deliberately omitted
    } as unknown as FlowNode

    // Must not throw — typed errors only.
    const result = await semanticResolve(ast, { toolResolver: emptyResolver() })

    expect(Array.isArray(result.errors)).toBe(true)
    const schemaIssue = result.errors.find((e) => e.message.startsWith('Schema validation failed'))
    expect(schemaIssue).toBeDefined()
    expect(schemaIssue!.code).toBe('MISSING_REQUIRED_FIELD')
    expect(schemaIssue!.nodePath).toContain('input')
  })

  it('is a no-op on well-formed ASTs (no schema issues in the errors array)', async () => {
    const ast: FlowNode = {
      type: 'action',
      toolRef: 'known.tool',
      input: {},
    }
    const resolver: ToolResolver = {
      resolve: (ref): ResolvedTool | null => ({
        ref,
        kind: 'skill',
        inputSchema: { type: 'object' },
        handle: { id: ref },
      }),
      listAvailable: () => ['known.tool'],
    }
    const result = await semanticResolve(ast, { toolResolver: resolver })
    const schemaIssues = result.errors.filter((e) => e.message.startsWith('Schema validation failed'))
    expect(schemaIssues).toEqual([])
    // Happy path also successfully resolves the tool ref.
    expect(result.resolved.size).toBe(1)
  })
})
