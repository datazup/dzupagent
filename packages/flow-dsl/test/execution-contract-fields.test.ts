/**
 * F-R1 field-codec registry: the execution-contract fields
 * (`effectClass`/`idempotency`/`resumePoint`) are admitted on the TYPED node
 * position for every kind and emitted by the formatter, driven by
 * `FLOW_EXECUTION_CONTRACT_FIELDS` (flow-ast field registry).
 *
 * Pre-registry defects pinned here:
 * - normalize swept authored `idempotency` into `node.meta.idempotency` while
 *   parse put it on `node.idempotency` (type-position mismatch),
 * - `effectClass` was parseable but rejected by normalize on most kinds,
 * - `resumePoint` survived normalize/parse/validate and was dropped by every
 *   formatter.
 */
import { describe, expect, it } from 'vitest'
import type { FlowDocumentV1 } from '@dzupagent/flow-ast'

import { DSL_ERROR } from '../src/errors.js'
import { formatDocumentToDslChecked } from '../src/format-dsl.js'
import { parseDslToDocument } from '../src/parse-dsl.js'

function docWith(nodes: FlowDocumentV1['root']['nodes']): FlowDocumentV1 {
  return {
    dsl: 'dzupflow/v1',
    id: 'contract-fixture',
    version: 1,
    root: { type: 'sequence', id: 'root', nodes },
  }
}

describe('execution-contract fields land on the typed position (registry-driven)', () => {
  it('normalizes authored idempotency onto node.idempotency, not meta', () => {
    const result = parseDslToDocument(
      [
        'dsl: dzupflow/v1',
        'id: typed-idempotency',
        'version: 1',
        'steps:',
        '  - http:',
        '      id: fetch',
        '      url: https://example.test/x',
        '      idempotency: at-least-once',
      ].join('\n'),
    )
    expect(result.diagnostics).toEqual([])
    const node = result.document?.root.nodes[0]
    expect(node).toMatchObject({ type: 'http', idempotency: 'at-least-once' })
    expect(node?.meta?.idempotency).toBeUndefined()
  })

  it('admits effectClass on kinds that previously rejected it', () => {
    const result = parseDslToDocument(
      [
        'dsl: dzupflow/v1',
        'id: generic-effect-class',
        'version: 1',
        'steps:',
        '  - http:',
        '      id: push',
        '      url: https://example.test/y',
        '      effectClass: network_write',
      ].join('\n'),
    )
    expect(result.diagnostics).toEqual([])
    expect(result.document?.root.nodes[0]).toMatchObject({
      type: 'http',
      effectClass: 'network_write',
    })
  })

  it('fails closed on an invalid effectClass value', () => {
    const result = parseDslToDocument(
      [
        'dsl: dzupflow/v1',
        'id: bad-effect-class',
        'version: 1',
        'steps:',
        '  - set:',
        '      id: mark',
        '      key: done',
        '      value: true',
        '      effectClass: read_only',
      ].join('\n'),
    )
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        path: expect.stringContaining('effectClass'),
      }),
    )
  })

  it('fails closed on an invalid idempotency value instead of sweeping it into meta', () => {
    const result = parseDslToDocument(
      [
        'dsl: dzupflow/v1',
        'id: bad-idempotency',
        'version: 1',
        'steps:',
        '  - emit:',
        '      id: notify',
        '      event: done',
        '      idempotency: whenever',
      ].join('\n'),
    )
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        path: expect.stringContaining('idempotency'),
      }),
    )
    expect(result.document?.root.nodes[0]?.meta?.idempotency).toBeUndefined()
  })

  it('fails closed on a non-boolean resumePoint', () => {
    const result = parseDslToDocument(
      [
        'dsl: dzupflow/v1',
        'id: bad-resume-point',
        'version: 1',
        'steps:',
        '  - checkpoint:',
        '      id: cp',
        '      label: mid',
        '      resumePoint: definitely',
      ].join('\n'),
    )
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        path: expect.stringContaining('resumePoint'),
      }),
    )
  })

  it('keeps adapter.run idempotency working through the generic path', () => {
    const result = parseDslToDocument(
      [
        'dsl: dzupflow/v1',
        'id: adapter-idempotency',
        'version: 1',
        'steps:',
        '  - adapter.run:',
        '      id: draft',
        '      provider: claude',
        '      instructions: write the plan',
        '      output: plan',
        '      idempotency: idempotent',
      ].join('\n'),
    )
    expect(result.diagnostics).toEqual([])
    expect(result.document?.root.nodes[0]).toMatchObject({
      type: 'adapter.run',
      idempotency: 'idempotent',
    })
  })
})

describe('execution-contract fields round-trip through the formatter', () => {
  it('round-trips effectClass/idempotency/resumePoint on several kinds losslessly', () => {
    const result = formatDocumentToDslChecked(
      docWith([
        {
          type: 'http',
          id: 'fetch',
          url: 'https://example.test/data',
          effectClass: 'network_write',
          idempotency: 'at-least-once',
        },
        {
          type: 'set',
          id: 'mark',
          key: 'done',
          value: true,
          effectClass: 'compute',
          resumePoint: true,
        },
        {
          type: 'shell.run',
          id: 'build',
          command: 'yarn build',
          output: 'buildLog',
          effectClass: 'file_write',
          idempotency: 'idempotent',
        },
      ]),
    )
    expect(result.ok, result.ok ? '' : result.lossPaths.join(', ')).toBe(true)
    expect(result.dsl).toContain('effectClass: network_write')
    expect(result.dsl).toContain('idempotency: at-least-once')
    expect(result.dsl).toContain('resumePoint: true')
  })

  it('round-trips an authored resumePoint: false (defined values must survive)', () => {
    const result = formatDocumentToDslChecked(
      docWith([
        {
          type: 'wait',
          id: 'pause',
          durationMs: 1000,
          resumePoint: false,
        },
      ]),
    )
    expect(result.ok, result.ok ? '' : result.lossPaths.join(', ')).toBe(true)
    expect(result.dsl).toContain('resumePoint: false')
  })
})
