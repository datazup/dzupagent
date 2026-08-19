import { describe, expect, it, vi } from 'vitest'
import { InMemoryRunStore, type RunStatus } from '@dzupagent/core/persistence'

import {
  inspectHumanContactOperations,
  reconcileHumanContactOperations,
  type HumanContactOperationalObservation,
  type HumanContactOperationalMetric,
} from '../runtime/human-contact-operations.js'

const NOW = '2026-08-19T12:00:00.000Z'

function reservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'durable-human-contact-reservation-v1',
    contactId: 'contact-preparing',
    runId: 'bound-at-create',
    tenantId: 'tenant-operations',
    invocationId: 'invocation-operations',
    invocationDigest: 'digest-operations',
    requestType: 'approval',
    resumeTokenHash: 'digest-only',
    resumeTokenCiphertext: 'ciphertext-only',
    deliveryStatus: 'pending',
    lifecycleStatus: 'preparing',
    ...overrides,
  }
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'human-contact-receipt-v1',
    contactId: 'contact-publication',
    runId: 'bound-at-create',
    tenantId: 'tenant-operations',
    resumeTokenHash: 'digest-only',
    respondedAt: '2026-08-19T11:30:00.000Z',
    responseType: 'approval',
    publicationId: 'hc_pub_content_free',
    publicationStatus: 'pending',
    publicationClaimId: 'expired-publication-claim',
    publicationLeaseExpiresAt: NOW,
    ...overrides,
  }
}

async function createRun(
  store: InMemoryRunStore,
  status: RunStatus,
  metadata: Record<string, unknown>,
  tenantId = 'tenant-operations',
): Promise<string> {
  const run = await store.create({
    agentId: 'operations-agent',
    input: 'redacted',
    tenantId,
    metadata,
  })
  await store.update(run.id, { status })
  return run.id
}

