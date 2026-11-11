import { describe, expect, it } from 'vitest'
import {
  CANCEL_REFUSED_TEXT, RECOVERY_REQUIRED_TEXT, cancelGuardRefuses, operationKeyFor, parseInspectAnswer,
  shouldProjectRecovery, type OperationView,
} from '../v1/recovery-port.js'

// A2A-M3-RECOVERY-20261111-R1 admission 972a4583. Pure logic only (the fake covers answer validation, projection and
// key format); every predicate that needs a database is proven by the real-Postgres suite.
const digest = `sha256:${'a'.repeat(64)}`
const op = (values: Partial<OperationView> = {}): OperationView => ({
  operationKey: 'a2a:v1:key', generation: 1, state: 'started', recoveryState: null, claimKind: null, bootId: 'boot-a', ...values,
})

describe('A2A M3a recovery: port answers, key format, projection and cancel guard (pure logic)', () => {
  it('R5 operation key matches the shipped pattern and differs per tenant, owner, task and generation', () => {
    const pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u
    const base = operationKeyFor('tenant-a', 'owner-a', 'task-a', 1)
    expect(base).toMatch(pattern)
    expect(base.endsWith(':1')).toBe(true)
    expect(operationKeyFor('tenant-a', 'owner-a', 'task-a', 1)).toBe(base)
    const others = [
      operationKeyFor('tenant-b', 'owner-a', 'task-a', 1), operationKeyFor('tenant-a', 'owner-b', 'task-a', 1),
      operationKeyFor('tenant-a', 'owner-a', 'task-b', 1), operationKeyFor('tenant-a', 'owner-a', 'task-a', 2),
    ]
    expect(new Set([base, ...others]).size).toBe(5)
    // The JSON tuple prevents delimiter collisions between the parts.
    expect(operationKeyFor('a', 'b:c', 'd', 1)).not.toBe(operationKeyFor('a:b', 'c', 'd', 1))
  })

  it.each([
    ['running with a valid receipt', { status: 'running', receiptRef: digest }, 'running'],
    ['not_applied with a valid receipt', { status: 'not_applied', receiptRef: digest }, 'not_applied'],
    ['terminal completed with text parts', { status: 'terminal', receiptRef: digest, terminal: { state: 'completed', parts: [{ text: 'done' }] } }, 'terminal'],
    ['terminal failed without parts', { status: 'terminal', receiptRef: digest, terminal: { state: 'failed' } }, 'terminal'],
  ])('R1 accepts %s', (_label, raw, status) => {
    expect(parseInspectAnswer(raw)?.status).toBe(status)
  })

  it.each([
    ['a missing receipt', { status: 'running' }],
    ['a receipt that is not a sha256 digest', { status: 'running', receiptRef: 'sha256:short' }],
    ['an uppercase digest', { status: 'running', receiptRef: `sha256:${'A'.repeat(64)}` }],
    ['an unknown status literal', { status: 'maybe', receiptRef: digest }],
    ['the retired stopped literal', { status: 'stopped', receiptRef: digest }],
    ['a terminal answer without a terminal object', { status: 'terminal', receiptRef: digest }],
    ['a terminal answer with a non-terminal state', { status: 'terminal', receiptRef: digest, terminal: { state: 'working' } }],
    ['a terminal answer with a canceled-era unknown state', { status: 'terminal', receiptRef: digest, terminal: { state: 'stopped' } }],
    ['non-text parts', { status: 'terminal', receiptRef: digest, terminal: { state: 'completed', parts: [{ data: { a: 1 } }] } }],
    ['empty parts', { status: 'terminal', receiptRef: digest, terminal: { state: 'completed', parts: [] } }],
    ['oversized parts', { status: 'terminal', receiptRef: digest, terminal: { state: 'completed', parts: [{ text: 'x'.repeat(1024 * 1024 + 1) }] } }],
    ['a null answer', null],
    ['a string answer', 'running'],
  ])('R1 treats %s as unknown', (_label, raw) => {
    expect(parseInspectAnswer(raw)).toBeUndefined()
  })

  it.each([
    ['recovery_required on a non-terminal task', op({ recoveryState: 'recovery_required' }), 'TASK_STATE_WORKING', true],
    ['a late-claimed recovering row', op({ recoveryState: 'recovering', claimKind: 'late' }), 'TASK_STATE_WORKING', true],
    ['a scan-recovering row (transient)', op({ recoveryState: 'recovering', claimKind: 'scan' }), 'TASK_STATE_WORKING', false],
    ['attached (a healthy recovered task)', op({ recoveryState: 'attached' }), 'TASK_STATE_WORKING', false],
    ['not_applied', op({ recoveryState: 'not_applied' }), 'TASK_STATE_WORKING', false],
    ['a resolved operation', op({ state: 'resolved', recoveryState: 'recovery_required' }), 'TASK_STATE_WORKING', false],
    ['a terminal task', op({ recoveryState: 'recovery_required' }), 'TASK_STATE_COMPLETED', false],
    ['no operation', undefined, 'TASK_STATE_WORKING', false],
  ])('R9 projection: %s', (_label, operation, taskState, expected) => {
    expect(shouldProjectRecovery(operation, taskState)).toBe(expected)
  })

  it('R7 the user-visible texts are fixed strings', () => {
    expect(RECOVERY_REQUIRED_TEXT).toBe('Recovery required; the operator is informed')
    expect(CANCEL_REFUSED_TEXT).toBe('Task cannot be canceled while recovery is pending')
  })

  it.each([
    ['attached', op({ recoveryState: 'attached' }), 'TASK_STATE_WORKING', 'boot-a', true],
    ['recovery_required', op({ recoveryState: 'recovery_required' }), 'TASK_STATE_WORKING', 'boot-a', true],
    ['recovering', op({ recoveryState: 'recovering', claimKind: 'scan' }), 'TASK_STATE_WORKING', 'boot-a', true],
    ['not_applied on the current boot', op({ recoveryState: 'not_applied' }), 'TASK_STATE_WORKING', 'boot-a', false],
    ['an unscanned other-boot WORKING orphan', op(), 'TASK_STATE_WORKING', 'boot-b', true],
    ['an unscanned other-boot SUBMITTED orphan', op(), 'TASK_STATE_SUBMITTED', 'boot-b', true],
    ['an other-boot INPUT_REQUIRED task (the scanner never touches it)', op(), 'TASK_STATE_INPUT_REQUIRED', 'boot-b', false],
    ['an other-boot AUTH_REQUIRED task', op(), 'TASK_STATE_AUTH_REQUIRED', 'boot-b', false],
    ['a same-boot live task', op(), 'TASK_STATE_WORKING', 'boot-a', false],
    ['an other-boot resolved operation', op({ state: 'resolved' }), 'TASK_STATE_WORKING', 'boot-b', false],
    ['a terminal task', op({ recoveryState: 'recovery_required' }), 'TASK_STATE_COMPLETED', 'boot-b', false],
    ['no operation row (M2 behaviour)', undefined, 'TASK_STATE_WORKING', 'boot-b', false],
  ])('R4 cancel guard: %s', (_label, operation, taskState, currentBoot, expected) => {
    expect(cancelGuardRefuses(operation, taskState, currentBoot)).toBe(expected)
  })
})
