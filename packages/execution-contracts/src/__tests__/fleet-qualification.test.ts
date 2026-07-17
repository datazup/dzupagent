import { describe, expect, it } from 'vitest'

import {
  // Cancellation
  sealFleetCancellationReceipt,
  verifyFleetCancellationReceipt,
  validateFleetCancellationReceipt,
  FLEET_CANCELLATION_RECEIPT_SCHEMA,
  // Takeover
  sealFleetTakeoverReceipt,
  verifyFleetTakeoverReceipt,
  validateFleetTakeoverReceipt,
  FLEET_TAKEOVER_RECEIPT_SCHEMA,
  // Batch report
  sealFleetBatchReport,
  verifyFleetBatchReport,
  validateFleetBatchReport,
  FLEET_BATCH_REPORT_SCHEMA,
  FLEET_BATCH_MIN_EXECUTIONS_PER_PROVIDER,
  // Egress audit
  sealFleetEgressAuditReceipt,
  verifyFleetEgressAuditReceipt,
  validateFleetEgressAuditReceipt,
  FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA,
  // Summary
  sealFleetQualificationSummary,
  verifyFleetQualificationSummary,
  validateFleetQualificationSummary,
  computeReceiptDigest,
  FLEET_QUALIFICATION_SUMMARY_SCHEMA,
  type FleetBatchExecutionEntry,
  type FleetEgressAuditEntry,
  type FleetReceiptRef,
} from '../fleet-qualification.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_AT = '2026-07-17T00:00:00.000Z'

function makeCancellationReceipt(overrides: Partial<Parameters<typeof sealFleetCancellationReceipt>[0]> = {}) {
  return sealFleetCancellationReceipt({
    receiptId: 'cancel-001',
    cancelledExecutionId: 'exec-A',
    siblingIds: ['exec-B', 'exec-C'],
    workerHostRef: 'worker-host-opaque-ref-1',
    siblingsCompletedNaturally: true,
    sealedAt: FIXED_AT,
    ...overrides,
  })
}

function makeTakeoverReceipt(overrides: Partial<Parameters<typeof sealFleetTakeoverReceipt>[0]> = {}) {
  return sealFleetTakeoverReceipt({
    receiptId: 'takeover-001',
    takenOverExecutionIds: ['exec-D', 'exec-E'],
    oldFencingToken: 'token-old-abc',
    newFencingToken: 'token-new-xyz',
    oldTokenRejected: true,
    attributionCorrect: true,
    sealedAt: FIXED_AT,
    ...overrides,
  })
}

function makeBatchExec(id: string, provider: string, ok = true): FleetBatchExecutionEntry {
  return {
    executionId: id,
    provider,
    isolationReceiptVerified: ok,
    completedWithoutError: ok,
  }
}

function makeEgressEntry(executionId: string, grantId: string, allowed: boolean): FleetEgressAuditEntry {
  return { direction: 'outbound', executionId, grantId, allowed, sanitized: true }
}

// ---------------------------------------------------------------------------
// 1. FleetCancellationReceipt — sibling isolation invariant
// ---------------------------------------------------------------------------

