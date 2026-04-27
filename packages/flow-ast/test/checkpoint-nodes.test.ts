import { describe, expect, it } from 'vitest'

import type { CheckpointNode, FlowNode, RestoreNode } from '../src/types.js'
import { flowNodeSchema, validateFlowNodeShape } from '../src/validate.js'

describe('checkpoint node validation', () => {
  it('accepts a checkpoint node with valid captureOutputOf', () => {
    const result = flowNodeSchema.safeParse({
      type: 'checkpoint',
      id: 'cp1',
      label: 'after login page verified',
      captureOutputOf: 'login-step',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('checkpoint')
      const cp = result.data as CheckpointNode
      expect(cp.captureOutputOf).toBe('login-step')
      expect(cp.label).toBe('after login page verified')
    }
  })

  it('accepts a checkpoint node without an optional label', () => {
    const result = flowNodeSchema.safeParse({
      type: 'checkpoint',
      id: 'cp_no_label',
      captureOutputOf: 'some-node',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a checkpoint node with empty captureOutputOf', () => {
    const issues = validateFlowNodeShape({
      type: 'checkpoint',
      id: 'cp_bad',
      captureOutputOf: '',
    })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]!.code).toBe('MISSING_REQUIRED_FIELD')
    expect(issues[0]!.nodePath).toContain('captureOutputOf')
  })

  it('rejects a checkpoint node with missing captureOutputOf', () => {
    const issues = validateFlowNodeShape({
      type: 'checkpoint',
      id: 'cp_bad',
    })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((i) => i.nodePath.includes('captureOutputOf'))).toBe(true)
  })

  it('rejects a checkpoint with a non-string label', () => {
    const issues = validateFlowNodeShape({
      type: 'checkpoint',
      id: 'cp_bad_label',
      captureOutputOf: 'node-x',
      label: 42,
    })
    expect(issues.some((i) => i.nodePath.includes('label'))).toBe(true)
  })
})

describe('restore node validation', () => {
  it('accepts a restore node with valid checkpointLabel', () => {
    const result = flowNodeSchema.safeParse({
      type: 'restore',
      id: 'r1',
      checkpointLabel: 'after login page verified',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('restore')
      const r = result.data as RestoreNode
      expect(r.checkpointLabel).toBe('after login page verified')
      expect(r.onNotFound).toBeUndefined()
    }
  })

  it('accepts a restore node with onNotFound="fail"', () => {
    const result = flowNodeSchema.safeParse({
      type: 'restore',
      id: 'r2',
      checkpointLabel: 'cp',
      onNotFound: 'fail',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const r = result.data as RestoreNode
      expect(r.onNotFound).toBe('fail')
    }
  })

  it('accepts a restore node with onNotFound="skip"', () => {
    const result = flowNodeSchema.safeParse({
      type: 'restore',
      id: 'r3',
      checkpointLabel: 'cp',
      onNotFound: 'skip',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const r = result.data as RestoreNode
      expect(r.onNotFound).toBe('skip')
    }
  })

  it('rejects a restore node with empty checkpointLabel', () => {
    const issues = validateFlowNodeShape({
      type: 'restore',
      id: 'r_bad',
      checkpointLabel: '',
    })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((i) => i.nodePath.includes('checkpointLabel'))).toBe(true)
  })

  it('rejects a restore node with missing checkpointLabel', () => {
    const issues = validateFlowNodeShape({
      type: 'restore',
      id: 'r_bad',
    })
    expect(issues.some((i) => i.nodePath.includes('checkpointLabel'))).toBe(true)
  })

  it('rejects a restore node with invalid onNotFound value', () => {
    const issues = validateFlowNodeShape({
      type: 'restore',
      id: 'r_bad_onf',
      checkpointLabel: 'cp',
      onNotFound: 'retry',
    })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((i) => i.nodePath.includes('onNotFound'))).toBe(true)
  })
})

describe('FlowNode union assignability — TypeScript satisfies', () => {
  it('accepts checkpoint and restore node types as FlowNode members', () => {
    const checkpoint = {
      type: 'checkpoint',
      id: 'cp_t',
      captureOutputOf: 'foo',
    } satisfies FlowNode

    const restore = {
      type: 'restore',
      id: 'r_t',
      checkpointLabel: 'cp_t',
      onNotFound: 'fail',
    } satisfies FlowNode

    // Use the values to ensure runtime branch isn't dead-code-eliminated
    expect(checkpoint.type).toBe('checkpoint')
    expect(restore.type).toBe('restore')
  })
})

describe('checkpoint and restore appear in known node-type set', () => {
  it('flowNodeSchema rejects unknown types but accepts checkpoint/restore', () => {
    // Sanity: an unknown type should be rejected
    const unknownIssues = validateFlowNodeShape({ type: 'definitely-not-real' })
    expect(unknownIssues.some((i) => i.message.includes('Unknown node type'))).toBe(true)

    // checkpoint should not produce an "Unknown node type" message
    const cpIssues = validateFlowNodeShape({
      type: 'checkpoint',
      id: 'cp',
      captureOutputOf: 'x',
    })
    expect(cpIssues.some((i) => i.message.includes('Unknown node type'))).toBe(false)

    // restore should not produce an "Unknown node type" message
    const rIssues = validateFlowNodeShape({
      type: 'restore',
      id: 'r',
      checkpointLabel: 'x',
    })
    expect(rIssues.some((i) => i.message.includes('Unknown node type'))).toBe(false)
  })
})