describe('human-contact operational custody', () => {
  it('classifies without mutation and reconciles expired leases by exact CAS', async () => {
    const store = new InMemoryRunStore()
    const runId = await createRun(store, 'suspended', {
      durablePendingHumanContacts: [
        reservation({
          pauseLeaseId: 'expired-pause-claim',
          pauseLeaseExpiresAt: NOW,
        }),
        reservation({
          contactId: 'contact-active',
          pauseLeaseId: 'active-pause-claim',
          pauseLeaseExpiresAt: '2026-08-19T12:00:00.001Z',
        }),
        reservation({
          contactId: 'contact-expired',
          expiresAt: '2026-08-19T11:59:59.999Z',
        }),
        { kind: 'durable-human-contact-reservation-v1', secret: 'must-stay-unreported' },
      ],
      resolvedHumanContacts: [receipt()],
    })

    const inspected = await inspectHumanContactOperations(store, {
      now: NOW,
      limit: 10,
    })
    expect(inspected.changedRuns).toBe(0)
    expect(inspected.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contactId: 'contact-preparing',
        classification: 'reclaimable',
        subject: 'pause',
        action: 'none',
      }),
      expect.objectContaining({
        contactId: 'contact-publication',
        classification: 'reclaimable',
        subject: 'publication',
        action: 'none',
      }),
      expect.objectContaining({
        contactId: 'contact-expired',
        classification: 'expired',
        subject: 'contact',
        action: 'none',
      }),
      expect.objectContaining({
        classification: 'malformed',
        subject: 'reservation',
        action: 'none',
      }),
    ]))
    expect(JSON.stringify(inspected)).not.toContain('must-stay-unreported')
    expect(JSON.stringify((await store.get(runId))?.metadata))
      .toContain('expired-pause-claim')

    const alerts: HumanContactOperationalObservation[] = []
    const metrics: HumanContactOperationalMetric[] = []
    const reconciled = await reconcileHumanContactOperations(store, {
      now: NOW,
      limit: 10,
      sink: {
        onAlert: (alert) => { alerts.push(alert) },
        onMetric: (metric) => { metrics.push(metric) },
      },
    })
    expect(reconciled.changedRuns).toBe(1)
    expect(reconciled.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'pause', action: 'lease_released' }),
      expect.objectContaining({ subject: 'publication', action: 'lease_released' }),
      expect.objectContaining({ subject: 'contact', action: 'reported' }),
      expect.objectContaining({ subject: 'reservation', action: 'reported' }),
    ]))
    const metadata = (await store.get(runId))?.metadata as Record<string, unknown>
    const serialized = JSON.stringify(metadata)
    expect(serialized).not.toContain('expired-pause-claim')
    expect(serialized).not.toContain('expired-publication-claim')
    expect(serialized).toContain('active-pause-claim')
    expect(serialized).toContain('must-stay-unreported')
    expect(JSON.stringify(alerts)).not.toContain('must-stay-unreported')
    expect(JSON.stringify(metrics)).not.toContain(runId)
    expect(metrics.length).toBeGreaterThan(0)
    expect(metrics.every((metric) => metric.value === 1)).toBe(true)
  })

  it('removes terminal orphans and prunes only explicitly expired history', async () => {
    const store = new InMemoryRunStore()
    const runId = await createRun(store, 'completed', {
      durablePendingHumanContacts: [reservation()],
      pendingHumanContacts: [
        'contact-legacy',
        {
          kind: 'human-contact-binding-v1',
          contactId: 'contact-strict',
          runId: 'bound-at-create',
          tenantId: 'tenant-operations',
          resumeTokenHash: 'digest-only',
        },
      ],
      resolvedHumanContacts: [
        receipt({
          contactId: 'contact-old',
          runId: 'bound-at-create',
          respondedAt: '2026-08-19T09:59:59.999Z',
          publicationStatus: 'published',
        }),
        receipt({
          contactId: 'contact-recent',
          runId: 'bound-at-create',
          respondedAt: '2026-08-19T10:00:00.001Z',
          publicationStatus: 'published',
        }),
      ],
      humanContactResponse: {
        contactId: 'contact-old',
        respondedAt: '2026-08-19T09:00:00.000Z',
        sensitiveResponse: 'must-be-pruned-as-one-field',
      },
    })

    const result = await reconcileHumanContactOperations(store, {
      now: NOW,
      limit: 10,
      retentionMs: 2 * 60 * 60 * 1_000,
    })
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'terminal', action: 'removed' }),
      expect.objectContaining({
        contactId: 'contact-old',
        classification: 'retention_due',
        subject: 'receipt',
        action: 'pruned',
      }),
      expect.objectContaining({
        contactId: 'contact-old',
        classification: 'retention_due',
        subject: 'response',
        action: 'pruned',
      }),
    ]))
    const metadata = (await store.get(runId))?.metadata as Record<string, unknown>
    expect(metadata['durablePendingHumanContacts']).toEqual([])
    expect(metadata['pendingHumanContacts']).toEqual([])
    expect(metadata['humanContactResponse']).toBeUndefined()
    expect(JSON.stringify(metadata)).not.toContain('contact-old')
    expect(JSON.stringify(metadata)).not.toContain('must-be-pruned-as-one-field')
    expect(JSON.stringify(metadata)).toContain('contact-recent')
  })

  it('enforces finite scan bounds and tenant scope', async () => {
    const store = new InMemoryRunStore()
    await createRun(store, 'running', {}, 'tenant-a')
    await createRun(store, 'running', {}, 'tenant-a')
    await createRun(store, 'running', {}, 'tenant-b')

    const report = await inspectHumanContactOperations(store, {
      now: NOW,
      limit: 1,
      tenantId: 'tenant-a',
    })
    expect(report.scannedRuns).toBe(1)
    await expect(inspectHumanContactOperations(store, { now: NOW, limit: 0 }))
      .rejects.toThrow('HUMAN_CONTACT_OPERATION_LIMIT_INVALID')
    await expect(inspectHumanContactOperations(store, { now: NOW, limit: 1_001 }))
      .rejects.toThrow('HUMAN_CONTACT_OPERATION_LIMIT_INVALID')
  })

  it('retains response content while its publication receipt is pending', async () => {
    const store = new InMemoryRunStore()
    const runId = await createRun(store, 'running', {
      resolvedHumanContacts: [receipt({
        respondedAt: '2026-08-19T09:00:00.000Z',
      })],
      humanContactResponse: {
        contactId: 'contact-publication',
        respondedAt: '2026-08-19T09:00:00.000Z',
        sensitiveResponse: 'required-for-republication',
      },
    })

    await reconcileHumanContactOperations(store, {
      now: NOW,
      limit: 1,
      retentionMs: 60 * 60 * 1_000,
    })
    expect(JSON.stringify((await store.get(runId))?.metadata))
      .toContain('required-for-republication')
  })

  it('does not roll back reconciliation when content-free telemetry fails', async () => {
    const store = new InMemoryRunStore()
    const runId = await createRun(store, 'running', {
      durablePendingHumanContacts: [reservation({
        pauseLeaseId: 'expired-claim',
        pauseLeaseExpiresAt: NOW,
      })],
    })
    const onAlert = vi.fn(() => { throw new Error('telemetry unavailable') })

    const report = await reconcileHumanContactOperations(store, {
      now: NOW,
      limit: 1,
      sink: { onAlert },
    })
    expect(report.changedRuns).toBe(1)
    expect(report.telemetryFailures).toBeGreaterThan(0)
    expect(JSON.stringify((await store.get(runId))?.metadata))
      .not.toContain('expired-claim')
  })
})