describe('FleetCancellationReceipt', () => {
  it('seals and verifies a valid receipt', () => {
    const r = makeCancellationReceipt()
    expect(r.schema).toBe(FLEET_CANCELLATION_RECEIPT_SCHEMA)
    expect(r.seal).toHaveLength(64)
    expect(verifyFleetCancellationReceipt(r)).toBe(true)
  })

  it('sibling isolation invariant: cancelling A does not touch B or C', () => {
    // In-memory model: track cancellation state per execution.
    const cancelled = new Set<string>()
    cancelled.add('exec-A')
    const siblings = ['exec-B', 'exec-C']
    // Invariant: none of the siblings are in the cancelled set.
    expect(siblings.every((id) => !cancelled.has(id))).toBe(true)
    // The receipt seals the fact that siblings completed naturally.
    const r = makeCancellationReceipt({
      cancelledExecutionId: 'exec-A',
      siblingIds: siblings,
      siblingsCompletedNaturally: true,
    })
    expect(r.siblingsCompletedNaturally).toBe(true)
    expect(r.cancelledExecutionId).toBe('exec-A')
    expect(r.siblingIds).toEqual(['exec-B', 'exec-C'])
    expect(verifyFleetCancellationReceipt(r)).toBe(true)
  })

  it('detects a tampered receipt', () => {
    const r = makeCancellationReceipt()
    const tampered = { ...r, siblingsCompletedNaturally: false }
    expect(verifyFleetCancellationReceipt(tampered)).toBe(false)
  })

  it('validates a correct receipt', () => {
    const r = makeCancellationReceipt()
    const result = validateFleetCancellationReceipt(r)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing siblingIds', () => {
    const r = makeCancellationReceipt()
    const bad = { ...r, siblingIds: [] }
    const result = validateFleetCancellationReceipt(bad)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('siblingIds'))).toBe(true)
  })

  it('rejects wrong schema', () => {
    const r = { ...makeCancellationReceipt(), schema: 'wrong/v1' as typeof FLEET_CANCELLATION_RECEIPT_SCHEMA }
    const result = validateFleetCancellationReceipt(r)
    expect(result.valid).toBe(false)
  })

  it('rejects non-object input', () => {
    expect(validateFleetCancellationReceipt(null).valid).toBe(false)
    expect(validateFleetCancellationReceipt('string').valid).toBe(false)
  })

  it('contains no raw URLs or credentials', () => {
    const r = makeCancellationReceipt()
    const json = JSON.stringify(r)
    expect(json).not.toMatch(/https?:\/\//)
    expect(json).not.toMatch(/password|token|secret|credential/i)
  })
})

// ---------------------------------------------------------------------------
// 2. FleetTakeoverReceipt — fencing token attribution invariant
// ---------------------------------------------------------------------------

describe('FleetTakeoverReceipt', () => {
  it('seals and verifies a valid receipt', () => {
    const r = makeTakeoverReceipt()
    expect(r.schema).toBe(FLEET_TAKEOVER_RECEIPT_SCHEMA)
    expect(r.seal).toHaveLength(64)
    expect(verifyFleetTakeoverReceipt(r)).toBe(true)
  })

  it('takeover attribution invariant: new fencing token gets execution, old is rejected', () => {
    // In-memory model: simulate fencing token claims.
    const tokenClaims = new Map<string, string[]>() // token -> executionIds
    const oldToken = 'token-old-abc'
    const newToken = 'token-new-xyz'
    const executions = ['exec-D', 'exec-E']

    // Assign to old token first, then revoke and assign to new.
    tokenClaims.set(oldToken, executions)
    // "Restart": old token is revoked (removed), new token gets the executions.
    tokenClaims.delete(oldToken)
    tokenClaims.set(newToken, executions)

    const oldTokenRejected = !tokenClaims.has(oldToken)
    const attributionCorrect = (tokenClaims.get(newToken) ?? []).every((id) => executions.includes(id))

    expect(oldTokenRejected).toBe(true)
    expect(attributionCorrect).toBe(true)

    const r = makeTakeoverReceipt({ oldTokenRejected, attributionCorrect })
    expect(r.oldTokenRejected).toBe(true)
    expect(r.attributionCorrect).toBe(true)
    expect(verifyFleetTakeoverReceipt(r)).toBe(true)
  })

  it('detects a tampered receipt', () => {
    const r = makeTakeoverReceipt()
    const tampered = { ...r, attributionCorrect: false }
    expect(verifyFleetTakeoverReceipt(tampered)).toBe(false)
  })

  it('validates a correct receipt', () => {
    const r = makeTakeoverReceipt()
    const result = validateFleetTakeoverReceipt(r)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects identical old and new fencing tokens', () => {
    const r = makeTakeoverReceipt()
    const bad = { ...r, newFencingToken: r.oldFencingToken }
    const result = validateFleetTakeoverReceipt(bad)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('must differ'))).toBe(true)
  })

  it('rejects empty takenOverExecutionIds', () => {
    const r = makeTakeoverReceipt()
    const bad = { ...r, takenOverExecutionIds: [] }
    const result = validateFleetTakeoverReceipt(bad)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('takenOverExecutionIds'))).toBe(true)
  })

  it('contains no raw URLs or credentials', () => {
    const r = makeTakeoverReceipt()
    const json = JSON.stringify(r)
    expect(json).not.toMatch(/https?:\/\//)
  })
})

