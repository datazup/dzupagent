/**
 * Unit tests for lower-checkpoint Stage 4 lowerers + cross-node semantic
 * checks for checkpoint / restore nodes.
 */

import type {
  ActionNode,
  CheckpointNode,
  FlowNode,
  ResolvedTool,
  RestoreNode,
  SequenceNode,
  ToolResolver,
} from '@dzupagent/flow-ast'
import { describe, expect, it } from 'vitest'

import {
  lowerCheckpointNode,
  lowerRestoreNode,
} from '../src/lower/lower-checkpoint.js'
import { semanticResolve } from '../src/stages/semantic.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const noopResolver: ToolResolver = {
  resolve(_ref: string): ResolvedTool | null {
    return null
  },
  listAvailable: () => [],
}

const action = (id: string, toolRef: string): ActionNode => ({
  id,
  type: 'action',
  toolRef,
  input: {},
})

const sequence = (...nodes: FlowNode[]): SequenceNode => ({
  type: 'sequence',
  nodes,
})

// ---------------------------------------------------------------------------
// lowerCheckpointNode
// ---------------------------------------------------------------------------

describe('lowerCheckpointNode', () => {
  it('returns kind="checkpoint" with deps including captureOutputOf', () => {
    const node: CheckpointNode = {
      id: 'cp-1',
      type: 'checkpoint',
      label: 'after-login',
      captureOutputOf: 'login-action',
    }

    const out = lowerCheckpointNode(node)

    expect(out.kind).toBe('checkpoint')
    expect(out.captureOutputOf).toBe('login-action')
    expect(out.label).toBe('after-login')
    expect(out.deps).toEqual(['login-action'])
    expect(out.edges).toEqual([])
  })

  it('defaults label to nodeId when label is omitted', () => {
    const node: CheckpointNode = {
      id: 'cp-2',
      type: 'checkpoint',
      captureOutputOf: 'login-action',
    }

    const out = lowerCheckpointNode(node)

    expect(out.label).toBe('cp-2')
  })
})

// ---------------------------------------------------------------------------
// lowerRestoreNode
// ---------------------------------------------------------------------------

describe('lowerRestoreNode', () => {
  it('returns kind="restore" with default onNotFound="fail"', () => {
    const node: RestoreNode = {
      id: 'rs-1',
      type: 'restore',
      checkpointLabel: 'after-login',
    }

    const out = lowerRestoreNode(node)

    expect(out.kind).toBe('restore')
    expect(out.checkpointLabel).toBe('after-login')
    expect(out.onNotFound).toBe('fail')
    expect(out.deps).toEqual([])
    expect(out.edges).toEqual([])
  })

  it('preserves explicit onNotFound="skip"', () => {
    const node: RestoreNode = {
      id: 'rs-2',
      type: 'restore',
      checkpointLabel: 'after-login',
      onNotFound: 'skip',
    }

    const out = lowerRestoreNode(node)

    expect(out.onNotFound).toBe('skip')
  })
})

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

describe('semanticResolve — checkpoint/restore validation', () => {
  it('warns when checkpoint.captureOutputOf does not reference any earlier node', async () => {
    // The checkpoint references "future-action" which appears AFTER it in flow
    // order — a forward reference. Should surface as a non-fatal warning.
    const ast: FlowNode = sequence(
      action('first-action', 'pm.create_task'),
      {
        id: 'cp-fwd',
        type: 'checkpoint',
        label: 'fwd',
        captureOutputOf: 'future-action',
      } satisfies CheckpointNode,
      action('future-action', 'pm.update_task'),
    )

    const result = await semanticResolve(ast, { toolResolver: noopResolver })

    // Forward-ref warning is reported on the warnings channel, not errors.
    const fwdWarning = result.warnings.find((w) =>
      w.message.includes('future-action'),
    )
    expect(fwdWarning).toBeDefined()
    expect(fwdWarning?.code).toBe('MISSING_REQUIRED_FIELD')
    expect(fwdWarning?.nodeType).toBe('checkpoint')
  })

  it('errors when no checkpoint with the matching label exists for a restore node', async () => {
    const ast: FlowNode = sequence(
      action('first-action', 'pm.create_task'),
      {
        id: 'rs-missing',
        type: 'restore',
        checkpointLabel: 'never-declared',
      } satisfies RestoreNode,
    )

    const result = await semanticResolve(ast, { toolResolver: noopResolver })

    const restoreError = result.errors.find(
      (e) =>
        e.nodeType === 'restore' && e.message.includes('never-declared'),
    )
    expect(restoreError).toBeDefined()
    expect(restoreError?.code).toBe('MISSING_REQUIRED_FIELD')
  })
})
