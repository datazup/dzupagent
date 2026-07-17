import { describe, expect, it } from 'vitest'

import {
  buildCommandCatalog,
  buildSignedExecutionPolicy,
  createDefaultResourcePolicy,
  createEgressPolicy,
  sealIsolationReceipt,
  validateCommand,
  validateSignedExecutionPolicy,
  verifyIsolationReceipt,
  type HostCapabilities,
} from '../index.js'

const capabilities: HostCapabilities = {
  cgroupsV2: true,
  namespaces: true,
  ulimits: true,
  processGroups: true,
}

describe('execution contracts', () => {
  it('seals and validates a resource policy and command catalog', () => {
    const catalog = buildCommandCatalog([{ binary: 'yarn', allowedArgs: ['test'], workdirPolicy: 'checkout-only' }])
    const signed = buildSignedExecutionPolicy(
      createDefaultResourcePolicy({ policyId: 'execution-1', wallTimeSec: 60 }),
      catalog,
    )

    expect(validateSignedExecutionPolicy(signed)).toEqual({ valid: true, errors: [] })
    expect(validateCommand('yarn', ['test'], '/checkout', {}, catalog, '/checkout')).toEqual({ allowed: true })
    expect(validateCommand('bash', [], '/checkout', {}, catalog, '/checkout')).toMatchObject({
      allowed: false,
      reason: 'UNKNOWN_BINARY',
    })
  })

  it('keeps egress default-deny and seals sanitized isolation evidence', () => {
    const egress = createEgressPolicy([{ provider: 'codex', label: 'provider' }])
    expect(egress.checkAndRecord('codex', '2026-07-17T00:00:00.000Z')).toBe('allow')
    expect(egress.checkAndRecord('unknown', '2026-07-17T00:00:01.000Z')).toBe('deny')
    const receipt = sealIsolationReceipt({
      executionId: 'execution-1',
      policy: createDefaultResourcePolicy({ policyId: 'execution-1' }),
      hostCapabilities: capabilities,
      limitsApplied: ['process-groups'],
      limitsUnavailable: [],
      egressRecords: [...egress.getRecords()],
      forciblyTerminated: false,
      sessionStatePreserved: true,
      sealedAt: '2026-07-17T00:00:02.000Z',
    })

    expect(verifyIsolationReceipt(receipt)).toBe(true)
    expect(verifyIsolationReceipt({ ...receipt, forciblyTerminated: true })).toBe(false)
  })
})
