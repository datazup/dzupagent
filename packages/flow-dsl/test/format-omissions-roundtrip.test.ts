/**
 * F-R1 field-omission closure: every field here was authored, parsed, and
 * validated — and then silently dropped by the formatter (doc 14 DSL-01).
 * Each case round-trips a document through the fail-closed checked formatter
 * and asserts NO loss path, so a future formatter regression on any of these
 * fields fails loudly instead of shipping data loss.
 */
import { describe, expect, it } from 'vitest'
import type { FlowDocumentV1 } from '@dzupagent/flow-ast'

import { formatDocumentToDslChecked } from '../src/format-dsl.js'

function docWith(nodes: FlowDocumentV1['root']['nodes']): FlowDocumentV1 {
  return {
    dsl: 'dzupflow/v1',
    id: 'omission-fixture',
    version: 1,
    root: { type: 'sequence', id: 'root', nodes },
  }
}

function expectLossless(document: FlowDocumentV1): string {
  const result = formatDocumentToDslChecked(document)
  if (!result.ok) {
    throw new Error(
      `formatter lost authored fields: ${result.lossPaths.join(', ')}\n--- dsl ---\n${result.dsl}`,
    )
  }
  return result.dsl
}

describe('formatter field-omission round-trips (DSL-01)', () => {
  it('round-trips approval.approvalClass', () => {
    const dsl = expectLossless(
      docWith([
        {
          type: 'approval',
          id: 'gate',
          question: 'run the destructive step?',
          approvalClass: 'destructive_shell',
          onApprove: [{ type: 'complete', id: 'done', result: 'ok' }],
          onReject: [{ type: 'complete', id: 'stopped', result: 'stopped' }],
        },
      ]),
    )
    expect(dsl).toContain('approvalClass: destructive_shell')
  })

  it('round-trips spawn.input', () => {
    const dsl = expectLossless(
      docWith([
        {
          type: 'spawn',
          id: 'kickoff',
          templateRef: 'template:triage',
          input: { ticket: 'T-100', priority: 2, tags: ['bug', 'urgent'] },
          waitForCompletion: false,
        },
      ]),
    )
    expect(dsl).toContain('input:')
  })

  it('round-trips memory search query, limit, and outputVar', () => {
    const dsl = expectLossless(
      docWith([
        {
          type: 'memory',
          id: 'recall',
          operation: 'search',
          tier: 'project',
          query: 'related incidents for this service',
          limit: 5,
          outputVar: 'incidents',
        },
      ]),
    )
    expect(dsl).toContain('query:')
    expect(dsl).toContain('limit: 5')
  })

  it('round-trips memory write valueExpr', () => {
    expectLossless(
      docWith([
        {
          type: 'memory',
          id: 'remember',
          operation: 'write',
          tier: 'session',
          key: 'triage-verdict',
          valueExpr: '{{ state.verdict }}',
        },
      ]),
    )
  })

  it('round-trips http headers, body, and timeoutMs', () => {
    const dsl = expectLossless(
      docWith([
        {
          type: 'http',
          id: 'notify',
          url: 'https://example.test/hook',
          method: 'POST',
          headers: { 'X-Trace-Id': 'trace-1', Accept: 'application/json' },
          body: { event: 'triaged', count: 2 },
          timeoutMs: 3000,
          outputVar: 'hookResult',
        },
      ]),
    )
    expect(dsl).toContain('headers:')
    expect(dsl).toContain('timeoutMs: 3000')
  })

  it('round-trips the top-level durability policy block', () => {
    const document: FlowDocumentV1 = {
      dsl: 'dzupflow/v1',
      id: 'durable-flow',
      version: 1,
      durability: {
        mode: 'durable',
        checkpoint: {
          strategy: 'after_each_effect',
          storeRef: 'pg-main',
          includeEvents: true,
          retention: { ttlMs: 86_400_000, maxVersions: 10 },
        },
        resume: {
          onProcessRestart: 'resume_from_checkpoint',
          requireResumePoint: true,
          maxReplayNodes: 50,
        },
        executionLog: { storeRef: 'pg-main', eventHistory: 'compact' },
      },
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [{ type: 'complete', id: 'done', result: 'ok' }],
      },
    }
    const dsl = expectLossless(document)
    expect(dsl).toContain('durability:')
    expect(dsl).toContain('mode: durable')
  })
})