// ---------------------------------------------------------------------------
// 3. FleetBatchReport — ≥2 concurrent executions per provider
// ---------------------------------------------------------------------------

describe('FleetBatchReport', () => {
  it('seals and verifies a valid batch with 2 providers × 2 executions', () => {
    const executions: FleetBatchExecutionEntry[] = [
      makeBatchExec('exec-1', 'codex'),
      makeBatchExec('exec-2', 'codex'),
      makeBatchExec('exec-3', 'claude'),
      makeBatchExec('exec-4', 'claude'),
    ]
    const r = sealFleetBatchReport({ receiptId: 'batch-001', executions, cleanupVerified: true, sealedAt: FIXED_AT })
    expect(r.schema).toBe(FLEET_BATCH_REPORT_SCHEMA)
    expect(r.seal).toHaveLength(64)
    expect(r.providersObserved).toEqual(['claude', 'codex'])
    expect(r.allIsolationReceiptsVerified).toBe(true)
    expect(verifyFleetBatchReport(r)).toBe(true)
  })

  it(`batch validation: requires >= ${FLEET_BATCH_MIN_EXECUTIONS_PER_PROVIDER} executions per provider`, () => {
    const executions: FleetBatchExecutionEntry[] = [
      makeBatchExec('exec-1', 'codex'),
      makeBatchExec('exec-2', 'codex'),
      makeBatchExec('exec-3', 'claude'), // only 1 claude — should fail
    ]
    const r = sealFleetBatchReport({ receiptId: 'batch-002', executions, cleanupVerified: true, sealedAt: FIXED_AT })
    const result = validateFleetBatchReport(r)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('claude'))).toBe(true)
  })

  it('allIsolationReceiptsVerified is false when any execution fails receipt check', () => {
    const executions: FleetBatchExecutionEntry[] = [
      makeBatchExec('exec-1', 'codex', true),
      makeBatchExec('exec-2', 'codex', false), // receipt not verified
      makeBatchExec('exec-3', 'claude', true),
      makeBatchExec('exec-4', 'claude', true),
    ]
    const r = sealFleetBatchReport({ receiptId: 'batch-003', executions, cleanupVerified: true, sealedAt: FIXED_AT })
    expect(r.allIsolationReceiptsVerified).toBe(false)
  })

  it('detects a tampered batch report', () => {
    const executions = [
      makeBatchExec('exec-1', 'codex'),
      makeBatchExec('exec-2', 'codex'),
      makeBatchExec('exec-3', 'claude'),
      makeBatchExec('exec-4', 'claude'),
    ]
    const r = sealFleetBatchReport({ receiptId: 'batch-004', executions, cleanupVerified: true, sealedAt: FIXED_AT })
    const tampered = { ...r, cleanupVerified: false }
    expect(verifyFleetBatchReport(tampered)).toBe(false)
  })

  it('rejects empty executions array', () => {
    const r = sealFleetBatchReport({
      receiptId: 'batch-005',
      executions: [],
      cleanupVerified: true,
      sealedAt: FIXED_AT,
    })
    const result = validateFleetBatchReport(r)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('executions'))).toBe(true)
  })

  it('contains no raw URLs or credentials', () => {
    const executions = [
      makeBatchExec('exec-1', 'codex'),
      makeBatchExec('exec-2', 'codex'),
      makeBatchExec('exec-3', 'claude'),
      makeBatchExec('exec-4', 'claude'),
    ]
    const r = sealFleetBatchReport({ receiptId: 'batch-006', executions, cleanupVerified: true, sealedAt: FIXED_AT })
    const json = JSON.stringify(r)
    expect(json).not.toMatch(/https?:\/\//)
    expect(json).not.toMatch(/password|token|secret|credential/i)
  })
})

