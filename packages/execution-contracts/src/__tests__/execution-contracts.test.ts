import { describe, expect, it } from 'vitest'

import {
  UnsupportedEnforcementDriver,
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
    const catalog = buildCommandCatalog([
      { binary: 'yarn', allowedArgs: ['test'], workdirPolicy: 'checkout-only' },
    ])
    const signed = buildSignedExecutionPolicy(
      createDefaultResourcePolicy({ policyId: 'execution-1', wallTimeSec: 60 }),
      catalog,
    )

    expect(validateSignedExecutionPolicy(signed)).toEqual({
      valid: true,
      errors: [],
    })
    expect(
      validateCommand('yarn', ['test'], '/checkout', {}, catalog, '/checkout'),
    ).toEqual({ allowed: true })
    expect(
      validateCommand('bash', [], '/checkout', {}, catalog, '/checkout'),
    ).toMatchObject({
      allowed: false,
      reason: 'UNKNOWN_BINARY',
    })
  })

  it('keeps egress default-deny and seals sanitized isolation evidence', () => {
    const egress = createEgressPolicy([
      { provider: 'codex', label: 'provider' },
    ])
    expect(egress.checkAndRecord('codex', '2026-07-17T00:00:00.000Z')).toBe(
      'allow',
    )
    expect(egress.checkAndRecord('unknown', '2026-07-17T00:00:01.000Z')).toBe(
      'deny',
    )
    const catalog = buildCommandCatalog([
      { binary: 'yarn', allowedArgs: ['test'], workdirPolicy: 'checkout-only' },
    ])
    const signed = buildSignedExecutionPolicy(
      createDefaultResourcePolicy({ policyId: 'execution-1', wallTimeSec: 60 }),
      catalog,
    )
    const receipt = sealIsolationReceipt({
      executionId: 'execution-1',
      policy: createDefaultResourcePolicy({ policyId: 'execution-1' }),
      policySignature: signed.signature,
      catalogDigest: catalog.digest,
      hostCapabilities: capabilities,
      limitsApplied: ['process-groups'],
      limitsUnavailable: [],
      egressRecords: [...egress.getRecords()],
      forciblyTerminated: false,
      sessionStatePreserved: true,
      sealedAt: '2026-07-17T00:00:02.000Z',
    })

    expect(receipt.policySignature).toBe(signed.signature)
    expect(receipt.catalogDigest).toBe(catalog.digest)
    expect(verifyIsolationReceipt(receipt)).toBe(true)
    expect(
      verifyIsolationReceipt({ ...receipt, forciblyTerminated: true }),
    ).toBe(false)
    expect(
      verifyIsolationReceipt({ ...receipt, catalogDigest: 'invalid' }),
    ).toBe(false)
    expect(() =>
      sealIsolationReceipt({
        ...receipt,
        policy: createDefaultResourcePolicy({ policyId: receipt.policyId }),
        policySignature: '',
      }),
    ).toThrow('ISOLATION_RECEIPT_POLICY_SIGNATURE_INVALID')
  })
})

describe('UnsupportedEnforcementDriver', () => {
  const driver = new UnsupportedEnforcementDriver()
  const policy = createDefaultResourcePolicy({ policyId: 'test-1' })
  const caps: HostCapabilities = {
    cgroupsV2: false,
    namespaces: false,
    ulimits: false,
    processGroups: false,
  }

  it('apply() returns all 4 dimensions as unavailable', async () => {
    const results = await driver.apply({
      executionId: 'ex-1',
      policy,
      capabilities: caps,
    })
    expect(results).toHaveLength(4)
    for (const r of results) {
      expect(r.outcome).toBe('unavailable')
    }
  })

  it('release() returns all 4 dimensions as unavailable', async () => {
    const results = await driver.release({
      executionId: 'ex-1',
      forciblyTerminated: false,
    })
    expect(results).toHaveLength(4)
    for (const r of results) {
      expect(r.outcome).toBe('unavailable')
    }
  })

  it('never returns applied outcome on any dimension', async () => {
    const applyResults = await driver.apply({
      executionId: 'ex-1',
      policy,
      capabilities: caps,
    })
    const releaseResults = await driver.release({
      executionId: 'ex-1',
      forciblyTerminated: true,
    })
    for (const r of [...applyResults, ...releaseResults]) {
      expect(r.outcome).not.toBe('applied')
    }
  })

  it('each dimension name is a non-empty string', async () => {
    const applyResults = await driver.apply({
      executionId: 'ex-1',
      policy,
      capabilities: caps,
    })
    const releaseResults = await driver.release({
      executionId: 'ex-1',
      forciblyTerminated: false,
    })
    for (const r of [...applyResults, ...releaseResults]) {
      expect(typeof r.dimension).toBe('string')
      expect(r.dimension.length).toBeGreaterThan(0)
    }
  })
})