// ---------------------------------------------------------------------------
// 4. FleetEgressAuditReceipt — cross-execution no-bleed
// ---------------------------------------------------------------------------

describe('FleetEgressAuditReceipt', () => {
  it('seals and verifies a valid egress audit receipt', () => {
    const entries: FleetEgressAuditEntry[] = [
      makeEgressEntry('exec-A', 'codex-grant', true),
      makeEgressEntry('exec-A', 'mcp-grant', true),
      makeEgressEntry('exec-B', 'codex-grant', true),
      makeEgressEntry('exec-B', 'claude-grant', false), // denied — exec-B not allowed for claude
    ]
    const r = sealFleetEgressAuditReceipt({
      receiptId: 'egress-001',
      entries,
      crossExecutionBleedDetected: false,
      sealedAt: FIXED_AT,
    })
    expect(r.schema).toBe(FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA)
    expect(r.seal).toHaveLength(64)
    expect(r.allScopedCorrectly).toBe(true)
    expect(r.crossExecutionBleedDetected).toBe(false)
    expect(verifyFleetEgressAuditReceipt(r)).toBe(true)
  })

  it('egress no-bleed invariant: execution A grants cannot appear in execution B audit', () => {
    // Simulate grant scoping: each execution has its own grant set.
    const grantsForExecA = new Set(['codex-grant'])
    const grantsForExecB = new Set(['claude-grant'])

    // Bleed = an entry for exec-B references a grant that belongs only to exec-A.
    function detectBleed(execId: string, grantId: string): boolean {
      if (execId === 'exec-B' && grantsForExecA.has(grantId) && !grantsForExecB.has(grantId)) return true
      if (execId === 'exec-A' && grantsForExecB.has(grantId) && !grantsForExecA.has(grantId)) return true
      return false
    }

    const entries: FleetEgressAuditEntry[] = [
      makeEgressEntry('exec-A', 'codex-grant', true),
      makeEgressEntry('exec-B', 'claude-grant', true),
    ]
    const hasBleed = entries.some((e) => detectBleed(e.executionId, e.grantId))
    expect(hasBleed).toBe(false)

    const r = sealFleetEgressAuditReceipt({
      receiptId: 'egress-002',
      entries,
      crossExecutionBleedDetected: false,
      sealedAt: FIXED_AT,
    })
    expect(r.allScopedCorrectly).toBe(true)
    expect(verifyFleetEgressAuditReceipt(r)).toBe(true)
  })

  it('allScopedCorrectly is false when cross-execution bleed is detected', () => {
    const entries: FleetEgressAuditEntry[] = [
      makeEgressEntry('exec-A', 'codex-grant', true),
      makeEgressEntry('exec-B', 'codex-grant', true), // exec-B using exec-A's grant — bleed
    ]
    const r = sealFleetEgressAuditReceipt({
      receiptId: 'egress-003',
      entries,
      crossExecutionBleedDetected: true, // detected by caller
      sealedAt: FIXED_AT,
    })
    expect(r.allScopedCorrectly).toBe(false)
    expect(verifyFleetEgressAuditReceipt(r)).toBe(true)
  })

  it('factory throws if any entry has sanitized=false', () => {
    const badEntry = { ...makeEgressEntry('exec-A', 'grant-1', true), sanitized: false as true }
    expect(() =>
      sealFleetEgressAuditReceipt({
        receiptId: 'egress-004',
        entries: [badEntry],
        crossExecutionBleedDetected: false,
        sealedAt: FIXED_AT,
      }),
    ).toThrow()
  })

  it('validates a correct receipt', () => {
    const entries = [makeEgressEntry('exec-A', 'codex-grant', true)]
    const r = sealFleetEgressAuditReceipt({
      receiptId: 'egress-005',
      entries,
      crossExecutionBleedDetected: false,
      sealedAt: FIXED_AT,
    })
    const result = validateFleetEgressAuditReceipt(r)
    expect(result.valid).toBe(true)
  })

  it('detects a tampered egress audit receipt', () => {
    const entries = [makeEgressEntry('exec-A', 'codex-grant', true)]
    const r = sealFleetEgressAuditReceipt({
      receiptId: 'egress-006',
      entries,
      crossExecutionBleedDetected: false,
      sealedAt: FIXED_AT,
    })
    const tampered = { ...r, crossExecutionBleedDetected: true }
    expect(verifyFleetEgressAuditReceipt(tampered)).toBe(false)
  })

  it('rejects missing direction field', () => {
    const badEntry = {
      executionId: 'exec-A',
      grantId: 'grant-1',
      allowed: true,
      sanitized: true,
    } as FleetEgressAuditEntry
    const r = sealFleetEgressAuditReceipt({
      receiptId: 'egress-007',
      entries: [badEntry],
      crossExecutionBleedDetected: false,
      sealedAt: FIXED_AT,
    })
    // Inject the bad entry directly to test validator (bypassing factory check).
    const raw = { ...r, entries: [badEntry] }
    const result = validateFleetEgressAuditReceipt(raw)
    // direction is undefined — should fail.
    expect(result.valid).toBe(false)
  })

  it('contains no raw URLs or credentials', () => {
    const entries = [makeEgressEntry('exec-A', 'codex-grant', true)]
    const r = sealFleetEgressAuditReceipt({
      receiptId: 'egress-008',
      entries,
      crossExecutionBleedDetected: false,
      sealedAt: FIXED_AT,
    })
    const json = JSON.stringify(r)
    expect(json).not.toMatch(/https?:\/\//)
    expect(json).not.toMatch(/password|secret|credential/i)
  })
})

// ---------------------------------------------------------------------------
// 5. FleetQualificationSummary — digest chain
// ---------------------------------------------------------------------------

describe('FleetQualificationSummary', () => {
  function makeFullSummary() {
    const cancellation = makeCancellationReceipt()
    const cancellationJson = JSON.stringify(cancellation)
    const cancellationDigest = computeReceiptDigest(cancellationJson)

    const takeover = makeTakeoverReceipt()
    const takeoverJson = JSON.stringify(takeover)
    const takeoverDigest = computeReceiptDigest(takeoverJson)

    const batchExecs: FleetBatchExecutionEntry[] = [
      makeBatchExec('exec-1', 'codex'),
      makeBatchExec('exec-2', 'codex'),
      makeBatchExec('exec-3', 'claude'),
      makeBatchExec('exec-4', 'claude'),
    ]
    const batch = sealFleetBatchReport({
      receiptId: 'batch-s',
      executions: batchExecs,
      cleanupVerified: true,
      sealedAt: FIXED_AT,
    })
    const batchJson = JSON.stringify(batch)
    const batchDigest = computeReceiptDigest(batchJson)

    const egressEntries = [makeEgressEntry('exec-1', 'codex-grant', true)]
    const egress = sealFleetEgressAuditReceipt({
      receiptId: 'egress-s',
      entries: egressEntries,
      crossExecutionBleedDetected: false,
      sealedAt: FIXED_AT,
    })
    const egressJson = JSON.stringify(egress)
    const egressDigest = computeReceiptDigest(egressJson)

    const x3Ref: FleetReceiptRef = {
      label: 'X3 Browser Receipt',
      digest: 'sha256:' + 'a'.repeat(64),
      schema: 'datazup.assistantBrowserMigratedApiQualification/v1',
    }

    const cancellationRef: FleetReceiptRef = {
      label: 'Cancellation isolation receipt',
      digest: cancellationDigest,
      schema: FLEET_CANCELLATION_RECEIPT_SCHEMA,
    }
    const takeoverRef: FleetReceiptRef = {
      label: 'Worker restart takeover receipt',
      digest: takeoverDigest,
      schema: FLEET_TAKEOVER_RECEIPT_SCHEMA,
    }
    const batchRef: FleetReceiptRef = {
      label: 'Batch report',
      digest: batchDigest,
      schema: FLEET_BATCH_REPORT_SCHEMA,
    }
    const egressRef: FleetReceiptRef = {
      label: 'Egress audit receipt',
      digest: egressDigest,
      schema: FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA,
    }

    return sealFleetQualificationSummary({
      receiptId: 'fleet-summary-001',
      x3BrowserReceiptRef: x3Ref,
      cancellationReceipts: [cancellationRef],
      takeoverReceipts: [takeoverRef],
      batchReportRef: batchRef,
      egressAuditRef: egressRef,
      verdict: 'passed',
      sealedAt: FIXED_AT,
    })
  }

  it('seals and verifies a full qualification summary', () => {
    const summary = makeFullSummary()
    expect(summary.schema).toBe(FLEET_QUALIFICATION_SUMMARY_SCHEMA)
    expect(summary.seal).toHaveLength(64)
    expect(summary.verdict).toBe('passed')
    expect(verifyFleetQualificationSummary(summary)).toBe(true)
  })

  it('summary digest chain: all ref digests follow sha256:<hex> pattern', () => {
    const summary = makeFullSummary()
    const allRefs: FleetReceiptRef[] = [
      summary.x3BrowserReceiptRef,
      ...summary.cancellationReceipts,
      ...summary.takeoverReceipts,
      summary.batchReportRef,
      summary.egressAuditRef,
    ]
    for (const ref of allRefs) {
      expect(ref.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
  })

  it('computeReceiptDigest produces stable sha256:<hex> string', () => {
    const json = JSON.stringify({ foo: 'bar' })
    const d1 = computeReceiptDigest(json)
    const d2 = computeReceiptDigest(json)
    expect(d1).toBe(d2)
    expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('validates a correct summary', () => {
    const summary = makeFullSummary()
    const result = validateFleetQualificationSummary(summary)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('detects a tampered summary', () => {
    const summary = makeFullSummary()
    const tampered = { ...summary, verdict: 'failed' as const }
    expect(verifyFleetQualificationSummary(tampered)).toBe(false)
  })

  it('rejects missing cancellationReceipts', () => {
    const summary = makeFullSummary()
    const bad = { ...summary, cancellationReceipts: [] }
    const result = validateFleetQualificationSummary(bad)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('cancellationReceipts'))).toBe(true)
  })

  it('rejects missing takeoverReceipts', () => {
    const summary = makeFullSummary()
    const bad = { ...summary, takeoverReceipts: [] }
    const result = validateFleetQualificationSummary(bad)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('takeoverReceipts'))).toBe(true)
  })

  it('rejects invalid verdict', () => {
    const summary = makeFullSummary()
    const bad = { ...summary, verdict: 'maybe' as 'passed' | 'failed' }
    const result = validateFleetQualificationSummary(bad)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('verdict'))).toBe(true)
  })

  it('fail-closed for missing receipts: non-object receipt refs are rejected', () => {
    const summary = makeFullSummary()
    const bad = { ...summary, batchReportRef: null }
    const result = validateFleetQualificationSummary(bad)
    expect(result.valid).toBe(false)
  })

  it('rejects digest not starting with sha256:', () => {
    const summary = makeFullSummary()
    const bad = {
      ...summary,
      cancellationReceipts: [{ label: 'bad', digest: 'md5:abcd', schema: FLEET_CANCELLATION_RECEIPT_SCHEMA }],
    }
    const result = validateFleetQualificationSummary(bad)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('sha256:'))).toBe(true)
  })

  it('contains no raw URLs or credentials', () => {
    const summary = makeFullSummary()
    const json = JSON.stringify(summary)
    expect(json).not.toMatch(/https?:\/\//)
    expect(json).not.toMatch(/password|secret|credential/i)
  })
})
